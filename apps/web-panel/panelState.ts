import type { QueryTurnResult } from '../../packages/core/QueryEngine.js'
import type { QueryMessage } from '../../packages/core/QueryEngine.js'
import type { MemoryFact } from '../../packages/harness/context/ContextAssembler.js'
import { VERIFIED_SUPPORT_BOUNDARY } from '../../packages/product/SupportMatrix.js'
import { PRODUCT_GOVERNANCE_VIEW } from '../../packages/product/ProductGovernance.js'
import type { ToolResult } from '../../packages/tools/Tool.js'
import type {
  PanelPermissionEvent,
  PanelRouteCard,
  PendingPermissionView,
  PanelSummaryCard,
  PanelTaskOptions,
  PanelTimelineEvent,
  PanelToolResultItem,
  PanelVerificationItem,
  ProductizationDecisionView,
  ProductizationPanelState,
  ProductizationResultView,
  WindowsMcpStatusView,
} from './panelTypes.js'
import { PANEL_DEFAULT_SESSION_ID } from './defaults.js'

export function createEmptyPanelState(
  windowsMcpStatus: WindowsMcpStatusView,
): ProductizationPanelState {
  const planSummary: PanelSummaryCard[] = [
    { title: '任务', value: '还没有提交任务。' },
    {
      title: '处理方式',
      value: '提交任务后，面板会先判断是否能直接进入已验证路径。',
    },
    { title: '当前保护方式', value: 'default' },
  ]
  const timeline: PanelTimelineEvent[] = [
    {
      title: '任务面板已就绪',
      detail:
        '输入任务后，这里会先给出是否可执行、是否需要补充条件，再进入执行或结果页。',
      status: 'info',
    },
  ]

  return {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    view: 'home',
    decision: undefined,
    result: undefined,
    debug: {
      planSummary,
      routeCards: [],
      timeline,
      permissionEvents: [],
      verification: [],
      results: [],
      scorecardSummary: undefined,
      governance: PRODUCT_GOVERNANCE_VIEW,
    },
    currentStage: 'idle',
    stageLabel: '空闲',
    isRunning: false,
    emergencyStopAvailable: false,
    launchedTemplateId: undefined,
    selectedRoute: 'none',
    recoveryPoint: undefined,
    planSummary,
    routeCards: [],
    timeline,
    permissionEvents: [],
    pendingPermission: undefined,
    pendingTemplateLaunch: undefined,
    verification: [],
    results: [],
    recommendedTemplates: [],
    scorecardSummary: undefined,
    governance: PRODUCT_GOVERNANCE_VIEW,
    supportBoundary: VERIFIED_SUPPORT_BOUNDARY,
    windowsMcpStatus,
    updatedAt: new Date().toISOString(),
  }
}

export function buildPanelStateFromRun(input: {
  task: string
  result: QueryTurnResult
  memoryFacts: MemoryFact[]
  windowsMcpStatus: WindowsMcpStatusView
  options: PanelTaskOptions
}): ProductizationPanelState {
  const currentStage = readFact(input.memoryFacts, 'routing.chain_status') ?? 'idle'
  const permissionEvents = collectPermissionEvents(input.result.toolResults)
  const pendingPermission = collectPendingPermission(input.result.toolResults)
  const verification = collectVerificationItems(input.result.toolResults)
  const results = collectResultItems(
    input.result.toolResults,
    input.result.messages.filter(
      (message): message is QueryMessage => message.role === 'tool',
    ),
  )
  const routeCards = collectRouteCards(input.memoryFacts)
  const timeline = collectTimeline(
    input.result.toolResults,
    permissionEvents,
    verification,
  )
  const stageLabel = formatStageLabel(currentStage)
  const finalText = input.result.finalText
  const selectedRoute = readFact(input.memoryFacts, 'routing.execution_state')
  const recoveryPoint = readFact(input.memoryFacts, 'routing.last_recovery_point')
  const planSummary = buildPlanSummary({
    task: input.task,
    memoryFacts: input.memoryFacts,
    permissionMode: input.options.permissionMode ?? 'default',
    finalText,
  })
  const result = buildResultView({
    stopReason: input.result.stopReason,
    finalText,
    currentStage,
  })

  const state: ProductizationPanelState = {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    submittedTask: input.task,
    launchedTemplateId: readFact(input.memoryFacts, 'task.template_id'),
    view: 'result',
    decision: undefined,
    result,
    debug: undefined,
    currentStage,
    stageLabel,
    isRunning: false,
    emergencyStopAvailable: false,
    stopReason: input.result.stopReason,
    finalText,
    selectedRoute,
    recoveryPoint,
    planSummary,
    routeCards,
    timeline,
    permissionEvents,
    pendingPermission,
    pendingTemplateLaunch: undefined,
    verification,
    results,
    recommendedTemplates: input.options.recommendedTemplates ?? [],
    scorecardSummary: input.options.scorecardSummary,
    governance: input.options.governance ?? PRODUCT_GOVERNANCE_VIEW,
    supportBoundary:
      input.options.supportBoundary ??
      input.options.governance?.supportBoundary ??
      VERIFIED_SUPPORT_BOUNDARY,
    windowsMcpStatus: input.windowsMcpStatus,
    updatedAt: new Date().toISOString(),
  }
  state.debug = buildDebugState(state)
  return state
}

export function buildDecisionPanelState(input: {
  baseState: ProductizationPanelState
  decision: ProductizationDecisionView
  submittedTask: string
}): ProductizationPanelState {
  const state: ProductizationPanelState = {
    ...input.baseState,
    submittedTask: input.submittedTask,
    view: 'decision',
    decision: input.decision,
    result: undefined,
    isRunning: false,
    emergencyStopAvailable: false,
    updatedAt: new Date().toISOString(),
  }
  state.debug = buildDebugState(state)
  return state
}

export function buildExecutingPanelState(input: {
  baseState: ProductizationPanelState
  submittedTask: string
  launchedTemplateId?: string
  stageLabel?: string
  pendingTemplateLaunch?: ProductizationPanelState['pendingTemplateLaunch']
  pendingPermission?: ProductizationPanelState['pendingPermission']
}): ProductizationPanelState {
  const state: ProductizationPanelState = {
    ...input.baseState,
    submittedTask: input.submittedTask,
    launchedTemplateId: input.launchedTemplateId,
    view: 'executing',
    decision: undefined,
    result: undefined,
    currentStage:
      input.baseState.currentStage === 'idle'
        ? 'observing'
        : input.baseState.currentStage,
    stageLabel: input.stageLabel ?? input.baseState.stageLabel,
    isRunning: true,
    emergencyStopAvailable: true,
    pendingTemplateLaunch: input.pendingTemplateLaunch,
    pendingPermission: input.pendingPermission,
    updatedAt: new Date().toISOString(),
  }
  state.debug = buildDebugState(state)
  return state
}

export function buildHomePanelState(
  baseState: ProductizationPanelState,
): ProductizationPanelState {
  const state: ProductizationPanelState = {
    ...baseState,
    view: 'home',
    decision: undefined,
    result: undefined,
    isRunning: false,
    emergencyStopAvailable: false,
    updatedAt: new Date().toISOString(),
  }
  state.debug = buildDebugState(state)
  return state
}

export function buildDebugState(
  state: ProductizationPanelState,
): NonNullable<ProductizationPanelState['debug']> {
  return {
    planSummary: state.planSummary,
    routeCards: state.routeCards,
    timeline: state.timeline,
    permissionEvents: state.permissionEvents,
    verification: state.verification,
    results: state.results,
    scorecardSummary: state.scorecardSummary,
    governance: state.governance,
  }
}

function buildPlanSummary(input: {
  task: string
  memoryFacts: MemoryFact[]
  permissionMode: string
  finalText?: string
}): PanelSummaryCard[] {
  return [
    { title: '任务', value: input.task },
    {
      title: '处理方式',
      value:
        readFact(input.memoryFacts, 'task.plan') ??
        '先确认目标与边界，再沿已验证路径执行，最后回头核对结果。',
    },
    { title: '当前保护方式', value: input.permissionMode },
    {
      title: '最近结果',
      value:
        readFact(input.memoryFacts, 'task.last_outcome') ??
        input.finalText?.trim() ??
        '还没有可展示的结果。',
      tone: inferOutcomeTone(input.memoryFacts),
    },
  ]
}

function inferOutcomeTone(
  memoryFacts: MemoryFact[],
): PanelSummaryCard['tone'] {
  const chainStatus = readFact(memoryFacts, 'routing.chain_status')
  if (chainStatus === 'completed') {
    return 'success'
  }
  if (chainStatus === 'verified_failed' || chainStatus === 'execution_failed') {
    return 'danger'
  }
  if (chainStatus === 'blocked') {
    return 'warning'
  }
  return 'neutral'
}

function collectRouteCards(memoryFacts: MemoryFact[]): PanelRouteCard[] {
  const executionState = readFact(memoryFacts, 'routing.execution_state')
  const lastAttempt = readFact(memoryFacts, 'routing.last_attempt')
  const recoveryPoint = readFact(memoryFacts, 'routing.last_recovery_point')
  const cards: PanelRouteCard[] = []

  if (executionState) {
    cards.push({
      route: 'routing.execution_state',
      title: '当前执行路径',
      reason: executionState,
      status: classifyStatusFromText(executionState),
    })
  }

  if (lastAttempt) {
    cards.push({
      route: 'routing.last_attempt',
      title: '最近一次尝试',
      reason: lastAttempt,
      status: classifyStatusFromText(lastAttempt),
    })
  }

  if (recoveryPoint) {
    cards.push({
      route: 'routing.last_recovery_point',
      title: '可恢复位置',
      reason: recoveryPoint,
      status: 'recovering',
    })
  }

  return cards
}

function collectTimeline(
  toolResults: ToolResult[],
  permissionEvents: PanelPermissionEvent[],
  verification: PanelVerificationItem[],
): PanelTimelineEvent[] {
  const events: PanelTimelineEvent[] = []

  if (toolResults.length === 0) {
    events.push({
      title: '还没有实际动作',
      detail: '这次执行里还没有出现实际工具动作。',
      status: 'info',
    })
  }

  for (const result of toolResults) {
    events.push({
      title: result.pointer ? '完成了一步（细节已收起）' : '完成了一步',
      detail: result.summary,
      status: result.ok
        ? 'success'
        : mapFailureToTimelineStatus(result.failureClass),
    })
  }

  for (const event of permissionEvents) {
    events.push({
      title:
        event.decision === 'allow'
          ? '这一步已放行'
          : event.decision === 'ask'
            ? '这一步在等确认'
            : '这一步被拦下',
      detail: `${event.toolName} (${event.riskLevel})`,
      status:
        event.decision === 'allow'
          ? 'info'
          : event.decision === 'ask'
            ? 'warning'
            : 'danger',
    })
  }

  for (const item of verification) {
    events.push({
      title: '执行后核对了一次',
      detail: item.summary,
      status:
        item.status === 'success'
          ? 'success'
          : item.status === 'warning'
            ? 'warning'
            : 'danger',
    })
  }

  return events.slice(0, 20)
}

function collectPermissionEvents(
  toolResults: ToolResult[],
): PanelPermissionEvent[] {
  const events: PanelPermissionEvent[] = []

  for (const result of toolResults) {
    const permission = readPermissionData(result)
    if (!permission) {
      continue
    }

    events.push({
      toolName: permission.toolName ?? 'tool',
      decision: permission.decision ?? 'unknown',
      riskLevel: permission.riskLevel ?? 'unknown',
      reason: permission.reason ?? result.summary,
      reviewStage: permission.reviewStage ?? 'static',
      resourceScope: permission.resourceScope,
      accessMode: permission.accessMode,
      targetPaths: permission.targetPaths,
    })
  }

  return events
}

function collectPendingPermission(
  toolResults: ToolResult[],
): PendingPermissionView | undefined {
  for (const result of [...toolResults].reverse()) {
    const permission = readPermissionData(result)
    if (!permission || permission.decision !== 'ask') {
      continue
    }

    return {
      id: `${permission.toolName ?? 'tool'}:${permission.reviewStage ?? 'static'}:${permission.reason ?? result.summary}`,
      toolName: permission.toolName ?? 'tool',
      riskLevel: permission.riskLevel ?? 'unknown',
      reason: permission.reason ?? result.summary,
      reviewStage: permission.reviewStage ?? 'static',
      reviewSource: permission.reviewSource,
      resourceScope: permission.resourceScope,
      accessMode: permission.accessMode,
      targetPaths: permission.targetPaths ?? [],
      inputSummary: permission.inputSummary ?? result.summary,
      availableGrantScopes: ['once', 'tool', 'risk'],
    }
  }

  return undefined
}

function collectVerificationItems(
  toolResults: ToolResult[],
): PanelVerificationItem[] {
  const items: PanelVerificationItem[] = []

  for (const result of toolResults) {
    const verification = readVerificationData(result)
    if (!verification) {
      continue
    }

    items.push({
      summary:
        typeof verification.details === 'string'
          ? verification.details
          : result.summary,
      status:
        verification.passed === true
          ? 'success'
          : result.ok
            ? 'warning'
            : 'danger',
    })
  }

  return items
}

function collectResultItems(
  toolResults: ToolResult[],
  toolMessages: QueryMessage[],
): PanelToolResultItem[] {
  return toolResults.map((result, index) => ({
    toolName: resolveToolName(toolMessages, index),
    ok: result.ok,
    summary: result.summary,
    failureClass: result.failureClass,
    pointer: result.pointer,
    rawData: result.data,
    error: result.error,
  }))
}

function resolveToolName(toolMessages: QueryMessage[], index: number): string {
  const match = toolMessages[index]
  return typeof match?.toolName === 'string' && match.toolName.trim()
    ? match.toolName
    : 'tool'
}

function readFact(memoryFacts: MemoryFact[], key: string): string | undefined {
  const fact = [...memoryFacts].reverse().find(item => item.key === key)
  const content = fact?.content.trim()
  return content ? content : undefined
}

function formatStageLabel(stage: string): string {
  switch (stage) {
    case 'idle':
      return '空闲'
    case 'observed':
      return '正在看清目标'
    case 'captured':
      return '正在取内容'
    case 'staged':
      return '正在准备中间结果'
    case 'routed':
      return '正在选择执行路径'
    case 'delivered':
      return '已送出，正在核对'
    case 'verified':
      return '已核对完成'
    case 'completed':
      return '这次已经做完'
    case 'recovered':
      return '已从中断位置接回'
    case 'verified_failed':
      return '动作做了，但结果不对'
    case 'execution_failed':
      return '执行中途卡住了'
    case 'routing_failed':
      return '还没有选定可执行路径'
    case 'environment_unready':
      return '环境还没准备好'
    case 'blocked':
      return '被保护规则拦住了'
    default:
      return stage
        .split('_')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
  }
}

function classifyStatusFromText(value: string): string {
  if (value.includes('verification=passed') || value.includes('status=succeeded')) {
    return 'healthy'
  }
  if (value.includes('blocked')) {
    return 'blocked'
  }
  if (value.includes('failed')) {
    return 'attention'
  }
  return 'active'
}

function mapFailureToTimelineStatus(
  failureClass: ToolResult['failureClass'],
): PanelTimelineEvent['status'] {
  if (failureClass === 'permission') {
    return 'warning'
  }
  if (failureClass === 'missing_dependency' || failureClass === 'deterministic') {
    return 'danger'
  }
  return 'warning'
}

function buildResultView(input: {
  stopReason?: string
  finalText?: string
  currentStage: string
}): ProductizationResultView {
  if (input.stopReason === 'aborted') {
    return {
      kind: 'aborted',
      title: '任务已中止',
      summary: input.finalText?.trim() || '这次任务已被中止，没有继续自动执行。',
      nextActionText: '回到首页后，可以重新整理任务再发起。',
    }
  }

  if (
    input.currentStage === 'execution_failed' ||
    input.currentStage === 'verified_failed' ||
    (typeof input.stopReason === 'string' &&
      input.stopReason !== 'completed' &&
      input.stopReason !== 'success')
  ) {
    return {
      kind: 'failure',
      title: '任务没有完成',
      summary: input.finalText?.trim() || '这次执行没有得到可交付结果。',
      nextActionText: '先看结果摘要和细节区，再决定是调整任务还是补环境条件。',
    }
  }

  return {
    kind: 'success',
    title: '任务已完成',
    summary: input.finalText?.trim() || '这次任务已经完成。',
    nextActionText: '先看摘要，再按需展开结果详情。',
  }
}

function readPermissionData(
  result: ToolResult,
):
  | {
      toolName?: string
      decision?: string
      riskLevel?: string
      reason?: string
      reviewStage?: string
      reviewSource?: string
      resourceScope?: string
      accessMode?: string
      targetPaths?: string[]
      inputSummary?: string
    }
  | undefined {
  const permission = readPermissionObject(result)
  if (!permission) {
    return undefined
  }

  const auditMetadata =
    typeof (permission as { auditMetadata?: unknown }).auditMetadata === 'object' &&
    (permission as { auditMetadata?: unknown }).auditMetadata !== null
      ? (permission as {
          auditMetadata: {
            pathAudit?: unknown
            desktopPermission?: {
              scopes?: unknown
              access?: unknown
            }
          }
        }).auditMetadata
      : undefined

  const pathAudit = Array.isArray(auditMetadata?.pathAudit)
    ? auditMetadata.pathAudit
    : []
  const targetPaths = pathAudit
    .map(item =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { path?: unknown }).path === 'string'
        ? (item as { path: string }).path
        : undefined,
    )
    .filter((value): value is string => Boolean(value))

  const resourceScope = Array.isArray(auditMetadata?.desktopPermission?.scopes)
    ? auditMetadata.desktopPermission.scopes.find(item => typeof item === 'string')
    : undefined
  const accessMode =
    typeof auditMetadata?.desktopPermission?.access === 'string'
      ? auditMetadata.desktopPermission.access
      : undefined

  return {
    toolName:
      typeof (permission as { toolName?: unknown }).toolName === 'string'
        ? (permission as { toolName: string }).toolName
        : undefined,
    decision:
      typeof (permission as { decision?: unknown }).decision === 'string'
        ? (permission as { decision: string }).decision
        : undefined,
    riskLevel:
      typeof (permission as { riskLevel?: unknown }).riskLevel === 'string'
        ? (permission as { riskLevel: string }).riskLevel
        : undefined,
    reason:
      typeof (permission as { reason?: unknown }).reason === 'string'
        ? (permission as { reason: string }).reason
        : undefined,
    reviewStage:
      typeof (permission as { reviewStage?: unknown }).reviewStage === 'string'
        ? (permission as { reviewStage: string }).reviewStage
        : undefined,
    reviewSource:
      typeof (permission as { reviewSource?: unknown }).reviewSource === 'string'
        ? (permission as { reviewSource: string }).reviewSource
        : undefined,
    resourceScope:
      typeof resourceScope === 'string' ? resourceScope : undefined,
    accessMode,
    targetPaths,
    inputSummary:
      typeof (permission as { inputSummary?: unknown }).inputSummary === 'string'
        ? (permission as { inputSummary: string }).inputSummary
        : undefined,
  }
}

function readPermissionObject(
  result: ToolResult,
): Record<string, unknown> | undefined {
  if (typeof result.data === 'object' && result.data !== null) {
    const permission = (result.data as { permission?: unknown }).permission
    if (typeof permission === 'object' && permission !== null) {
      return permission as Record<string, unknown>
    }
  }

  const firstAudit = Array.isArray(result.auditTrail)
    ? result.auditTrail[0]
    : undefined
  if (!firstAudit) {
    return undefined
  }

  return {
    toolName: 'tool',
    decision: firstAudit.decision,
    reason: firstAudit.reason,
    reviewStage: firstAudit.stage,
    reviewSource: firstAudit.source,
    auditMetadata: firstAudit.metadata,
    inputSummary: result.summary,
  }
}

function readVerificationData(
  result: ToolResult,
):
  | {
      passed?: boolean
      details?: string
    }
  | undefined {
  if (typeof result.data !== 'object' || result.data === null) {
    return undefined
  }

  const verification = (result.data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    return undefined
  }

  return {
    passed:
      typeof (verification as { passed?: unknown }).passed === 'boolean'
        ? (verification as { passed: boolean }).passed
        : undefined,
    details:
      typeof (verification as { details?: unknown }).details === 'string'
        ? (verification as { details: string }).details
        : undefined,
  }
}
