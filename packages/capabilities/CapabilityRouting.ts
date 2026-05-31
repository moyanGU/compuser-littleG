import type {
  CapabilityCatalogItem,
  CapabilityFailureClass,
  CapabilityRetryPolicy,
} from './Capability.js'
import type { ToolDefinition, ToolRiskLevel } from '../tools/Tool.js'

export type RoutingAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'verified_failed'
  | 'blocked'

export type RoutingExhaustedReason = 'non_retryable' | 'max_attempts' | 'blocked'

export interface RoutingAttemptPolicy {
  retryable: boolean
  maxAttempts: number
  retryOn: CapabilityFailureClass[]
}

export interface RoutingAttemptRecord {
  toolName: string
  kind: 'capability' | 'tool'
  outcome: RoutingAttemptOutcome
  turnId: string
  sequence: number
  summary: string
  error?: string
  verificationPassed?: boolean
  route?: string
  failureClass?: CapabilityFailureClass
  retryable: boolean
  maxAttempts: number
  retryOn: CapabilityFailureClass[]
  exhausted: boolean
  exhaustedReason?: RoutingExhaustedReason
}

export interface CapabilityRoutingExecutionState {
  attemptedTools: string[]
  failedTools: string[]
  blockedTools: string[]
  exhaustedTools: string[]
  recentAttempts: RoutingAttemptRecord[]
  lastAttempt?: RoutingAttemptRecord
  currentSubgoal?: string
  lastVerificationResult?: 'passed' | 'failed' | 'unknown'
  lastRecoveryPoint?: string
  lastVerifiedAnchor?: string
}

export interface ToolRoutingCandidate {
  name: string
  description: string
  searchHints: string[]
  riskLevel: ToolRiskLevel
}

export interface CapabilityRoutingCandidate {
  id: string
  toolName: string
  kind: 'skill' | 'command'
  title: string
  description: string
  preferredRoute: 'cli' | 'api' | 'backend' | 'tool'
  riskLevel: ToolRiskLevel
  reason: string
  score: number
  attemptCount: number
  remainingAttempts: number
  exhausted: boolean
  lastOutcome?: RoutingAttemptOutcome
  retryable: boolean
  maxAttempts: number
  retryOn: CapabilityFailureClass[]
}

export interface ToolRoutingFallback {
  toolName: string
  description: string
  riskLevel: ToolRiskLevel
  reason: string
  score: number
  attemptCount: number
  remainingAttempts: number
  exhausted: boolean
  lastOutcome?: RoutingAttemptOutcome
  retryable: boolean
  maxAttempts: number
  retryOn: CapabilityFailureClass[]
}

export interface CapabilityRoutingPlan {
  taskText: string
  recommendedCapabilities: CapabilityRoutingCandidate[]
  fallbackTools: ToolRoutingFallback[]
  policyHints: string[]
  executionState: CapabilityRoutingExecutionState
}

export function buildCapabilityRoutingPlan(input: {
  taskText: string
  capabilities: CapabilityCatalogItem[]
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'searchHints' | 'riskLevel'>>
  executionState?: CapabilityRoutingExecutionState
}): CapabilityRoutingPlan {
  const taskText = input.taskText.trim()
  const terms = extractSearchTerms(taskText)
  const intent = detectTaskIntent(taskText)
  const executionState =
    input.executionState ??
    resolveCapabilityRoutingExecutionState({
      attempts: [],
      capabilities: input.capabilities,
      tools: input.tools,
    })
  const attemptCounts = countAttempts(executionState.recentAttempts)
  const retryableFailureCounts = countRetryableFailures(executionState.recentAttempts)
  const exhaustedTools = new Set(executionState.exhaustedTools)
  const lastOutcomeByTool = new Map(
    executionState.recentAttempts.map(attempt => [attempt.toolName, attempt.outcome]),
  )

  const recommendedCapabilities = input.capabilities
    .map(capability => {
      const score = scoreCapability(capability, taskText, terms, intent)
      const policy = normalizeRetryPolicy(capability.retryPolicy)
      const retryableFailureCount =
        retryableFailureCounts.get(capability.toolName) ?? 0
      return {
        id: capability.id,
        toolName: capability.toolName,
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        preferredRoute: capability.preferredRoute,
        riskLevel: capability.riskLevel,
        reason: buildCapabilityReason(capability),
        score,
        attemptCount: attemptCounts.get(capability.toolName) ?? 0,
        remainingAttempts: Math.max(0, policy.maxAttempts - retryableFailureCount),
        exhausted: exhaustedTools.has(capability.toolName),
        lastOutcome: lastOutcomeByTool.get(capability.toolName),
        retryable: policy.retryable,
        maxAttempts: policy.maxAttempts,
        retryOn: policy.retryOn,
      }
    })
    .filter(capability => capability.score > 0)
    .sort(compareByScoreThenName)
    .slice(0, 4)

  const capabilityToolNames = new Set(
    input.capabilities.map(capability => capability.toolName),
  )
  const fallbackTools = input.tools
    .filter(tool => !isCapabilityTool(tool.name, capabilityToolNames))
    .map(tool => {
      const score = scoreTool(tool, taskText, terms, intent)
      const policy = inferToolRetryPolicy(tool)
      const retryableFailureCount = retryableFailureCounts.get(tool.name) ?? 0
      return {
        toolName: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel,
        reason: buildToolReason(tool),
        score,
        attemptCount: attemptCounts.get(tool.name) ?? 0,
        remainingAttempts: Math.max(0, policy.maxAttempts - retryableFailureCount),
        exhausted: exhaustedTools.has(tool.name),
        lastOutcome: lastOutcomeByTool.get(tool.name),
        retryable: policy.retryable,
        maxAttempts: policy.maxAttempts,
        retryOn: policy.retryOn,
      }
    })
    .filter(tool => tool.score > 0)
    .sort(compareByScoreThenName)
    .slice(0, 6)

  return {
    taskText,
    recommendedCapabilities,
    fallbackTools,
    policyHints: buildRecoveryAwarePolicyHints(
      recommendedCapabilities.length > 0,
      executionState,
    ),
    executionState,
  }
}

export function createEmptyCapabilityRoutingExecutionState(): CapabilityRoutingExecutionState {
  return {
    attemptedTools: [],
    failedTools: [],
    blockedTools: [],
    exhaustedTools: [],
    recentAttempts: [],
    currentSubgoal: undefined,
    lastVerificationResult: 'unknown',
  }
}

export function resolveCapabilityRoutingExecutionState(input: {
  attempts: RoutingAttemptRecord[]
  capabilities: CapabilityCatalogItem[]
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'searchHints' | 'riskLevel'>>
}): CapabilityRoutingExecutionState {
  const attemptedTools = dedupeOrdered(
    input.attempts.map(attempt => attempt.toolName),
  )
  const failedTools = dedupeOrdered(
    input.attempts
      .filter(attempt => isFailureOutcome(attempt.outcome))
      .map(attempt => attempt.toolName),
  )
  const blockedTools = dedupeOrdered(
    input.attempts
      .filter(attempt => attempt.outcome === 'blocked')
      .map(attempt => attempt.toolName),
  )
  const exhaustedTools = attemptedTools.filter(toolName =>
    isToolExhausted(
      input.attempts.filter(attempt => attempt.toolName === toolName),
      resolveRoutingAttemptPolicy({
        toolName,
        capabilities: input.capabilities,
        tools: input.tools,
      }),
    ),
  )

  return {
    attemptedTools,
    failedTools,
    blockedTools,
    exhaustedTools,
    recentAttempts: [...input.attempts],
    lastAttempt: input.attempts.at(-1),
    currentSubgoal: input.attempts.at(-1)?.toolName,
    lastVerificationResult: resolveLastVerificationResult(input.attempts),
    lastRecoveryPoint: resolveLastRecoveryPoint(input.attempts),
    lastVerifiedAnchor: resolveLastVerifiedAnchor(input.attempts),
  }
}

function resolveLastVerificationResult(
  attempts: RoutingAttemptRecord[],
): 'passed' | 'failed' | 'unknown' {
  const lastAttempt = attempts.at(-1)
  if (!lastAttempt) {
    return 'unknown'
  }

  if (lastAttempt.verificationPassed === true) {
    return 'passed'
  }

  if (lastAttempt.verificationPassed === false) {
    return 'failed'
  }

  return 'unknown'
}

function buildRecoveryAwarePolicyHints(
  hasCapabilityRecommendation: boolean,
  executionState: CapabilityRoutingExecutionState,
): string[] {
  const hints = [
    'Prefer recommended capabilities first. Use raw fallback tools only when no suitable capability remains.',
    'Prefer CLI, API, and backend routes before GUI actions whenever the task allows it.',
    'Prefer low-risk observation or retrieval tools before high-risk GUI actions.',
  ]

  if (executionState.exhaustedTools.length > 0) {
    hints.push(
      `Do not retry exhausted tools in this task: ${executionState.exhaustedTools.join(', ')}`,
    )
  }

  if (executionState.blockedTools.length > 0) {
    hints.push(
      `These tools were recently blocked or denied: ${executionState.blockedTools.join(', ')}`,
    )
    hints.push(
      'When GUI or high-risk routes are blocked, prefer backend, CLI, or observe-only recovery paths.',
    )
  }

  if (executionState.lastAttempt?.outcome === 'failed') {
    hints.push(
      `The last attempt ${executionState.lastAttempt.toolName} failed. Prefer an unexhausted backup capability or a safer fallback route.`,
    )
  }

  if (executionState.lastAttempt?.outcome === 'verified_failed') {
    hints.push(
      'The last attempt failed verification. Recover from the last verified anchor or recovery point before continuing.',
    )
  }

  if (executionState.lastRecoveryPoint) {
    hints.push(`Available recovery point: ${executionState.lastRecoveryPoint}`)
  }

  if (executionState.lastVerifiedAnchor) {
    hints.push(`Available verified anchor: ${executionState.lastVerifiedAnchor}`)
  }

  if (!hasCapabilityRecommendation) {
    hints.push(
      'If no capability matches clearly, start with the safest fallback tool that gathers more information.',
    )
  }

  return hints
}

function resolveLastRecoveryPoint(
  attempts: RoutingAttemptRecord[],
): string | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const summary = attempts[index]?.summary
    if (typeof summary !== 'string') {
      continue
    }

    const match = summary.match(/recovery=([^;]+)/)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }

  return undefined
}

function resolveLastVerifiedAnchor(
  attempts: RoutingAttemptRecord[],
): string | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const summary = attempts[index]?.summary
    if (typeof summary !== 'string') {
      continue
    }

    const match = summary.match(/anchor=([^;]+)/)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }

  return undefined
}

export function resolveRoutingAttemptPolicy(input: {
  toolName: string
  capabilities: CapabilityCatalogItem[]
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'searchHints' | 'riskLevel'>>
}): RoutingAttemptPolicy {
  const capability = input.capabilities.find(
    item => item.toolName === input.toolName,
  )
  if (capability) {
    return normalizeRetryPolicy(capability.retryPolicy)
  }

  const tool = input.tools.find(item => item.name === input.toolName)
  if (tool) {
    return inferToolRetryPolicy(tool)
  }

  return {
    retryable: false,
    maxAttempts: 1,
    retryOn: [],
  }
}

function scoreCapability(
  capability: CapabilityCatalogItem,
  taskText: string,
  terms: string[],
  intent: TaskIntentProfile,
): number {
  let score = scoreFields(
    taskText,
    terms,
    [
      capability.toolName,
      capability.id,
      capability.title,
      capability.description,
      capability.preferredRoute,
      ...capability.tags,
      ...capability.searchHints,
      ...capability.examples.map(example => example.task),
    ],
  )

  if (
    capability.preferredRoute === 'cli' ||
    capability.preferredRoute === 'api' ||
    capability.preferredRoute === 'backend'
  ) {
    score += 3
  }

  if (capability.riskLevel === 'low') {
    score += 2
  } else if (capability.riskLevel === 'high') {
    score -= 2
  }

  score += scoreIntentBoostForCapability(capability, intent)

  return score
}

function scoreTool(
  tool: Pick<ToolDefinition, 'name' | 'description' | 'searchHints' | 'riskLevel'>,
  taskText: string,
  terms: string[],
  intent: TaskIntentProfile,
): number {
  let score = scoreFields(taskText, terms, [
    tool.name,
    tool.description,
    ...(tool.searchHints ?? []),
  ])

  if (tool.riskLevel === 'low') {
    score += 2
  } else if (tool.riskLevel === 'high') {
    score -= 4
  }

  if (tool.name === 'windows.snapshot') {
    score += 1
  }

  if (tool.name === 'windows.click' || tool.name === 'windows.type') {
    score -= 3
  }

  score += scoreIntentBoostForTool(tool, intent)

  return score
}

function scoreFields(
  taskText: string,
  terms: string[],
  fields: string[],
): number {
  const normalizedTaskText = taskText.toLowerCase()
  let score = 0

  for (const field of fields) {
    const normalizedField = field.toLowerCase()
    if (!normalizedField) {
      continue
    }

    if (normalizedTaskText && normalizedField.includes(normalizedTaskText)) {
      score += 8
    }

    for (const term of terms) {
      if (normalizedField.includes(term)) {
        score += term.length >= 4 ? 3 : 2
      }
    }
  }

  return score
}

function extractSearchTerms(taskText: string): string[] {
  const normalized = taskText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const words = normalized.split(/\s+/).filter(Boolean)
  const cjkChunks = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap(match => buildCjkTerms(match[0]))
  return [...new Set([...words, ...cjkChunks])].filter(Boolean)
}

function buildCjkTerms(chunk: string): string[] {
  const terms = new Set<string>()
  for (let size = 2; size <= Math.min(4, chunk.length); size += 1) {
    for (let index = 0; index <= chunk.length - size; index += 1) {
      terms.add(chunk.slice(index, index + size))
    }
  }
  return [...terms]
}

function compareByScoreThenName(
  left: { score: number; toolName: string },
  right: { score: number; toolName: string },
): number {
  if (right.score !== left.score) {
    return right.score - left.score
  }

  return left.toolName.localeCompare(right.toolName)
}

function isCapabilityTool(
  toolName: string,
  capabilityToolNames: ReadonlySet<string>,
): boolean {
  return (
    capabilityToolNames.has(toolName) ||
    toolName === 'capabilities.search'
  )
}

function buildCapabilityReason(capability: CapabilityCatalogItem): string {
  const policy = normalizeRetryPolicy(capability.retryPolicy)
  return `优先路径=${capability.preferredRoute}; 风险=${capability.riskLevel}; kind=${capability.kind}; retryable=${policy.retryable}; maxAttempts=${policy.maxAttempts}; retryOn=${policy.retryOn.join('|') || 'none'}`
}

function buildToolReason(
  tool: Pick<ToolDefinition, 'name' | 'riskLevel'>,
): string {
  const policy = inferToolRetryPolicy(tool)
  return `底层回落工具; 风险=${tool.riskLevel}; tool=${tool.name}; retryable=${policy.retryable}; maxAttempts=${policy.maxAttempts}; retryOn=${policy.retryOn.join('|') || 'none'}`
}

function buildPolicyHints(
  hasCapabilityRecommendation: boolean,
  executionState: CapabilityRoutingExecutionState,
): string[] {
  const hints = [
    '优先使用推荐 capability；只有 capability 不覆盖或失败时才退回底层工具。',
    '优先选择 CLI/API/backend 路径，GUI 与桌面输入仅作为后备手段。',
    '在多个回落工具之间，优先低风险和结构化观测工具，再考虑高风险动作工具。',
  ]

  if (executionState.exhaustedTools.length > 0) {
    hints.push(
      `当前任务中已耗尽的工具不要重复尝试：${executionState.exhaustedTools.join(', ')}`,
    )
  }

  if (executionState.blockedTools.length > 0) {
    hints.push(
      `以下工具最近被阻塞或拒绝，不要自动重复调用：${executionState.blockedTools.join(', ')}`,
    )
  }

  if (executionState.lastAttempt?.outcome === 'failed') {
    hints.push(
      `最近一次尝试 ${executionState.lastAttempt.toolName} 失败，优先选择未耗尽的备用 capability 或更安全 fallback。`,
    )
  }

  if (!hasCapabilityRecommendation) {
    hints.push('如果没有明确 capability 命中，可先用 fallbackTools 中的低风险工具收集信息。')
  }

  return hints
}

function countAttempts(
  attempts: RoutingAttemptRecord[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const attempt of attempts) {
    counts.set(attempt.toolName, (counts.get(attempt.toolName) ?? 0) + 1)
  }
  return counts
}

function countRetryableFailures(
  attempts: RoutingAttemptRecord[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const attempt of attempts) {
    if (!isRetryableFailureAttempt(attempt)) {
      continue
    }
    counts.set(attempt.toolName, (counts.get(attempt.toolName) ?? 0) + 1)
  }
  return counts
}

function normalizeRetryPolicy(
  policy: CapabilityRetryPolicy | undefined,
): RoutingAttemptPolicy {
  const retryable = policy?.retryable ?? false
  const rawMaxAttempts =
    typeof policy?.maxAttempts === 'number' && Number.isFinite(policy.maxAttempts)
      ? Math.max(1, Math.floor(policy.maxAttempts))
      : 1

  return {
    retryable,
    maxAttempts: retryable ? rawMaxAttempts : 1,
    retryOn:
      retryable && Array.isArray(policy?.retryOn) && policy.retryOn.length > 0
        ? [...new Set(policy.retryOn)]
        : retryable
          ? ['transient']
          : [],
  }
}

function inferToolRetryPolicy(
  tool: Pick<ToolDefinition, 'name' | 'riskLevel'>,
): RoutingAttemptPolicy {
  const normalizedName = tool.name.toLowerCase()
  if (
    normalizedName === 'windows.click' ||
    normalizedName === 'windows.type' ||
    normalizedName.includes('focus') ||
    normalizedName.includes('shortcut') ||
    normalizedName.includes('scroll') ||
    tool.riskLevel === 'high'
  ) {
    return {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    }
  }

  if (
    normalizedName === 'windows.snapshot' ||
    normalizedName === 'windows.screenshot' ||
    normalizedName.includes('search') ||
    normalizedName.includes('read') ||
    normalizedName.includes('inspect') ||
    normalizedName.includes('list') ||
    normalizedName.includes('tree') ||
    normalizedName.includes('echo') ||
    normalizedName.includes('artifacts.')
  ) {
    return {
      retryable: true,
      maxAttempts: 2,
      retryOn: ['transient'],
    }
  }

  return {
    retryable: tool.riskLevel === 'low',
    maxAttempts: tool.riskLevel === 'low' ? 2 : 1,
    retryOn: tool.riskLevel === 'low' ? ['transient'] : [],
  }
}

function isFailureOutcome(outcome: RoutingAttemptOutcome): boolean {
  return (
    outcome === 'failed' ||
    outcome === 'verified_failed' ||
    outcome === 'blocked'
  )
}

function isToolExhausted(
  attempts: RoutingAttemptRecord[],
  policy: RoutingAttemptPolicy,
): boolean {
  const lastAttempt = attempts.at(-1)
  if (!lastAttempt || lastAttempt.outcome === 'succeeded') {
    return false
  }

  if (lastAttempt.outcome === 'blocked') {
    return true
  }

  const retryableFailures = attempts.filter(attempt =>
    isRetryableFailureAttempt(attempt),
  )

  if (!matchesRetryOn(policy, lastAttempt.failureClass)) {
    return true
  }

  if (!policy.retryable) {
    return retryableFailures.length > 0
  }

  return retryableFailures.length >= policy.maxAttempts
}

export function dedupeOrdered(values: string[]): string[] {
  const unique = new Set<string>()
  const deduped: string[] = []

  for (const value of values) {
    if (unique.has(value)) {
      continue
    }
    unique.add(value)
    deduped.push(value)
  }

  return deduped
}

export function matchesRetryOn(
  policy: RoutingAttemptPolicy,
  failureClass: CapabilityFailureClass | undefined,
): boolean {
  if (!policy.retryable || !failureClass) {
    return false
  }

  return policy.retryOn.includes(failureClass)
}

function isRetryableFailureAttempt(attempt: RoutingAttemptRecord): boolean {
  return (
    isFailureOutcome(attempt.outcome) &&
    matchesRetryOn(
      {
        retryable: attempt.retryable,
        maxAttempts: attempt.maxAttempts,
        retryOn: attempt.retryOn,
      },
      attempt.failureClass,
    )
  )
}

type TaskIntentProfile = {
  desktopObserve: boolean
  workspaceTree: boolean
  workspaceSearch: boolean
  workspaceRead: boolean
}

function detectTaskIntent(taskText: string): TaskIntentProfile {
  return {
    desktopObserve: hasAnyKeyword(taskText, ['桌面', '屏幕', '截图', '快照', '窗口', '界面']),
    workspaceTree: hasAnyKeyword(taskText, ['目录', '文件树', '结构', '工作区', '文件夹']),
    workspaceSearch: hasAnyKeyword(taskText, ['搜索', '查找', 'grep', '检索']),
    workspaceRead: hasAnyKeyword(taskText, ['读取', '打开', '查看', 'read']) &&
      hasAnyKeyword(taskText, ['文件', '.ts', '.js', '.json', '.md', '.txt', 'package.json']),
  }
}

function hasAnyKeyword(taskText: string, keywords: string[]): boolean {
  const normalized = taskText.toLowerCase()
  return keywords.some(keyword => normalized.includes(keyword.toLowerCase()))
}

function scoreIntentBoostForCapability(
  capability: CapabilityCatalogItem,
  intent: TaskIntentProfile,
): number {
  let score = 0

  if (intent.desktopObserve) {
    if (capability.id === 'desktop.observe') {
      score += 14
    } else if (capability.id.startsWith('workspace.')) {
      score -= 6
    }
  }

  if (intent.workspaceTree) {
    if (capability.id === 'workspace.inspect_tree') {
      score += 12
    }
  }

  if (intent.workspaceSearch) {
    if (capability.id === 'workspace.search_text') {
      score += 12
    }
  }

  if (intent.workspaceRead) {
    if (capability.id === 'workspace.read_text') {
      score += 12
    }
  }

  return score
}

function scoreIntentBoostForTool(
  tool: Pick<ToolDefinition, 'name'>,
  intent: TaskIntentProfile,
): number {
  let score = 0

  if (intent.desktopObserve) {
    if (tool.name === 'windows.snapshot') {
      score += 10
    } else if (tool.name === 'windows.screenshot') {
      score += 8
    } else if (tool.name.startsWith('windows.') && tool.name !== 'windows.snapshot' && tool.name !== 'windows.screenshot') {
      score -= 3
    }
  }

  if (intent.workspaceSearch && tool.name.includes('search')) {
    score += 6
  }

  if (intent.workspaceRead && tool.name.includes('read')) {
    score += 6
  }

  return score
}
