/**
 * Dispatching agent factory: the single registered {@link AgentFactory} that
 * routes each session at creation — `acp:<name>` providers to the ACP factory,
 * everything else to the embedded built-in {@link AgentLoop}.
 *
 * The built-in loop is mounted under an isolated `agents` scope whose facade
 * forwards every registry call to the real service but captures `setFactory`,
 * because the registry accepts exactly one factory process-wide and the loop
 * registers itself in its constructor.
 * @module dsh-acp-agent-loop/dispatcher
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AcpAgentFactory } from './acp-factory.ts'
import { isAcpProvider } from './catalog.ts'

/** The slice of the default-model service the routing decision reads. */
interface AgentDefaultModelLike {
  currentSelection(): { provider?: string }
}

/**
 * Build the facade the embedded loop sees as `ctx.agents`: every read
 * forwards to the real registry service, but `setFactory` captures the loop
 * instead of registering it.
 * @param real - the real `AgentRegistry` service instance.
 * @param capture - receives the loop's factory instead of the registry.
 * @returns the proxied registry facade.
 */
export function agentsFacade(real: object, capture: (factory: AgentFactory) => void): object {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'setFactory') {
        return (factory: AgentFactory): (() => void) => {
          capture(factory)
          return () => {}
        }
      }
      // Refuse the Cordis tracer symbols (`cordis.original`, `cordis.shadow`,
      // …): forwarding them would let getTraceable canonicalize past this
      // facade to the real service, bypassing the setFactory capture.
      if (typeof property === 'symbol' && property.description?.startsWith('cordis.') === true) {
        return undefined
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** Routes create/resume between the embedded built-in loop and the ACP factory. */
export class DispatchingAgentFactory implements AgentFactory {
  private captured: PromiseWithResolvers<AgentFactory> = Promise.withResolvers<AgentFactory>()

  constructor(
    private readonly ctx: Context,
    private readonly acpFactory: AcpAgentFactory,
    /** The embedded loop plugin (the stock `AgentLoop`; tests substitute a fake). */
    loopPlugin: Parameters<Context['plugin']>[0],
    loopConfig: Record<string, unknown>,
  ) {
    this.captured.promise.catch(() => { /* resolved on capture; rejection unused */ })
    // Mount the stock loop under an isolated `agents` scope so its
    // constructor-time setFactory lands in our capture slot, not the registry.
    const realAgents = ctx.get('agents')
    if (realAgents === undefined) throw new Error('acp-agent-loop requires the agents service')
    const iso = ctx.isolate('agents')
    iso.provide('agents', agentsFacade(realAgents as object, (factory) => { this.captured.resolve(factory) }))
    iso.plugin(loopPlugin, loopConfig)
    ctx.effect(() => ctx.agents.setFactory(this), 'acpAgentLoop.setFactory()')
  }

  /** Whether the options select an ACP provider (explicit, else the live default). */
  private routesToAcp(provider: string | undefined): boolean {
    const resolved = provider
      ?? (this.ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined)?.currentSelection().provider
    return isAcpProvider(resolved)
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.routesToAcp(options.agentOptions?.provider)) {
      return this.acpFactory.createAgent(ownerCtx, this.withResolvedProvider(options))
    }
    return (await this.captured.promise).createAgent(ownerCtx, options)
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    if (this.routesToAcp(options.agentOptions?.provider)) {
      return this.acpFactory.resume(ownerCtx, this.withResolvedProvider(options))
    }
    return (await this.captured.promise).resume(ownerCtx, options)
  }

  /** Fill an absent provider from the live default so the ACP path sees its route. */
  private withResolvedProvider<T extends { agentOptions?: CreateAgentOptions['agentOptions'] }>(options: T): T {
    if (options.agentOptions?.provider !== undefined) return options
    const selection = (this.ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined)?.currentSelection()
    return {
      ...options,
      agentOptions: { ...options.agentOptions, ...selection },
    }
  }
}
