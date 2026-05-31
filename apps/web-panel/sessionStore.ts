import type { ProductizationPanelState, PanelTimelineEvent } from './panelTypes.js'
import type { PendingPermissionView, PendingTemplateLaunchView } from './panelTypes.js'
import type { PermissionPrompt } from '../../packages/security/PermissionPolicy.js'
import type { ProductizationDecisionView } from './panelTypes.js'

export interface PendingPermissionRecord {
  id: string
  request: Parameters<PermissionPrompt['confirm']>[0]
  resolve: (
    decision: Awaited<ReturnType<PermissionPrompt['confirm']>>,
  ) => void
}

export interface PendingTemplateLaunchRecord {
  templateId: string
  launchTask: string
  title: string
  summary: string
  whyConfirmation: string
  nextActionSummary: string
  checks: NonNullable<PendingTemplateLaunchView['checks']>
}

export interface SessionRecord {
  sessionId: string
  task?: string
  state: ProductizationPanelState
  timeline: PanelTimelineEvent[]
  currentRun?: Promise<void>
  abortController?: AbortController
  pendingPermission?: PendingPermissionRecord
  pendingTemplateLaunch?: PendingTemplateLaunchRecord
  pendingDecision?: ProductizationDecisionView
}
