/**
 * Configuration types for the ACP agent-loop plugin.
 * @module dsh-acp-agent-loop/types
 */

/** Auto-answer policy for a child agent's `session/request_permission`. */
export type AcpPermissionPolicy = 'allow' | 'reject'

/** One selectable model advertised for an ACP agent entry. */
export interface AcpModelConfig {
  /** Value the ACP agent's model config option accepts (or `default`). */
  id: string
  /** Human-readable name for the model picker; defaults to the id. */
  name?: string
  /** Reasoning-effort ids matching the agent's `thought_level` config option values. */
  efforts?: string[]
  /** Effort selected when the user picks none. */
  defaultEffort?: string
}

/** One external ACP agent this plugin can route sessions to. */
export interface AcpAgentConfig {
  /** Registry name; the provider route becomes `acp:<name>`. */
  name: string
  /** Executable spawned for each session's child process. */
  command: string
  /** Arguments passed to the command. */
  args: string[]
  /** Explicit child environment merged over the scrubbed parent environment. */
  env: Record<string, string>
  /** Working-directory override; defaults to the session's cwd, then the harness cwd. */
  cwd?: string
  /** Auto-answer policy for child permission prompts. */
  permission: AcpPermissionPolicy
  /** Models advertised in the picker; defaults to a single `default` entry. */
  models: AcpModelConfig[]
  /** Grace (ms) after stdin EOF before the terminate escalation on dispose. */
  disposeEofGraceMs: number
  /** POSIX grace (ms) between SIGTERM and SIGKILL on dispose. */
  disposeGraceMs: number
}

/** Plugin configuration. */
export interface AcpLoopConfig {
  /** External ACP agents to expose as `acp:<name>` providers. */
  agents: AcpAgentConfig[]
  /** Configuration forwarded verbatim to the embedded built-in agent loop. */
  loop: Record<string, unknown>
}
