import { listVerifiedSupportTemplates, SUPPORT_MATRIX_EXCLUSIONS } from '../../packages/product/SupportMatrix.js'
import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import type {
  ProductGovernanceView,
  ScorecardSummaryView,
  WindowsMcpStatusView,
} from './panelTypes.js'
import type { SessionRecord } from './sessionStore.js'
import { buildRecommendedTemplateViews } from './templateRecommendations.js'

export interface SystemProductFlowDependencies {
  sessions: Map<string, SessionRecord>
  windowsMcpService: WindowsMcpService
  permissionMode: PermissionMode
  readWindowsMcpStatus: (
    windowsMcpService: WindowsMcpService,
  ) => Promise<WindowsMcpStatusView>
  readScorecardSummary: () => Promise<ScorecardSummaryView | undefined>
  buildGovernanceView: () => ProductGovernanceView
  mapRestartStatus: (
    status: Awaited<ReturnType<WindowsMcpService['restart']>>,
  ) => WindowsMcpStatusView
}

export function createSystemProductFlow(
  deps: SystemProductFlowDependencies,
) {
  async function readWindowsMcpStatus() {
    return await deps.readWindowsMcpStatus(deps.windowsMcpService)
  }

  async function readSupportMatrix() {
    return {
      templates: listVerifiedSupportTemplates(),
      exclusions: SUPPORT_MATRIX_EXCLUSIONS,
    }
  }

  async function readScorecardSummary() {
    return {
      scorecard: await deps.readScorecardSummary(),
    }
  }

  async function readGovernance() {
    return deps.buildGovernanceView()
  }

  async function restartWindowsMcp() {
    const status = await deps.windowsMcpService.restart()
    const view = deps.mapRestartStatus(status)
    const scorecardSummary = await deps.readScorecardSummary()

    for (const record of deps.sessions.values()) {
      record.state = {
        ...record.state,
        recommendedTemplates: buildRecommendedTemplateViews(
          view,
          deps.permissionMode,
          scorecardSummary,
        ),
        scorecardSummary,
        governance: deps.buildGovernanceView(),
        windowsMcpStatus: view,
        updatedAt: new Date().toISOString(),
      }
    }

    return view
  }

  return {
    readWindowsMcpStatus,
    readSupportMatrix,
    readScorecardSummary,
    readGovernance,
    restartWindowsMcp,
  }
}
