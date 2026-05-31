import {
  type CapabilityCatalog,
  type CapabilityCatalogItem,
  type CapabilityDefinition,
  toCapabilityToolName,
} from './Capability.js'

export class InMemoryCapabilityCatalog implements CapabilityCatalog {
  private readonly items: CapabilityCatalogItem[]
  private readonly definitions = new Map<string, CapabilityDefinition>()

  constructor(definitions: CapabilityDefinition[]) {
    this.items = definitions.map(definition => {
      this.definitions.set(definition.id, definition)
      return {
        id: definition.id,
        toolName: toCapabilityToolName(definition),
        kind: definition.kind,
        title: definition.title,
        description: definition.description,
        availability: definition.availability ?? 'discoverable',
        tags: [...definition.tags],
        searchHints: [...definition.searchHints],
        preferredRoute: definition.preferredRoute,
        riskLevel: definition.riskLevel,
        inputSchema: definition.inputSchema,
        retryPolicy: normalizeRetryPolicy(definition.retryPolicy),
        examples: [...(definition.examples ?? [])],
        fallbacks: [...(definition.fallbacks ?? [])],
      }
    })
  }

  list(): CapabilityCatalogItem[] {
    return [...this.items]
  }

  get(id: string): CapabilityCatalogItem | undefined {
    return this.items.find(item => item.id === id)
  }

  getDefinition(id: string): CapabilityDefinition | undefined {
    return this.definitions.get(id)
  }

  search(query: string, limit = 5): CapabilityCatalogItem[] {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return this.list().slice(0, limit)
    }

    const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
    return this.items
      .map(item => ({
        item,
        score: scoreCapability(item, normalizedQuery, tokens),
      }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }
        return left.item.toolName.localeCompare(right.item.toolName)
      })
      .slice(0, limit)
      .map(candidate => candidate.item)
  }
}

function scoreCapability(
  capability: CapabilityCatalogItem,
  normalizedQuery: string,
  tokens: string[],
): number {
  let score = 0

  for (const field of [
    capability.toolName,
    capability.id,
    capability.title,
    capability.description,
    capability.preferredRoute,
    ...capability.tags,
    ...capability.searchHints,
  ]) {
    const normalizedField = field.toLowerCase()
    if (normalizedField.includes(normalizedQuery)) {
      score += 6
    }

    for (const token of tokens) {
      if (normalizedField.includes(token)) {
        score += 2
      }
    }
  }

  return score
}

function normalizeRetryPolicy(policy: CapabilityDefinition['retryPolicy']) {
  const retryable = policy?.retryable ?? false
  const maxAttempts =
    typeof policy?.maxAttempts === 'number' && Number.isFinite(policy.maxAttempts)
      ? Math.max(1, Math.floor(policy.maxAttempts))
      : 1

  return {
    retryable,
    maxAttempts: retryable ? maxAttempts : 1,
  }
}
