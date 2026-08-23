/**
 * Agent driver whose model calls are turns of an external ACP agent. One
 * harness turn maps to one ACP `session/prompt`; the streamed updates are
 * logged as standard assistant chunks/messages so every downstream consumer
 * (persistence, web UI, titles, telemetry) works unchanged.
 * @module dsh-acp-agent-loop/acp-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createAssistantMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { ContentBlock as AcpContentBlock, StopReason } from '@agentclientprotocol/sdk'
import type { AcpSessionRun } from './acp-run.ts'
import { AcpUpdateStream } from './stream.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Extract the plain text of one harness message (non-text blocks are dropped). */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Render the messages of one step as ACP prompt blocks. */
function toAcpPrompt(messages: readonly UserMessage[], recap: string | undefined): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  if (recap !== undefined && recap.length > 0) blocks.push({ type: 'text', text: recap })
  for (const message of messages) {
    const text = messageText(message)
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  return blocks
}

/** Drives one session by delegating each turn to the external ACP agent. */
export class AcpLoopAgent implements Agent {
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private readonly dispatch: AgentEventDispatch
  private requestHeaderLogged = false
  /** Count of session-derived messages already delivered to the ACP child. */
  private deliveredThroughRecap = false

  constructor(
    private readonly loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    /** The persistent child run owned by this agent's lifecycle. */
    readonly run: AcpSessionRun,
    /** Reasoning-effort value forwarded to the agent's thought_level option. */
    private readonly reasoningEffort: string | undefined,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' ? 'idle' : 'running'
  }

  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    if (this.status !== previousStatus) this.dispatch.emit('agent/status', { status: this.status })
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    this.inbox.splice(wakingAfterAbort ? 'next-turn' : target, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    // No maintenance consumer targets ACP sessions today (compaction skips
    // them — the remote agent owns its context), but the Agent interface
    // requires the entry point; run the job under a plain abortable signal.
    const abort = new AbortController()
    const done = Promise.withResolvers<void>()
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(abort.signal)
      } finally {
        done.resolve()
      }
    })()
  }

  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && wakeAfterAbort) this.phase.wakeRequested = true
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const claimed = this.inbox.claim(target, turn)
        if (phase.step === 0 && claimed.length === 0) {
          // A wake whose message was cleared still owns the turn boundary but
          // spends no remote call.
          turnEnds = { kind: 'completed' }
          return false
        }
        if (turnEnds !== null && claimed.length === 0) break
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of claimed) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step(claimed, turn, step, signal)
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      turnEnds = { kind: 'error', error: { message: errorChain(error), code: 'UNKNOWN' } }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /** Provider/model config this agent's requests report. */
  private requestConfig(): { provider: string; model: string } {
    return { provider: this.options.provider ?? '', model: this.options.model ?? '' }
  }

  /** Log the request header and route context the UI and resume path read. */
  private logRequestHeader(): void {
    if (this.requestHeaderLogged) return
    const config = this.requestConfig()
    const header = canonicalHeader({ config })
    const baseline = this.session.requestHeader()
    this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
    const previous = this.session.requestContext()
    if (previous?.provider !== config.provider || previous.model !== config.model) {
      this.session.append('request/context', config)
    }
    this.requestHeaderLogged = true
  }

  /**
   * A recap of history the ACP child has not seen: on the first prompt of a
   * fresh child over a session that already has assistant/user history (a
   * harness resume), replay the derived transcript as context text.
   */
  private pendingRecap(claimed: readonly UserMessage[]): string | undefined {
    if (this.deliveredThroughRecap) return undefined
    this.deliveredThroughRecap = true
    const claimedIds = new Set(claimed.map(message => message.id))
    const prior = this.session.deriveMessages().filter(message => !claimedIds.has(message.id))
    if (prior.length === 0) return undefined
    const lines = prior.map((message) => {
      const text = message.content
        .map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '')
        .filter(part => part.length > 0)
        .join('\n')
      return text.length > 0 ? `${message.role}: ${text}` : undefined
    }).filter((line): line is string => line !== undefined)
    if (lines.length === 0) return undefined
    return `Conversation so far (replayed after a session resume):\n\n${lines.join('\n\n')}\n\nContinue from here.`
  }

  private async step(
    claimed: readonly UserMessage[],
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<TurnEndReason> {
    const config = this.requestConfig()
    const freshChild = !this.run.started
    await this.run.start(signal)
    if (freshChild) {
      await this.run.applySelection(this.options.model, this.reasoningEffort)
    }
    this.logRequestHeader()

    const assembler = new BlockAssembler()
    const chunkSeqs: number[] = []
    const emit = (chunk: StreamChunk): void => {
      chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
      assembler.push(chunk)
    }
    const stream = new AcpUpdateStream(emit)
    let stopReason: StopReason
    try {
      const result = await this.run.prompt(
        toAcpPrompt(claimed, this.pendingRecap(claimed)),
        update => { stream.push(update) },
        signal,
      )
      stopReason = result.stopReason
    } catch (error: unknown) {
      if (signal.aborted) {
        const content = assembler.interruptedBlocks()
        if (content.length > 0) {
          this.session.append('assistant/message', {
            turn,
            step,
            message: createAssistantMessage({ content, source: config }),
            interrupted: true,
          }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
        }
        throw error
      }
      stream.finish({ type: 'finish', reason: { kind: 'error', failure: { message: errorChain(error), code: 'ACP_TRANSPORT' } } })
      throw error
    }
    signal.throwIfAborted()

    if (stopReason === 'cancelled') {
      // The remote turn was cancelled without a local abort — treat as done.
      stream.finish({ type: 'finish', reason: { kind: 'stop' } })
    } else if (stopReason === 'max_tokens') {
      stream.finish({ type: 'finish', reason: { kind: 'max-tokens' } })
    } else {
      stream.finish({ type: 'finish', reason: { kind: 'stop' } })
    }

    const message = createAssistantMessage({ content: assembler.blocks(), source: config })
    this.session.append('assistant/message', {
      turn,
      step,
      message,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })

    switch (stopReason) {
      case 'max_tokens':
        return { kind: 'max-tokens' }
      case 'max_turn_requests':
        return { kind: 'error', error: { message: 'ACP agent hit its turn-request budget', code: 'ACP_TURN_BUDGET' } }
      default:
        return { kind: 'completed' }
    }
  }
}
