import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import type { PermissionGrantScope } from '../../packages/security/PermissionPolicy.js'
import type { CliModelProvider } from '../cli/cliApp.js'

export interface PanelTaskOptions {
  windowsMcpEndpoint?: string
  permissionMode?: PermissionMode
  modelProvider?: CliModelProvider
  recommendedTemplates?: SupportTemplateView[]
  scorecardSummary?: ScorecardSummaryView
  governance?: ProductGovernanceView
  supportBoundary?: SupportBoundaryView
}

export interface PanelTaskAttachment {
  name: string
  mimeType: string
  base64: string
}

export interface PanelSessionTaskResponse {
  sessionId: string
  state: ProductizationPanelState
}

export interface SupportTemplateView {
  id: string
  family: string
  capabilityName: string
  title: string
  description: string
  launchPreview?: string
  likelyPauseReason?: string
  supportStatus: string
  scorecardIncluded: boolean
  recommendedForUi: boolean
  prerequisites: string[]
  verificationSources: string[]
  frozenClaim: string
  launchPrompt?: string
  supportedWindowClasses?: string[]
  verifiedEnvironment?: string[]
  claimBoundary?: string
  readiness?: 'ready' | 'attention' | 'blocked'
  readinessReason?: string
  recommendationTier?: 'priority' | 'caution' | 'not_recommended'
  recommendationReason?: string
  preflight?: {
    status: 'ready' | 'needs_attention' | 'blocked'
    summary: string
    checks: Array<{
      category:
        | 'environment'
        | 'permissions'
        | 'scorecard'
        | 'template_prerequisite'
        | 'sensitive_target'
      name: string
      status: 'pass' | 'warn' | 'fail'
      detail: string
    }>
  }
  scorecardHealth?: {
    totalRuns: number
    pass: number
    verificationFailed: number
    executionFailed: number
    routingFailed: number
    environmentUnready: number
    label: 'healthy' | 'warning' | 'unknown'
    summary: string
  }
}

export interface SupportBoundaryView {
  machineScope: string
  endpointScope: string
  templateScope: string
  supportedWindowClasses: string[]
  notes: string[]
}

export interface ProductGovernanceView {
  supportMatrixPath: string
  scorecardArtifactPath: string
  permissionDefaults: Array<{
    scope: string
    access: string
    decision: string
    note: string
  }>
  exclusions: string[]
  ordinaryUserNotes: string[]
  supportBoundary?: SupportBoundaryView
}

export interface ScorecardSummaryView {
  generatedAt?: string
  endpoint?: string
  permissionMode?: string
  totals: Record<string, number>
  templateTotals: Record<string, Record<string, number>>
  familyTotals: Record<string, Record<string, number>>
  claimThresholds?: {
    targetPassRate?: number
    minTemplateRuns?: number
    weakTemplateTopUpTriggerRuns?: number
    weakTemplateTopUpTargetRuns?: number
    gateMode?: string
  }
  assessments?: {
    templates?: Record<
      string,
      {
        family?: string
        totals?: Record<string, number>
        claim?: {
          totalRuns?: number
          passCount?: number
          nonPassCount?: number
          passRate?: number
          sampleTarget?: number
          sampleGateMet?: boolean
          passRateGateMet?: boolean
          regressionFailureCount?: number
          infrastructureFailureCount?: number
          evidenceGapCount?: number
          claimGate?: 'pass' | 'fail' | 'insufficient_evidence'
          reasonCodes?: string[]
        }
      }
    >
    families?: Record<
      string,
      {
        templateCount?: number
        totals?: Record<string, number>
        claim?: {
          totalRuns?: number
          passCount?: number
          nonPassCount?: number
          passRate?: number
          sampleTarget?: number
          sampleGateMet?: boolean
          passRateGateMet?: boolean
          regressionFailureCount?: number
          infrastructureFailureCount?: number
          evidenceGapCount?: number
          claimGate?: 'pass' | 'fail' | 'insufficient_evidence'
          reasonCodes?: string[]
        }
      }
    >
    overall?: {
      totals?: Record<string, number>
      claim?: {
        totalRuns?: number
        passCount?: number
        nonPassCount?: number
        passRate?: number
        sampleTarget?: number
        sampleGateMet?: boolean
        passRateGateMet?: boolean
        regressionFailureCount?: number
        infrastructureFailureCount?: number
        evidenceGapCount?: number
        claimGate?: 'pass' | 'fail' | 'insufficient_evidence'
        reasonCodes?: string[]
      }
      templateGatePassCount?: number
      templateGateFailCount?: number
      templateGateInsufficientCount?: number
      overallClaimGate?: 'pass' | 'fail' | 'insufficient_evidence'
      reasonCodes?: string[]
    }
  }
  topUpPlan?: {
    status?: string
    triggerSuiteRuns?: number
    currentSuiteRuns?: number
    targetTemplateRuns?: number
    runnerGranularity?: string
    candidateCount?: number
    additionalFullSuiteRunsNeeded?: number
  }
  control?: {
    cooldownCount: number
    serviceRestartCount: number
    healthcheckCount: number
    earlyStopReason: string
  }
}

export interface PanelSummaryCard {
  title: string
  value: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}

export interface PanelRouteCard {
  route: string
  title: string
  reason: string
  status: string
}

export interface PanelTimelineEvent {
  title: string
  detail: string
  status: 'info' | 'success' | 'warning' | 'danger'
}

export interface PanelPermissionEvent {
  toolName: string
  decision: string
  riskLevel: string
  reason: string
  reviewStage: string
  resourceScope?: string
  accessMode?: string
  targetPaths?: string[]
}

export interface PanelVerificationItem {
  summary: string
  status: 'success' | 'warning' | 'danger'
}

export interface PanelToolResultItem {
  toolName: string
  ok: boolean
  summary: string
  failureClass?: string
  pointer?: string
  rawData?: unknown
  error?: string
}

export interface WindowsMcpStatusView {
  mode: 'stub' | 'endpoint'
  state: 'disconnected' | 'starting' | 'ready' | 'degraded' | 'failed'
  endpoint?: string
  reachable: boolean
  summary: string
  detail?: string
  focusedWindow?: string
  windowCount?: number
  observationConfidence?: number
  checkedAt?: string
  configPath?: string
  launchedByService?: boolean
  reusedExistingEndpoint?: boolean
  pid?: number
  error?: string
}

export interface PendingPermissionView {
  id: string
  toolName: string
  riskLevel: string
  reason: string
  reviewStage: string
  reviewSource?: string
  resourceScope?: string
  accessMode?: string
  targetPaths: string[]
  inputSummary: string
  availableGrantScopes: PermissionGrantScope[]
}

export interface PendingTemplateLaunchView {
  templateId: string
  title: string
  summary: string
  whyConfirmation: string
  nextActionSummary: string
  checks: Array<{
    category:
      | 'environment'
      | 'permissions'
      | 'scorecard'
      | 'template_prerequisite'
      | 'sensitive_target'
    name: string
    status: 'pass' | 'warn' | 'fail'
    detail: string
  }>
}

export type ProductizationPanelView =
  | 'home'
  | 'decision'
  | 'executing'
  | 'result'

export interface ProductizationDecisionAction {
  id: string
  label: string
  kind:
    | 'execute'
    | 'rewrite_execute'
    | 'dismiss'
    | 'view_supported_templates'
  taskOverride?: string
}

export interface ProductizationDecisionView {
  kind:
    | 'direct_execute'
    | 'guided_rewrite'
    | 'environment_unready'
    | 'explicit_reject'
  title: string
  summary: string
  reasonText: string
  actionText: string
  primaryAction: ProductizationDecisionAction
  secondaryActions: ProductizationDecisionAction[]
  matchedTemplateId?: string
  rewriteSuggestion?: string
  environmentChecklist?: string[]
  supportBoundarySummary?: string[]
}

export interface ProductizationResultView {
  kind: 'success' | 'failure' | 'aborted'
  title: string
  summary: string
  nextActionText: string
}

export interface ProductizationDebugState {
  planSummary: PanelSummaryCard[]
  routeCards: PanelRouteCard[]
  timeline: PanelTimelineEvent[]
  permissionEvents: PanelPermissionEvent[]
  verification: PanelVerificationItem[]
  results: PanelToolResultItem[]
  scorecardSummary?: ScorecardSummaryView
  governance?: ProductGovernanceView
}

export interface ProductizationPanelState {
  sessionId?: string
  submittedTask?: string
  launchedTemplateId?: string
  view: ProductizationPanelView
  decision?: ProductizationDecisionView
  result?: ProductizationResultView
  debug?: ProductizationDebugState
  currentStage: string
  stageLabel: string
  isRunning?: boolean
  stopReason?: string
  emergencyStopAvailable?: boolean
  finalText?: string
  selectedRoute?: string
  recoveryPoint?: string
  planSummary: PanelSummaryCard[]
  routeCards: PanelRouteCard[]
  timeline: PanelTimelineEvent[]
  permissionEvents: PanelPermissionEvent[]
  pendingPermission?: PendingPermissionView
  pendingTemplateLaunch?: PendingTemplateLaunchView
  verification: PanelVerificationItem[]
  results: PanelToolResultItem[]
  recommendedTemplates?: SupportTemplateView[]
  scorecardSummary?: ScorecardSummaryView
  governance?: ProductGovernanceView
  supportBoundary?: SupportBoundaryView
  windowsMcpStatus: WindowsMcpStatusView
  updatedAt: string
}
