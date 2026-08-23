# dsh-acp-agent-loop

A generic [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent loop for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as an out-of-tree plugin. It replaces the harness's registered agent factory with a **dispatcher**: sessions whose provider is `acp:<name>` are driven by an external ACP agent (Claude Code, Gemini CLI, any `{command, args, env}`), while every other session runs through the embedded stock agent loop unchanged.

Configured ACP agents appear as providers/models in the normal model picker, so starting a session with "Claude Code via ACP" is the same gesture as picking any model. Reasoning-effort picks map to the ACP agent's `thought_level` session config option.

## How it works

- **Dispatcher factory** (`src/dispatcher.ts`) — the harness accepts exactly one `AgentFactory` (`ctx.agents.setFactory` throws on a second registration), so the shipped `agent-loop` row is disabled and this plugin registers the dispatcher instead. The stock `AgentLoop` is mounted under a `ctx.isolate('agents')` scope whose facade forwards every registry call to the real service but **captures** the loop's constructor-time `setFactory`. The facade refuses `cordis.*` tracer symbols so canonicalization cannot bypass it.
- **Routing** — at `createAgent`/`resume`, the session's provider (explicit `agentOptions.provider`, else the live default-model selection) decides the path: `acp:*` → the ACP factory, anything else → the captured stock loop. Switching between the two loop kinds applies to **new sessions only**; a mid-session switch to an `acp:*` model fails the next step with a message saying so (the catalog adapter's `stream()` is that error).
- **ACP sessions** (`src/acp-agent.ts`, `src/acp-run.ts`) — one persistent child process per session (`spawn → initialize → session/new`), one harness turn per `session/prompt`. Streamed `agent_message_chunk`/`agent_thought_chunk` updates become standard `assistant/chunk` events; tool calls and plans surface as readable text lines inside the assistant stream; the turn closes with the mapped stop reason. The session log stays fully standard (`turn/start`, `step/start`, `user/message`, `assistant/message`, `request/header`, `turn/end`), so persistence, the web UI, titles, and telemetry work unchanged. On a harness resume with a fresh child, prior derived history is replayed as a recap prompt.
- **Model/effort selection** (`src/catalog.ts`) — a catalog-only `LlmAdapter` registers `acp:<name>` providers with the configured model/effort lists; at ACP session start the selection is applied best-effort via `session/set_config_option` (config options with category `model` / `thought_level`).
- **Permissions** — `session/request_permission` is auto-answered by the per-agent `permission` policy (`reject` default, `allow` picks the first allow option). Interactive prompting is deferred work.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-acp-agent-loop
```

The package ships a `dsh.bundle.patch` layer that disables the stock `agent-loop` row and inserts the dispatcher with a `claude-code` example entry (spawning `npx @zed-industries/claude-code-acp`; set `ANTHROPIC_API_KEY`). Override the `acp-agent-loop` row in your profile's `cordis.patch.yml` to configure your own agents — an id-targeted patch replaces the whole `config` block.

Uninstall: `dsh plugin --profile web remove dsh-acp-agent-loop` (the stock loop returns on next boot).

## Configuration

```yaml
- id: acp-agent-loop
  name: dsh-acp-agent-loop
  config:
    agents:
      - name: claude-code            # provider becomes acp:claude-code
        command: npx
        args: ['@zed-industries/claude-code-acp']
        env: { ANTHROPIC_API_KEY: !!js process.env.ANTHROPIC_API_KEY }
        permission: reject           # or allow
        # cwd: /some/workspace       # default: the session's cwd
        models:
          - id: default
            name: Claude Code (agent default)
          - id: claude-sonnet-4-5
            efforts: ['low', 'medium', 'high']
      - name: gemini
        command: gemini
        args: ['--experimental-acp']
        env: { GEMINI_API_KEY: !!js process.env.GEMINI_API_KEY }
    loop: {}                         # forwarded to the embedded stock agent-loop
```

| Key | Default | Meaning |
|---|---|---|
| `agents[].name` | required | Provider route suffix (`acp:<name>`). |
| `agents[].command` / `args` | required / `[]` | Child ACP agent to spawn per session. |
| `agents[].env` | `{}` | Explicit child env over the credential-scrubbed parent env. |
| `agents[].cwd` | session cwd | Working directory for the child and its ACP session. |
| `agents[].permission` | `reject` | Auto-answer for `session/request_permission`. |
| `agents[].models` | one `default` entry | Picker entries; ids should match the agent's model config option values. |
| `agents[].disposeEofGraceMs` / `disposeGraceMs` | 6000 / 3000 | Teardown ladder graces (EOF wait; SIGTERM→SIGKILL). |
| `loop` | `{}` | Config for the embedded stock `AgentLoop`. |

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test      # mock stdio ACP agent + real-registry composition tests
pnpm run build
```

Peer-pinned to harness `0.1.1-rc.2` (`@deepseek-ai/cordis` `4.0.1`). The harness is pre-release and reserves the right to break internals; re-pin and re-test per release.

## Known limitations and deferred work

- **New-sessions-only loop switching** — the loop kind is fixed at session creation; mid-session `acp:*` picks fail the next step with an explanatory error rather than being greyed out in the picker.
- **Tool calls render as text lines**, not the native tool UI (this build's session vocabulary has no ACP event types, and live appends cannot carry the `ignorable` marker).
- **No `agent/pre-step` / `agent/request` waterfalls on ACP sessions** — compaction, plan-mode context, and request-rewriting plugins no-op there; the remote agent owns its own context and tools.
- **Permission prompts are auto-answered**; routing `ask` through the harness approval seam is deferred.
- **Model/effort discovery is static config**; probing the agent's live `configOptions` for the catalog is deferred.
- **Resume replays a text recap** instead of `session/load`, even for agents that advertise `loadSession`.
- **No MCP passthrough** on `session/new` yet.
