import type { CliBackendAdapter } from '../adapters/cli/CliBackendAdapter.js'
import type {
  ToolContext,
  ToolFailureClass,
  ToolResult,
  ToolAvailability,
  ToolRiskLevel,
  ToolSchema,
} from '../tools/Tool.js'
import type { ToolRuntime as RuntimeExecutor } from '../tools/runtime/ToolRuntime.js'

export type CapabilityKind = 'skill' | 'command'

export type CapabilityRoute = 'cli' | 'api' | 'backend' | 'tool'

export type CapabilityFailureClass = ToolFailureClass

export type CapabilityFailureReason =
  | 'routing_failed'
  | 'observation_insufficient'
  | 'focus_drift'
  | 'target_ambiguous'
  | 'artifact_missing'
  | 'verification_mismatch'
  | 'verification_failed'
  | 'execution_failed'

export type CapabilityRecoveryAction =
  | 'recover:refocus'
  | 'recover:reobserve'
  | 'recover:reroute'
  | 'recover:restage'

export interface CapabilityObservation {
  confidence?: number
  sufficient?: boolean
  mode?: 'snapshot' | 'screenshot' | 'dom'
  windowAnchor?: string
  domAnchor?: string
  textAnchor?: string
}

export const DEFAULT_CAPABILITY_ROUTING_POLICY = [
  'backend-first',
  'browser-dom-first',
  'desktop-observe-fallback',
  'gui-last',
] as const

export interface CapabilityOperation {
  type: 'tool' | 'cli'
  target: string
  ok: boolean
  summary: string
}

export interface CapabilityVerification {
  strategy: string
  passed: boolean
  details: string
}

export type CapabilityChainStatus =
  | 'idle'
  | 'running'
  | 'observed'
  | 'captured'
  | 'staged'
  | 'routed'
  | 'delivered'
  | 'verified'
  | 'recovered'
  | 'completed'
  | 'routing_failed'
  | 'environment_unready'
  | 'verified_failed'
  | 'execution_failed'
  | 'blocked'

export interface CapabilityChainState {
  currentTarget?: string
  currentArtifact?: string
  lastVerifiedAnchor?: string
  observationConfidence?: number
  observationSource?: string
  anchorMatches?: string[]
  chainStatus?: CapabilityChainStatus
}

export interface CapabilityExecuteContext {
  toolContext: ToolContext
  runtime: RuntimeExecutor
  cliAdapter?: CliBackendAdapter
}

export interface CapabilityExecutionResult<TData = unknown> {
  ok: boolean
  summary: string
  route: CapabilityRoute
  /**
   * Legacy payload alias. Prefer `output` for new capability implementations.
   */
  data?: TData
  output?: TData
  error?: string
  failureClass?: CapabilityFailureClass
  failureReason?: CapabilityFailureReason
  operations: CapabilityOperation[]
  verification: CapabilityVerification
  chainState?: CapabilityChainState
  recoveryPoint?: string
  recoveryAction?: CapabilityRecoveryAction
  observation?: CapabilityObservation
  verificationEvidence?: string[]
  recoveryUsed?: boolean
  routingPolicy?: string[]
}

export interface CapabilityToolData<TOutput = unknown> {
  capabilityId: string
  turnId: string
  sessionId: string
  route: CapabilityRoute
  operations: CapabilityOperation[]
  verification: CapabilityVerification
  chainState: CapabilityChainState
  recoveryPoint: string | undefined
  recoveryAction: CapabilityRecoveryAction | undefined
  observation: CapabilityObservation | undefined
  verificationEvidence: string[]
  failureClass: CapabilityFailureClass | undefined
  failureReason: CapabilityFailureReason | undefined
  recoveryUsed: boolean
  output: TOutput | undefined
  fallbacks: string[]
  routingPolicy: string[]
}

export interface CapabilityExample<TInput = unknown> {
  task: string
  input: TInput
}

export interface CapabilityRetryPolicy {
  retryable: boolean
  maxAttempts: number
  retryOn?: CapabilityFailureClass[]
}

export interface CapabilityDefinition<TInput = unknown, TOutput = unknown> {
  id: string
  kind: CapabilityKind
  title: string
  description: string
  availability?: ToolAvailability
  searchHints: string[]
  tags: string[]
  preferredRoute: CapabilityRoute
  riskLevel: ToolRiskLevel
  inputSchema: ToolSchema
  retryPolicy?: CapabilityRetryPolicy
  examples?: Array<CapabilityExample<TInput>>
  fallbacks?: string[]
  execute(
    input: TInput,
    context: CapabilityExecuteContext,
  ): Promise<CapabilityExecutionResult<TOutput>>
}

export interface CapabilityCatalogItem {
  id: string
  toolName: string
  kind: CapabilityKind
  title: string
  description: string
  availability: ToolAvailability
  tags: string[]
  searchHints: string[]
  preferredRoute: CapabilityRoute
  riskLevel: ToolRiskLevel
  inputSchema: ToolSchema
  retryPolicy: CapabilityRetryPolicy
  examples: CapabilityExample[]
  fallbacks: string[]
}

export interface CapabilityCatalog {
  list(): CapabilityCatalogItem[]
  get(id: string): CapabilityCatalogItem | undefined
  getDefinition(id: string): CapabilityDefinition | undefined
  search(query: string, limit?: number): CapabilityCatalogItem[]
}

export function toCapabilityToolName(
  capability: Pick<CapabilityDefinition, 'kind' | 'id'>,
): string {
  return `${capability.kind}.${capability.id}`
}

export async function executeNestedTool(
  runtime: RuntimeExecutor,
  context: ToolContext,
  toolName: string,
  input: Record<string, unknown> = {},
): Promise<ToolResult> {
  return await runtime.execute(
    {
      toolName,
      input,
    },
    context,
  )
}

export function resolveCapabilityOutput<TData>(
  result: Pick<CapabilityExecutionResult<TData>, 'data' | 'output'>,
): TData | undefined {
  return result.output !== undefined ? result.output : result.data
}

export function resolveCapabilityChainStatus(
  result: Pick<CapabilityExecutionResult, 'ok' | 'verification' | 'chainState'>,
): CapabilityChainStatus {
  const explicit = result.chainState?.chainStatus
  if (
    explicit === 'idle' ||
    explicit === 'running' ||
    explicit === 'observed' ||
    explicit === 'captured' ||
    explicit === 'staged' ||
    explicit === 'routed' ||
    explicit === 'delivered' ||
    explicit === 'verified' ||
    explicit === 'recovered' ||
    explicit === 'completed' ||
    explicit === 'routing_failed' ||
    explicit === 'environment_unready' ||
    explicit === 'verified_failed' ||
    explicit === 'execution_failed' ||
    explicit === 'blocked'
  ) {
    return explicit
  }

  if (!result.ok) {
    return 'execution_failed'
  }

  return result.verification.passed ? 'completed' : 'verified_failed'
}

export function normalizeCapabilityChainState(
  result: Pick<CapabilityExecutionResult, 'ok' | 'verification' | 'chainState'>,
): CapabilityChainState {
  return {
    ...(result.chainState ?? {}),
    chainStatus: resolveCapabilityChainStatus(result),
  }
}
