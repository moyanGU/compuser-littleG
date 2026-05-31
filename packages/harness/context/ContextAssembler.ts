import type { ToolDefinition } from '../../tools/Tool.js'
import type { CapabilityCatalogItem } from '../../capabilities/Capability.js'
import {
  buildCapabilityRoutingPlan,
  createEmptyCapabilityRoutingExecutionState,
  type CapabilityRoutingExecutionState,
  type CapabilityRoutingPlan,
} from '../../capabilities/CapabilityRouting.js'

export const MEMORY_FACT_KEYS = [
  'task.current',
  'task.plan',
  'task.last_outcome',
  'task.current_target',
  'task.current_artifact',
  'routing.last_attempt',
  'routing.execution_state',
  'routing.last_verified_anchor',
  'routing.last_recovery_point',
  'routing.chain_status',
  'project.structure',
  'project.recent_paths',
  'preference.response_language',
  'preference.execution_path',
  'constraint.active',
  'compact.last_summary',
] as const

export type MemoryFactKey = (typeof MEMORY_FACT_KEYS)[number]

export interface MemoryFact {
  key?: MemoryFactKey
  category: string
  content: string
  mergeStrategy?: 'replace' | 'append'
}

export interface ToolCatalogEntry
  extends Pick<
    ToolDefinition,
    | 'name'
    | 'description'
    | 'availability'
    | 'searchHints'
    | 'inputSchema'
    | 'riskLevel'
  > {}

export interface ActiveTaskPlan {
  goal: string
  subgoal: string
  status: 'collecting' | 'acting' | 'verifying' | 'recovering' | 'done'
}

export interface ChainStateSnapshot {
  currentTarget?: string
  currentArtifact?: string
  lastVerifiedAnchor?: string
  lastRecoveryPoint?: string
  chainStatus?:
    | 'idle'
    | 'running'
    | 'completed'
    | 'verified_failed'
    | 'execution_failed'
    | 'blocked'
}

export interface CompactContextState {
  tier: 'none' | 'micro' | 'session-memory' | 'full'
  tokenBudget: {
    softLimit: number
    hardLimit: number
    headroom: number
    estimatedInputTokens: number
  }
  lastSummary?: string
}

export interface AssembledContext {
  systemPrompt: string
  toolCatalog: ToolCatalogEntry[]
  capabilityCatalog: CapabilityCatalogItem[]
  routingPlan: CapabilityRoutingPlan
  memoryFacts: MemoryFact[]
  activePlan: ActiveTaskPlan
  compactState: CompactContextState
  chainState: ChainStateSnapshot
}

export interface ContextInput {
  baseSystemPrompt: string
  taskText: string
  tools: ToolDefinition[]
  hiddenDiscoverableToolCount?: number
  hiddenCapabilityCount?: number
  capabilities: CapabilityCatalogItem[]
  memoryFacts: MemoryFact[]
  routingExecutionState?: CapabilityRoutingExecutionState
  compactState?: CompactContextState
}

export class ContextAssembler {
  assemble(input: ContextInput): AssembledContext {
    const toolCatalog = input.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      availability: tool.availability ?? 'core',
      searchHints:
        (tool.searchHints?.length ?? 0) > 0
          ? tool.searchHints ?? []
          : tool.searchHint
            ? [tool.searchHint]
            : [],
      riskLevel: tool.riskLevel,
      inputSchema: tool.inputSchema,
    }))

    const activePlan = buildActiveTaskPlan(
      input.taskText,
      input.routingExecutionState ??
        createEmptyCapabilityRoutingExecutionState(),
    )
    const hiddenNotices: string[] = []
    if (input.hiddenDiscoverableToolCount && input.hiddenDiscoverableToolCount > 0) {
      hiddenNotices.push(
        `There are ${input.hiddenDiscoverableToolCount} additional discoverable tools hidden from the current catalog.`,
      )
    }
    if (input.hiddenCapabilityCount && input.hiddenCapabilityCount > 0) {
      hiddenNotices.push(
        `There are ${input.hiddenCapabilityCount} additional capabilities hidden from the current catalog.`,
      )
    }
    const systemPrompt =
      hiddenNotices.length > 0
        ? [
            input.baseSystemPrompt,
            ...hiddenNotices,
            'Use tools.search before requesting a discoverable tool that is not already listed.',
            'Use capabilities.search before requesting a hidden capability that is not already listed.',
          ].join(' ')
        : input.baseSystemPrompt

    return {
      systemPrompt,
      toolCatalog,
      capabilityCatalog: input.capabilities,
      routingPlan: buildCapabilityRoutingPlan({
        taskText: input.taskText,
        capabilities: input.capabilities,
        tools: toolCatalog,
        executionState:
          input.routingExecutionState ??
          createEmptyCapabilityRoutingExecutionState(),
      }),
      memoryFacts: input.memoryFacts,
      activePlan,
      compactState:
        input.compactState ?? createDefaultCompactContextState(input.taskText),
      chainState: buildChainStateSnapshot(input.memoryFacts),
    }
  }
}

function buildActiveTaskPlan(
  taskText: string,
  executionState: CapabilityRoutingExecutionState,
): ActiveTaskPlan {
  const latestAttempt = executionState.lastAttempt
  const verificationState = executionState.lastVerificationResult ?? 'unknown'
  const status = latestAttempt
    ? latestAttempt.outcome === 'succeeded'
      ? verificationState === 'passed'
        ? 'done'
        : 'verifying'
      : latestAttempt.outcome === 'blocked'
        ? 'recovering'
        : 'acting'
    : 'collecting'

  return {
    goal: taskText.trim() || 'unknown task',
    subgoal:
      executionState.currentSubgoal ??
      latestAttempt?.toolName ??
      (taskText.trim() ? 'select first safe capability or tool' : 'wait for user task'),
    status,
  }
}

function createDefaultCompactContextState(taskText: string): CompactContextState {
  const estimatedInputTokens = Math.max(256, Math.ceil(taskText.length / 4))
  return {
    tier: 'none',
    tokenBudget: {
      softLimit: 18_000,
      hardLimit: 24_000,
      headroom: 4_000,
      estimatedInputTokens,
    },
  }
}

function buildChainStateSnapshot(memoryFacts: MemoryFact[]): ChainStateSnapshot {
  return {
    currentTarget: readMemoryFact(memoryFacts, 'task.current_target'),
    currentArtifact: readMemoryFact(memoryFacts, 'task.current_artifact'),
    lastVerifiedAnchor: readMemoryFact(memoryFacts, 'routing.last_verified_anchor'),
    lastRecoveryPoint: readMemoryFact(memoryFacts, 'routing.last_recovery_point'),
    chainStatus: normalizeChainStatus(
      readMemoryFact(memoryFacts, 'routing.chain_status'),
    ),
  }
}

function readMemoryFact(
  memoryFacts: MemoryFact[],
  key: MemoryFactKey,
): string | undefined {
  const fact = [...memoryFacts].reverse().find(item => item.key === key)
  const content = fact?.content.trim()
  return content ? content : undefined
}

function normalizeChainStatus(
  value: string | undefined,
): ChainStateSnapshot['chainStatus'] {
  if (
    value === 'idle' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'verified_failed' ||
    value === 'execution_failed' ||
    value === 'blocked'
  ) {
    return value
  }

  return undefined
}
