// Real-composition routing test: real Cordis context, real AgentRegistry and
// SessionStore, a fake embedded loop, and the scripted ACP child. Proves the
// facade captures the loop's setFactory, routing splits on the `acp:` prefix,
// and an ACP session logs standard turn/step/assistant events end to end.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentFactory, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpAgentFactory } from '../src/acp-factory.ts'
import { DispatchingAgentFactory } from '../src/dispatcher.ts'
import type { AcpAgentConfig } from '../src/types.ts'

const MOCK_AGENT = fileURLToPath(new URL('./fixtures/mock-acp-agent.mjs', import.meta.url))

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
    waitForExit: async () => done.then(() => true, () => true),
  }
}

const acpEntry: AcpAgentConfig = {
  name: 'mock',
  command: process.execPath,
  args: [MOCK_AGENT],
  env: {},
  permission: 'reject',
  models: [],
  disposeEofGraceMs: 2000,
  disposeGraceMs: 1000,
}

async function boot(): Promise<{ ctx: Context; builtinCalls: CreateAgentOptions[] }> {
  const root = new Context()
  await root.plugin(SessionStore)
  await root.plugin(AgentRegistry)
  root.provide('subprocess', { spawn: testSpawn })

  const builtinCalls: CreateAgentOptions[] = []
  const fakeBuiltinLoop: AgentFactory = {
    createAgent: (_ownerCtx, options) => {
      builtinCalls.push(options)
      return Promise.resolve({ agent: { id: options.sessionId }, dispose: () => Promise.resolve() } as unknown as AgentHandle)
    },
    resume: () => Promise.reject(new Error('not exercised')),
  }
  // The fake embedded loop registers itself the same way the stock one does.
  function fakeLoop(loopCtx: Context): void {
    loopCtx.effect(() => loopCtx.agents.setFactory(fakeBuiltinLoop), 'fakeLoop.setFactory()')
  }
  fakeLoop.inject = ['agents']
  const acpFactory = new AcpAgentFactory(root, [acpEntry])
  new DispatchingAgentFactory(root, acpFactory, fakeLoop, {})
  await new Promise(resolve => setTimeout(resolve, 20))
  return { ctx: root, builtinCalls }
}

describe('DispatchingAgentFactory', () => {
  it('routes non-ACP providers to the captured embedded loop', async () => {
    const { ctx, builtinCalls } = await boot()
    const handle = await ctx.agents.create({
      sessionId: SessionId('builtin-1'),
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4' },
    })
    expect(builtinCalls).toHaveLength(1)
    expect(builtinCalls[0]!.agentOptions?.provider).toBe('deepseek-official')
    await handle.dispose()
  })

  it('routes acp:* providers to a live ACP agent that logs a full turn', async () => {
    const { ctx, builtinCalls } = await boot()
    const handle = await ctx.agents.create({
      sessionId: SessionId('acp-1'),
      agentOptions: { provider: 'acp:mock', model: 'mock-2' },
    })
    try {
      const agent = handle.agent
      expect(agent.id).toBe('acp-1')
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'hello agent' }],
        source: { kind: 'user' },
      }))
      await new Promise(resolve => setTimeout(resolve, 50))
      await agent.whenIdle()

      const types = agent.session.events.map(event => event.type)
      expect(types).toContain('turn/start')
      expect(types).toContain('request/header')
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('turn/end')
      const assistant = agent.session.events.findLast(event => event.type === 'assistant/message')
      expect(JSON.stringify(assistant?.data)).toContain('Hello from the mock agent.')
      const header = agent.session.requestHeader()
      expect(header?.config.provider).toBe('acp:mock')
      expect(header?.config.model).toBe('mock-2')
      const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
      expect(turnEnd?.data.reason).toEqual({ kind: 'completed' })
      expect(builtinCalls).toHaveLength(0)
    } finally {
      await handle.dispose()
    }
  }, 20000)
})
