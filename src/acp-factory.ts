/**
 * Creation/resume path for ACP-backed sessions: builds the session and the
 * {@link AcpLoopAgent}, publishes both through the shared registries in the
 * ordered lifecycle the harness expects, and owns teardown of the child
 * process with the agent.
 * @module dsh-acp-agent-loop/acp-factory
 */

import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import { AcpLoopAgent } from './acp-agent.ts'
import { AcpSessionRun } from './acp-run.ts'
import { acpProvider } from './catalog.ts'
import type { AcpAgentConfig } from './types.ts'

/** The slice of the persistence service the resume path needs. */
interface SessionPersistenceLike {
  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> | SessionPreparation
}

/** Creates and publishes ACP-backed agents for `acp:<name>` sessions. */
export class AcpAgentFactory {
  /** Live agent teardowns, disposed together with the plugin fiber. */
  private readonly liveAgents = new Set<() => Promise<void>>()

  constructor(private readonly ctx: Context, private readonly agents: readonly AcpAgentConfig[]) {
    ctx.effect(() => () => Promise.all([...this.liveAgents].map(dispose => dispose())).then(() => {}), 'acpAgentFactory.lifecycles()')
  }

  /** Resolve the configured agent entry a provider route names. */
  entryFor(provider: string): AcpAgentConfig {
    const entry = this.agents.find(candidate => acpProvider(candidate) === provider)
    if (entry === undefined) {
      throw new Error(`no ACP agent is configured for provider "${provider}" (configure it under the acp-agent-loop plugin's agents list)`)
    }
    return entry
  }

  /**
   * Create an ACP-backed agent on a caller-supplied session id.
   * @param ownerCtx - caller context that owns the lifecycle.
   * @param options - identities, session seed/metadata, agent options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }))
    return this.setupAndPublish(ownerCtx, options.sessionId, preparation, options.agentOptions ?? {}, options, 'startup')
  }

  /**
   * Resume an ACP-backed agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the lifecycle.
   * @param options - persisted identity, agent options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const preparation = await persistence.prepare(options.resumeSessionId, options.signal)
    return this.setupAndPublish(ownerCtx, options.resumeSessionId, preparation, options.agentOptions ?? {}, options, 'resume')
  }

  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    options: Pick<CreateAgentOptions, 'setup' | 'signal'>,
    source: SessionStartSource,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    const provider = agentOptions.provider ?? ''
    const entry = this.entryFor(provider)
    const loopCtx = this.ctx

    const run = new AcpSessionRun(entry, {
      cwd: entry.cwd ?? session.header.cwd ?? process.cwd(),
      spawn: spec => loopCtx.subprocess.spawn(spec),
      warn: (message) => { loopCtx.logger.warn(message) },
    })
    const reasoningEffort = this.effortFor(agentOptions)
    const agent = new AcpLoopAgent(loopCtx, id, agentOptions, session, run, reasoningEffort)

    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      try {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        await agent.scope.dispose()
        await run.dispose()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          this.liveAgents.delete(dispose)
        }
      }
    })())
    this.liveAgents.add(dispose)
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing !== undefined) return
      return dispose()
    }, `acpAgentLoop.lifecycle(${id})`)

    try {
      options.signal?.throwIfAborted()
      const setupCommit = await options.setup?.(agent.ctx)
      options.signal?.throwIfAborted()
      setupCommit?.commit()
      detachSession = loopCtx.sessions.enter(session)
      detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent)
      loopCtx.sessions.announce(session)
      loopCtx.agents.announce(agent)
      emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
      return {
        agent,
        dispose: async () => {
          await dispose()
          await unfollowOwner()
        },
      }
    } catch (error: unknown) {
      await dispose()
      await unfollowOwner()
      throw error
    }
  }

  /** The thought-level value forwarded to the child, when one applies. */
  private effortFor(agentOptions: AgentOptions & { reasoningEffort?: unknown }): string | undefined {
    return typeof agentOptions.reasoningEffort === 'string' ? agentOptions.reasoningEffort : undefined
  }
}
