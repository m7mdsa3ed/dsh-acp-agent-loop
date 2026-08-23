// Scripted ACP agent over stdio: answers initialize/session-new, then streams
// a thought chunk, a tool call, and message text for each session/prompt.
import { createInterface } from 'node:readline'

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => write({ jsonrpc: '2.0', method, params })

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  const reply = (result) => write({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: 1, agentCapabilities: {} })
      break
    case 'session/new':
      reply({
        sessionId: 'mock-session-1',
        configOptions: [
          {
            id: 'model', name: 'Model', type: 'select', category: 'model',
            currentValue: 'mock-1', options: [{ value: 'mock-1', name: 'Mock 1' }, { value: 'mock-2', name: 'Mock 2' }],
          },
        ],
      })
      break
    case 'session/set_config_option':
      reply({ configOptions: [] })
      break
    case 'session/prompt': {
      const sessionId = message.params.sessionId
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } } })
      notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read file', status: 'pending', kind: 'read' } })
      notify('session/update', { sessionUpdate: undefined, sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' } })
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from ' } } })
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the mock agent.' } } })
      reply({ stopReason: 'end_turn' })
      break
    }
    case 'session/cancel':
      break
    default:
      if (message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
      }
  }
})
rl.on('close', () => process.exit(0))
