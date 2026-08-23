/**
 * One persistent ACP child process serving one harness session: spawn,
 * initialize, session/new, per-turn prompts, cancellation, and quiescent
 * disposal.
 * @module dsh-acp-agent-loop/acp-run
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock as AcpContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { AcpAgentConfig } from './types.ts'

/** One streamed `session/update` payload delivered to the active prompt. */
export type AcpUpdate = SessionNotification['update']

/** Facts the run needs beyond the static agent entry. */
export interface AcpRunOptions {
  /** Working directory for the child process and its ACP session. */
  cwd: string
  /** Spawn function from the subprocess seam (`ctx.subprocess.spawn`). */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for contained child failures. */
  warn: (message: string) => void
}

/** Result of one ACP prompt turn. */
export interface AcpPromptResult {
  stopReason: StopReason
}

/** Session config option state the run captured at session start. */
export interface AcpConfigOptionState {
  /** Config id of the `model`-category select option, when the agent exposes one. */
  modelConfigId?: string
  /** Config id of the `thought_level`-category select option, when exposed. */
  thoughtConfigId?: string
}

/** Wait until the tree exits or `ms` elapses. */
async function treeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cooperative teardown ladder: stdin EOF, an EOF grace, then the terminate
 * escalation and its whole-tree exit proof.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - window after stdin EOF before termination escalates.
 */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.stdin?.end()
  if (await treeExitsWithin(child, eofGraceMs)) return
  child.terminate()
  await child.waitForExit()
}

/** Collect the text of an ACP content block (non-text blocks contribute nothing). */
export function acpContentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** Normalize an unknown thrown value to an Error. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * One persistent ACP child for one harness session. `start()` performs
 * spawn → initialize → session/new; `prompt()` runs one turn, streaming
 * updates to the caller; `dispose()` cancels and reaps the subprocess.
 */
export class AcpSessionRun {
  private child: SubprocessHandle | undefined
  private conn: ClientSideConnection | undefined
  private acpSessionId: string | undefined
  private onUpdate: ((update: AcpUpdate) => void) | undefined
  private disposal: Promise<void> | undefined
  private spawnFailed: Promise<never> | undefined
  /** Config-option ids discovered at session start. */
  readonly configState: AcpConfigOptionState = {}

  constructor(
    private readonly entry: AcpAgentConfig,
    private readonly options: AcpRunOptions,
  ) {}

  /** Whether a live ACP session exists (start completed, not disposed). */
  get started(): boolean {
    return this.acpSessionId !== undefined && this.disposal === undefined
  }

  /**
   * Spawn the child and establish its ACP session. Idempotent once started.
   * @param signal - aborts the wait (the child is reaped on failure).
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.started) return
    if (this.disposal !== undefined) throw new Error('ACP run is disposed')
    const child = this.child = this.options.spawn({
      argv: [this.entry.command, ...this.entry.args],
      cwd: this.options.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.entry.disposeGraceMs,
      env: this.entry.env,
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('dsh-acp-agent-loop: subprocess implementation dropped a piped protocol stream')
    }
    // Spawn-level failure rejects `done`; a clean exit parks forever so it can
    // never win a startup or prompt race as a success.
    const spawnFailed: Promise<never> = child.done.then(
      () => new Promise<never>(() => {}),
      (err: unknown) => Promise.reject(toError(err)),
    )
    spawnFailed.catch(() => { /* observed by the races below; never unhandled */ })
    this.spawnFailed = spawnFailed

    const entry = this.entry
    const warn = this.options.warn
    const run = this
    const client: Client = {
      sessionUpdate(params: SessionNotification): Promise<void> {
        run.onUpdate?.(params.update)
        return Promise.resolve()
      },
      requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        if (entry.permission === 'allow') {
          const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
          if (allow !== undefined) {
            return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
          }
        }
        warn(`acp:${entry.name}: auto-rejected permission request "${params.toolCall.title ?? ''}"`)
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
    }
    const conn = this.conn = new ClientSideConnection(
      () => client,
      ndJsonStream(
        NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )
    try {
      await this.race((async () => {
        await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        const session = await conn.newSession({ cwd: this.options.cwd, mcpServers: [] })
        this.acpSessionId = session.sessionId
        this.captureConfigOptions((session as { configOptions?: unknown }).configOptions)
      })(), signal)
    } catch (error: unknown) {
      await this.dispose()
      throw toError(error)
    }
  }

  /** Record the model / thought_level config-option ids the agent exposed. */
  private captureConfigOptions(configOptions: unknown): void {
    if (!Array.isArray(configOptions)) return
    for (const option of configOptions as Array<{ id?: unknown; type?: unknown; category?: unknown }>) {
      if (option.type !== 'select' || typeof option.id !== 'string') continue
      if (option.category === 'model') this.configState.modelConfigId = option.id
      if (option.category === 'thought_level') this.configState.thoughtConfigId = option.id
    }
  }

  /**
   * Best-effort selection of the agent-side model and thought level via
   * `session/set_config_option`. A rejection is contained and warned — the
   * agent then runs on its own defaults.
   * @param model - selected model id, or undefined/`default` to keep the agent's default.
   * @param effort - selected thought-level value, when any.
   */
  async applySelection(model: string | undefined, effort: string | undefined): Promise<void> {
    const conn = this.conn
    const sessionId = this.acpSessionId
    if (conn === undefined || sessionId === undefined) return
    const apply = async (configId: string | undefined, value: string | undefined, label: string): Promise<void> => {
      if (configId === undefined || value === undefined) return
      try {
        await conn.setSessionConfigOption({ sessionId, configId, value })
      } catch (error: unknown) {
        this.options.warn(`acp:${this.entry.name}: could not set ${label} "${value}": ${toError(error).message}`)
      }
    }
    await apply(this.configState.modelConfigId, model === 'default' ? undefined : model, 'model')
    await apply(this.configState.thoughtConfigId, effort, 'thought level')
  }

  /**
   * Run one prompt turn, streaming `session/update` payloads to `onUpdate`.
   * @param prompt - ACP content blocks for this turn.
   * @param onUpdate - receiver for streamed updates until the prompt settles.
   * @param signal - cancels the turn (`session/cancel`, then local settlement).
   * @returns the terminal stop reason.
   */
  async prompt(
    prompt: AcpContentBlock[],
    onUpdate: (update: AcpUpdate) => void,
    signal: AbortSignal,
  ): Promise<AcpPromptResult> {
    const conn = this.conn
    const sessionId = this.acpSessionId
    if (conn === undefined || sessionId === undefined) throw new Error('ACP run is not started')
    this.onUpdate = onUpdate
    const onAbort = (): void => {
      void conn.cancel({ sessionId }).catch(() => { /* child gone / no session */ })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.race(conn.prompt({ sessionId, prompt }), signal)
      return { stopReason: result.stopReason }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.onUpdate = undefined
    }
  }

  /** Race an ACP call against spawn failure and the caller's abort signal. */
  private async race<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    const races: Array<Promise<T>> = [operation]
    if (this.spawnFailed !== undefined) races.push(this.spawnFailed)
    if (signal !== undefined) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('ACP call aborted')
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('ACP call aborted'))
        }, { once: true })
      })
      aborted.catch(() => { /* observed by the race */ })
      races.push(aborted)
    }
    return Promise.race(races)
  }

  /** Cancel, close, and reap the child. Idempotent. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    const child = this.child
    this.acpSessionId = undefined
    this.disposal = child === undefined
      ? Promise.resolve()
      : disposeAcpChild(child, this.entry.disposeEofGraceMs)
    return this.disposal
  }
}
