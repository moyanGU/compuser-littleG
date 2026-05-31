import type { CliBackendAdapter } from '../adapters/cli/CliBackendAdapter.js'
import type { AnyToolDefinition, ToolContext } from '../tools/Tool.js'
import type { ToolRuntime } from '../tools/runtime/ToolRuntime.js'
import type {
  CapabilityCatalog,
  CapabilityCatalogItem,
  CapabilityExecutionResult,
  CapabilityToolData,
} from './Capability.js'
import {
  DEFAULT_CAPABILITY_ROUTING_POLICY,
  normalizeCapabilityChainState,
  resolveCapabilityOutput,
} from './Capability.js'

export const ALWAYS_VISIBLE_CAPABILITY_TOOL_NAMES = new Set<string>([
  'skill.desktop.observe',
])

function resolveCapabilityAvailability(item: CapabilityCatalogItem): 'core' | 'discoverable' {
  if (ALWAYS_VISIBLE_CAPABILITY_TOOL_NAMES.has(item.toolName)) {
    return 'core'
  }

  if (item.availability === 'core' || item.availability === 'discoverable') {
    return item.availability
  }
  return 'discoverable'
}

export function isCapabilityToolName(toolName: string): boolean {
  return toolName.startsWith('skill.') || toolName.startsWith('command.')
}

export function createCapabilityTools(options: {
  catalog: CapabilityCatalog
  runtime: ToolRuntime
  cliAdapter?: CliBackendAdapter
}): AnyToolDefinition[] {
  const searchTool: AnyToolDefinition = {
    name: 'capabilities.search',
    availability: 'core',
    description:
      'Search reusable high-level capabilities before composing low-level tools.',
    searchHints: ['capability', 'search', 'skill', 'command', 'catalog'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'capability search input',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = typeof input?.query === 'string' ? input.query : ''
      const limit =
        typeof input?.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(20, Math.floor(input.limit)))
          : 5
      const matches = options.catalog.search(query, limit)
      return {
        ok: true,
        summary: matches.length
          ? `Found ${matches.length} matching capabilities.`
          : 'No matching capabilities found.',
        data: {
          query,
          matches: matches.map(toCapabilitySearchResult),
        },
      }
    },
  }

  const capabilityTools = options.catalog.list().map(item =>
    createCapabilityTool(item, options.catalog, options.runtime, options.cliAdapter),
  )

  return [searchTool, ...capabilityTools]
}

function createCapabilityTool(
  item: CapabilityCatalogItem,
  catalog: CapabilityCatalog,
  runtime: ToolRuntime,
  cliAdapter: CliBackendAdapter | undefined,
): AnyToolDefinition {
  return {
    name: item.toolName,
    availability: resolveCapabilityAvailability(item),
    description: `${item.description} preferredRoute=${item.preferredRoute}.`,
    searchHints: [item.title, ...item.tags, ...item.searchHints, item.kind],
    riskLevel: item.riskLevel,
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: item.inputSchema,
    async execute(input, toolContext) {
      const definition = catalog.getDefinition(item.id)
      if (!definition) {
        return {
          ok: false,
          summary: `Capability not found: ${item.id}`,
          error: 'CAPABILITY_NOT_FOUND',
          failureClass: 'missing_dependency',
          data: buildCapabilityToolData(item, toolContext, {
            ok: false,
            route: item.preferredRoute,
            operations: [],
            verification: {
              strategy: 'capability-definition',
              passed: false,
              details: `Capability not found: ${item.id}`,
            },
            failureClass: 'missing_dependency',
            error: 'CAPABILITY_NOT_FOUND',
          }),
        }
      }

      try {
        const result = await definition.execute(input, {
          runtime,
          cliAdapter,
          toolContext,
        })

        return toCapabilityToolResult(item, result, toolContext)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        const failureClass = inferCapabilityFailureClass(errorMessage)
        const verification = {
          strategy: 'capability-execution',
          passed: false,
          details: errorMessage,
        }
        return {
          ok: false,
          summary: `${item.toolName} failed.`,
          error: errorMessage,
          failureClass,
          data: buildCapabilityToolData(item, toolContext, {
            ok: false,
            route: item.preferredRoute,
            operations: [],
            verification,
            failureClass,
            error: errorMessage,
          }),
        }
      }
    },
  }
}

function toCapabilitySearchResult(item: CapabilityCatalogItem) {
  return {
    id: item.id,
    toolName: item.toolName,
    kind: item.kind,
    title: item.title,
    description: item.description,
    tags: item.tags,
    preferredRoute: item.preferredRoute,
    riskLevel: item.riskLevel,
    retryPolicy: item.retryPolicy,
    examples: item.examples,
    fallbacks: item.fallbacks,
    availability: resolveCapabilityAvailability(item),
    revealed: resolveCapabilityAvailability(item) === 'core',
  }
}

function toCapabilityToolResult(
  item: CapabilityCatalogItem,
  result: CapabilityExecutionResult,
  toolContext: ToolContext,
) {
  const output = resolveCapabilityOutput(result)
  const data = buildCapabilityToolData(item, toolContext, result, output)
  return {
    ok: result.ok,
    summary: `${item.toolName}: ${result.summary}`,
    error: result.error,
    failureClass: result.failureClass,
    data,
    output,
  }
}

function buildCapabilityToolData<TOutput>(
  item: CapabilityCatalogItem,
  toolContext: ToolContext,
  result: Pick<
    CapabilityExecutionResult<TOutput>,
    | 'route'
    | 'operations'
    | 'verification'
    | 'chainState'
    | 'recoveryPoint'
    | 'recoveryAction'
    | 'observation'
    | 'verificationEvidence'
    | 'failureClass'
    | 'failureReason'
    | 'recoveryUsed'
    | 'routingPolicy'
    | 'ok'
  > & {
    error?: string
  },
  output?: TOutput,
): CapabilityToolData<TOutput> {
  const verification =
    result.verification ??
    ({
      strategy: 'capability-execution',
      passed: false,
      details: result.error ?? 'Capability execution failed.',
    } satisfies CapabilityExecutionResult['verification'])

  return {
    capabilityId: item.id,
    turnId: toolContext.turnId,
    sessionId: toolContext.sessionId,
    route: result.route,
    operations: result.operations,
    verification,
    chainState: normalizeCapabilityChainState({
      ok: result.ok,
      verification,
      chainState: result.chainState,
    }),
    recoveryPoint: result.recoveryPoint,
    recoveryAction: result.recoveryAction,
    observation: result.observation,
    verificationEvidence: result.verificationEvidence ?? [],
    failureClass: result.failureClass,
    failureReason: result.failureReason,
    recoveryUsed: result.recoveryUsed ?? false,
    output,
    fallbacks: item.fallbacks,
    routingPolicy: [...(result.routingPolicy ?? DEFAULT_CAPABILITY_ROUTING_POLICY)],
  }
}

function inferCapabilityFailureClass(errorMessage: string) {
  if (errorMessage.includes('CLI/backend adapter')) {
    return 'missing_dependency'
  }

  if (errorMessage.includes('TIMEOUT')) {
    return 'transient'
  }

  return 'deterministic'
}
