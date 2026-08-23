/**
 * Catalog-only LLM adapter for `acp:<name>` providers: makes ACP agents and
 * their models/efforts selectable in the existing model picker. Execution
 * never flows through it for ACP sessions — the dispatcher routes those to
 * the ACP loop at session creation — so `stream()` explains the
 * new-sessions-only rule instead of serving a model call.
 * @module dsh-acp-agent-loop/catalog
 */

import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AcpAgentConfig, AcpModelConfig } from './types.ts'

/** Provider route for one configured ACP agent entry. */
export function acpProvider(entry: Pick<AcpAgentConfig, 'name'>): string {
  return `acp:${entry.name}`
}

/** Whether a provider route names an ACP agent. */
export function isAcpProvider(provider: string | undefined): provider is string {
  return provider !== undefined && provider.startsWith('acp:')
}

/** The models one entry advertises, defaulting to a single `default` row. */
function modelsOf(entry: AcpAgentConfig): AcpModelConfig[] {
  return entry.models.length > 0 ? entry.models : [{ id: 'default', name: `${entry.name} (agent default)` }]
}

/** Catalog adapter serving picker metadata for every configured ACP agent. */
export class AcpCatalogAdapter extends LlmAdapter {
  private readonly entries = new Map<string, AcpAgentConfig>()

  constructor(agents: readonly AcpAgentConfig[]) {
    super()
    for (const entry of agents) this.entries.set(acpProvider(entry), entry)
  }

  /** Every provider route this adapter should register. */
  get providers(): string[] {
    return [...this.entries.keys()]
  }

  private entryFor(provider: string): AcpAgentConfig {
    const entry = this.entries.get(provider)
    if (entry === undefined) throw new Error(`unknown ACP provider "${provider}"`)
    return entry
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const entry = this.entryFor(provider)
    return { id: provider, name: `ACP: ${entry.name}` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = this.entryFor(provider)
    return Promise.resolve(modelsOf(entry).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.entryFor(provider)
    const configured = modelsOf(entry).find(candidate => candidate.id === model)
    const efforts = configured?.efforts ?? []
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      ...efforts.length === 0 ? {} : {
        reasoning: {
          efforts: efforts.map(effort => ({ id: effort as ReasoningEffortId, name: effort })),
          ...configured?.defaultEffort === undefined ? {} : { defaultEffort: configured.defaultEffort as ReasoningEffortId },
        },
      },
    })
  }

  // oxlint-disable-next-line require-yield -- the throw is the contract: ACP routes never stream here.
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error(
      `ACP models apply to new sessions — start a new session to use ${options.provider}/${options.model}`,
    )
  }
}
