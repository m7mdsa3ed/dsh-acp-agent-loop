/**
 * ACP agent-loop plugin: replaces the harness's registered agent factory with
 * a dispatcher that routes `acp:<name>` sessions to external ACP agents while
 * embedding the stock loop for every other provider. Configured ACP agents
 * appear in the model picker via a catalog adapter.
 *
 * Install: disable the shipped `agent-loop` row and insert this plugin
 * (`cordis.patch.yml` ships both when installed as a profile bundle).
 * @module dsh-acp-agent-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { AcpAgentFactory } from './acp-factory.ts'
import { AcpCatalogAdapter } from './catalog.ts'
import { DispatchingAgentFactory } from './dispatcher.ts'
import type { AcpLoopConfig } from './types.ts'

export type { AcpAgentConfig, AcpLoopConfig, AcpModelConfig, AcpPermissionPolicy } from './types.ts'
export { AcpCatalogAdapter, acpProvider, isAcpProvider } from './catalog.ts'
export { DispatchingAgentFactory, agentsFacade } from './dispatcher.ts'
export { AcpAgentFactory } from './acp-factory.ts'
export { AcpLoopAgent } from './acp-agent.ts'
export { AcpSessionRun, disposeAcpChild } from './acp-run.ts'

/** Plugin name in the Cordis registry. */
export const name = 'acp-agent-loop'

/** Services this plugin requires before it loads. */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'subprocess']

/** Runtime configuration schema. */
export const Config = z.object({
  agents: z.array(z.object({
    name: z.string().required(),
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    env: z.dict(z.string()).default({}),
    cwd: z.string(),
    permission: z.union(['reject', 'allow']).default('reject'),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      efforts: z.array(z.string()),
      defaultEffort: z.string(),
    })).default([]),
    disposeEofGraceMs: z.number().min(1).default(6000),
    disposeGraceMs: z.number().min(1).default(3000),
  })).default([]),
  loop: z.object({}).default({}),
}) as z<AcpLoopConfig>

/**
 * Register the catalog adapter, the ACP factory, and the dispatching agent
 * factory (which mounts the embedded stock loop).
 * @param ctx - plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: AcpLoopConfig): void {
  const names = new Set<string>()
  for (const entry of config.agents) {
    if (names.has(entry.name)) throw new Error(`duplicate ACP agent name "${entry.name}"`)
    names.add(entry.name)
  }
  const catalog = new AcpCatalogAdapter(config.agents)
  if (catalog.providers.length > 0) {
    ctx.effect(() => ctx.llm.registerAdapter(catalog.providers, catalog), 'acpAgentLoop.catalog()')
  }
  const acpFactory = new AcpAgentFactory(ctx, config.agents)
  new DispatchingAgentFactory(ctx, acpFactory, AgentLoop, config.loop)
}
