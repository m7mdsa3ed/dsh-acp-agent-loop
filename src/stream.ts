/**
 * Translate one ACP prompt turn's `session/update` stream into the harness
 * `StreamChunk` vocabulary with correct block framing, so the built-in
 * assembler, session log, and web UI consume ACP output like any model stream.
 * @module dsh-acp-agent-loop/stream
 */

import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { acpContentText, type AcpUpdate } from './acp-run.ts'

type OpenBlock = { index: number; kind: 'text' | 'reasoning'; text: string }

/**
 * Stateful chunk emitter for one step. `push()` folds one ACP update into
 * zero or more chunks; `finish()` closes the open block and emits the
 * terminal chunks. Tool calls and plans surface as readable text lines inside
 * the assistant text stream (standard events only — this build's session
 * vocabulary has no ACP-specific event types).
 */
export class AcpUpdateStream {
  private nextIndex = 0
  private open: OpenBlock | undefined
  /** Announced tool calls: last reported status and title, keyed by tool-call id. */
  private announcedTools = new Map<string, { status: string; title: string | undefined }>()
  private usage: TokenUsage | undefined

  constructor(private readonly emit: (chunk: StreamChunk) => void) {}

  private closeOpen(): void {
    const open = this.open
    if (open === undefined) return
    this.open = undefined
    this.emit({ type: 'block-end', index: open.index, block: { type: open.kind, text: open.text } })
  }

  private pushText(kind: 'text' | 'reasoning', text: string): void {
    if (text.length === 0) return
    if (this.open !== undefined && this.open.kind !== kind) this.closeOpen()
    if (this.open === undefined) {
      this.open = { index: this.nextIndex++, kind, text: '' }
      this.emit({ type: 'block-start', index: this.open.index, blockType: kind })
    }
    this.open.text += text
    this.emit(kind === 'text'
      ? { type: 'text-delta', index: this.open.index, text }
      : { type: 'reasoning-delta', index: this.open.index, text })
  }

  /** Fold one streamed ACP update into harness chunks. */
  push(update: AcpUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.pushText('text', acpContentText(update.content))
        return
      case 'agent_thought_chunk':
        this.pushText('reasoning', acpContentText(update.content))
        return
      case 'tool_call':
      case 'tool_call_update': {
        const id = update.toolCallId
        const previous = this.announcedTools.get(id)
        const title = update.title ?? previous?.title
        const status = update.status ?? 'pending'
        if (previous?.status === status) return
        this.announcedTools.set(id, { status, title })
        const label = title !== undefined && title.length > 0 ? title : id
        this.pushText('text', `\n[tool] ${label} — ${status}\n`)
        return
      }
      case 'plan': {
        const lines = update.entries.map(entry => `- [${entry.status}] ${entry.content}`)
        if (lines.length > 0) this.pushText('text', `\n[plan]\n${lines.join('\n')}\n`)
        return
      }
      default:
        // usage_update, mode/config changes, user_message_chunk replays, and
        // future variants carry no assistant content for this step.
    }
  }

  /**
   * Close the open block and emit usage plus the terminal finish chunk.
   * @param reason - the harness finish reason for this step.
   */
  finish(reason: StreamChunk & { type: 'finish' }): void {
    this.closeOpen()
    if (this.usage !== undefined) this.emit({ type: 'usage', usage: this.usage })
    this.emit(reason)
  }
}
