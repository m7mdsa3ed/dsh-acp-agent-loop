import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpSessionRun, type AcpUpdate } from '../src/acp-run.ts'
import { AcpUpdateStream } from '../src/stream.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AcpAgentConfig } from '../src/types.ts'

const MOCK_AGENT = fileURLToPath(new URL('./fixtures/mock-acp-agent.mjs', import.meta.url))

/** Minimal SubprocessHandle over node:child_process for tests. */
function testSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
  })
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  done.catch(() => {})
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: undefined,
    collected: {} as SubprocessHandle['collected'],
    done,
    terminate: () => { child.kill('SIGKILL') },
    waitForExit: async (signal?: AbortSignal) => {
      const settled = done.then(() => true, () => true)
      if (signal === undefined) return settled
      return Promise.race([
        settled,
        new Promise<boolean>((resolve) => { signal.addEventListener('abort', () => { resolve(false) }, { once: true }) }),
      ])
    },
  }
}

function entry(): AcpAgentConfig {
  return {
    name: 'mock',
    command: process.execPath,
    args: [MOCK_AGENT],
    env: {},
    permission: 'reject',
    models: [],
    disposeEofGraceMs: 2000,
    disposeGraceMs: 1000,
  }
}

describe('AcpSessionRun', () => {
  it('starts, applies selection, prompts, streams updates, and disposes', async () => {
    const warnings: string[] = []
    const run = new AcpSessionRun(entry(), {
      cwd: process.cwd(),
      spawn: testSpawn,
      warn: (message) => { warnings.push(message) },
    })
    try {
      await run.start()
      expect(run.started).toBe(true)
      expect(run.configState.modelConfigId).toBe('model')
      await run.applySelection('mock-2', undefined)

      const updates: AcpUpdate[] = []
      const result = await run.prompt(
        [{ type: 'text', text: 'hi' }],
        update => { updates.push(update) },
        new AbortController().signal,
      )
      expect(result.stopReason).toBe('end_turn')
      const kinds = updates.map(update => update.sessionUpdate)
      expect(kinds).toContain('agent_thought_chunk')
      expect(kinds).toContain('agent_message_chunk')
      expect(warnings).toEqual([])
    } finally {
      await run.dispose()
    }
    expect(run.started).toBe(false)
  }, 15000)

  it('translates the update stream into framed harness chunks', async () => {
    const run = new AcpSessionRun(entry(), { cwd: process.cwd(), spawn: testSpawn, warn: () => {} })
    const chunks: StreamChunk[] = []
    const stream = new AcpUpdateStream((chunk) => { chunks.push(chunk) })
    try {
      await run.start()
      await run.prompt([{ type: 'text', text: 'hi' }], update => { stream.push(update) }, new AbortController().signal)
      stream.finish({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      await run.dispose()
    }
    const types = chunks.map(chunk => chunk.type)
    // reasoning block, then a text block carrying tool lines + message text, then finish
    expect(types[0]).toBe('block-start')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('text-delta')
    expect(types.at(-1)).toBe('finish')
    const text = chunks
      .filter((chunk): chunk is StreamChunk & { type: 'text-delta' } => chunk.type === 'text-delta')
      .map(chunk => chunk.text).join('')
    expect(text).toContain('[tool] read file — pending')
    expect(text).toContain('[tool] read file — completed')
    expect(text).toContain('Hello from the mock agent.')
    // block-end blocks carry the assembled text
    const ends = chunks.filter((chunk): chunk is StreamChunk & { type: 'block-end' } => chunk.type === 'block-end')
    expect(ends.some(chunk => chunk.block.type === 'reasoning')).toBe(true)
  }, 15000)
})
