import {
  findSupportTemplateById,
  type SupportTemplateMetadata,
} from '../../packages/product/SupportMatrix.js'
import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import {
  buildDecisionPanelState,
  buildExecutingPanelState,
  createEmptyPanelState,
} from './panelState.js'
import type {
  PanelTimelineEvent,
  ProductGovernanceView,
  ScorecardSummaryView,
  SupportTemplateView,
  WindowsMcpStatusView,
} from './panelTypes.js'
import type { SessionRecord } from './sessionStore.js'
import {
  annotateTemplateReadiness,
  buildRecommendedTemplateViews,
  buildTemplateConfirmationNextAction,
  buildTemplateConfirmationReason,
} from './templateRecommendations.js'

type TemplatePreflight = NonNullable<SupportTemplateView['preflight']>

export interface TemplateLaunchFlowDependencies {
  sessions: Map<string, SessionRecord>
  windowsMcpService: WindowsMcpService
  permissionMode: PermissionMode
  readWindowsMcpStatus: (
    windowsMcpService: WindowsMcpService,
  ) => Promise<WindowsMcpStatusView>
  readScorecardSummary: () => Promise<ScorecardSummaryView | undefined>
  buildGovernanceView: () => ProductGovernanceView
  startTask: (
    sessionId: string,
    task: string,
    launchedTemplateId?: string,
  ) => Promise<SessionRecord>
}

export type TemplateLaunchRequestResult =
  | {
      kind: 'template_not_found'
    }
  | {
      kind: 'preflight_blocked'
      sessionId: string
      state: SessionRecord['state']
      preflight: TemplatePreflight
    }
  | {
      kind: 'requires_confirmation'
      sessionId: string
      state: SessionRecord['state']
    }
  | {
      kind: 'accepted'
      sessionId: string
      state: SessionRecord['state']
    }

export type TemplateLaunchDecisionResult =
  | {
      kind: 'no_pending_template_launch'
    }
  | {
      kind: 'accepted'
      sessionId: string
      state: SessionRecord['state']
      statusCode: 200 | 202
    }

export type TemplatePreflightResult =
  | {
      kind: 'template_not_found'
    }
  | {
      kind: 'ok'
      templateId: string
      preflight: TemplatePreflight
    }

export function createTemplateLaunchFlow(
  deps: TemplateLaunchFlowDependencies,
) {
  async function requestLaunch(
    templateId: string,
    requestedSessionId: unknown,
    fallbackSessionId: string,
  ): Promise<TemplateLaunchRequestResult> {
    const sessionId = resolveSessionId(requestedSessionId, fallbackSessionId)
    const template = findSupportTemplateById(templateId)
    if (!template || !template.recommendedForUi) {
      return { kind: 'template_not_found' }
    }

    const templateView = await readTemplateView(template)
    if (templateView.preflight?.status === 'blocked') {
      const record = await ensureBlockedTemplateDecision(
        sessionId,
        template,
        templateView,
      )
      return {
        kind: 'preflight_blocked',
        sessionId,
        state: record.state,
        preflight: templateView.preflight,
      }
    }

    if (templateView.preflight?.status === 'needs_attention') {
      const record = await ensurePendingTemplateLaunch(
        sessionId,
        template,
        templateView,
      )
      return {
        kind: 'requires_confirmation',
        sessionId,
        state: record.state,
      }
    }

    const record = await deps.startTask(
      sessionId,
      template.launchPrompt,
      template.id,
    )
    return {
      kind: 'accepted',
      sessionId,
      state: record.state,
    }
  }

  async function handleDecision(
    sessionId: string,
    decision: 'approve' | 'deny',
  ): Promise<TemplateLaunchDecisionResult> {
    const record = deps.sessions.get(sessionId)
    if (!record?.pendingTemplateLaunch) {
      return {
        kind: 'no_pending_template_launch',
      }
    }

    if (decision === 'deny') {
      const cancelEvent: PanelTimelineEvent = {
        title: '模板启动已取消',
        detail: `${record.pendingTemplateLaunch.templateId}: 用户拒绝了启动确认。`,
        status: 'warning',
      }
      record.timeline = [...record.timeline, cancelEvent].slice(-40)
      record.pendingTemplateLaunch = undefined
      record.state = {
        ...record.state,
        pendingTemplateLaunch: undefined,
        timeline: record.timeline,
        updatedAt: new Date().toISOString(),
      }
      if (record.state.debug) {
        record.state.debug.timeline = record.timeline
      }
      return {
        kind: 'accepted',
        sessionId,
        state: record.state,
        statusCode: 200,
      }
    }

    const pending = record.pendingTemplateLaunch
    record.pendingTemplateLaunch = undefined
    record.state = {
      ...record.state,
      pendingTemplateLaunch: undefined,
      updatedAt: new Date().toISOString(),
    }
    const launchRecord = await deps.startTask(
      sessionId,
      pending.launchTask,
      pending.templateId,
    )
    return {
      kind: 'accepted',
      sessionId,
      state: launchRecord.state,
      statusCode: 202,
    }
  }

  async function readPreflight(
    templateId: string,
  ): Promise<TemplatePreflightResult> {
    const template = findSupportTemplateById(templateId)
    if (!template || !template.recommendedForUi) {
      return { kind: 'template_not_found' }
    }

    const templateView = await readTemplateView(template)
    return {
      kind: 'ok',
      templateId,
      preflight: templateView.preflight!,
    }
  }

  async function readTemplateView(
    template: SupportTemplateMetadata,
  ): Promise<SupportTemplateView> {
    const windowsMcpStatus = await deps.readWindowsMcpStatus(
      deps.windowsMcpService,
    )
    const scorecardSummary = await deps.readScorecardSummary()
    return annotateTemplateReadiness(
      template,
      windowsMcpStatus,
      deps.permissionMode,
      scorecardSummary,
    )
  }

  async function ensurePendingTemplateLaunch(
    sessionId: string,
    template: SupportTemplateMetadata,
    templateView: SupportTemplateView,
  ): Promise<SessionRecord> {
    const windowsMcpStatus = await deps.readWindowsMcpStatus(
      deps.windowsMcpService,
    )
    const scorecardSummary = await deps.readScorecardSummary()
    const governance = deps.buildGovernanceView()
    const record = deps.sessions.get(sessionId) ?? {
      sessionId,
      state: {
        ...createEmptyPanelState(windowsMcpStatus),
        sessionId,
        recommendedTemplates: buildRecommendedTemplateViews(
          windowsMcpStatus,
          deps.permissionMode,
          scorecardSummary,
        ),
        scorecardSummary,
        governance,
      },
      timeline: [],
    }

    const pendingTemplateLaunch = {
      templateId: template.id,
      title: template.title,
      summary: templateView.preflight!.summary,
      whyConfirmation: buildTemplateConfirmationReason(templateView),
      nextActionSummary: buildTemplateConfirmationNextAction(template),
      checks: templateView.preflight!.checks,
    }
    record.pendingTemplateLaunch = {
      ...pendingTemplateLaunch,
      launchTask: template.launchPrompt,
    }
    record.state = buildExecutingPanelState({
      baseState: {
        ...record.state,
        currentStage: 'pending_confirmation',
        stageLabel: '等待确认',
        recommendedTemplates: buildRecommendedTemplateViews(
          windowsMcpStatus,
          deps.permissionMode,
          scorecardSummary,
        ),
        scorecardSummary,
        governance,
        windowsMcpStatus,
      },
      submittedTask: template.launchPrompt,
      launchedTemplateId: template.id,
      stageLabel: '等待确认',
      pendingTemplateLaunch,
    })
    const waitEvent: PanelTimelineEvent = {
      title: '模板启动等待确认',
      detail: `${template.id}: ${templateView.preflight!.summary}`,
      status: 'warning',
    }
    record.timeline = [...record.timeline, waitEvent].slice(-40)
    record.state.timeline = record.timeline
    if (record.state.debug) {
      record.state.debug.timeline = record.timeline
    }
    deps.sessions.set(sessionId, record)
    return record
  }

  async function ensureBlockedTemplateDecision(
    sessionId: string,
    template: SupportTemplateMetadata,
    templateView: SupportTemplateView,
  ): Promise<SessionRecord> {
    const windowsMcpStatus = await deps.readWindowsMcpStatus(
      deps.windowsMcpService,
    )
    const scorecardSummary = await deps.readScorecardSummary()
    const governance = deps.buildGovernanceView()
    const record = deps.sessions.get(sessionId) ?? {
      sessionId,
      state: {
        ...createEmptyPanelState(windowsMcpStatus),
        sessionId,
        recommendedTemplates: buildRecommendedTemplateViews(
          windowsMcpStatus,
          deps.permissionMode,
          scorecardSummary,
        ),
        scorecardSummary,
        governance,
      },
      timeline: [],
    }

    const checklist = [
      ...(templateView.preflight?.checks.map(item => item.detail) ?? []),
      ...template.prerequisites,
      windowsMcpStatus.summary,
    ].filter(Boolean)
    record.pendingDecision = {
      kind: 'environment_unready',
      title: '这个模板现在还不能直接执行',
      summary: templateView.preflight?.summary ?? '当前环境没有通过执行前检查。',
      reasonText:
        templateView.readinessReason ?? '当前环境信号还不满足模板启动条件。',
      actionText: '先补齐条件，再回首页重新发起。',
      matchedTemplateId: template.id,
      environmentChecklist: checklist,
      primaryAction: {
        id: 'decision-back-home',
        label: '返回首页',
        kind: 'dismiss',
      },
      secondaryActions: [],
    }
    record.state = buildDecisionPanelState({
      baseState: {
        ...record.state,
        submittedTask: template.launchPrompt,
        launchedTemplateId: template.id,
        recommendedTemplates: buildRecommendedTemplateViews(
          windowsMcpStatus,
          deps.permissionMode,
          scorecardSummary,
        ),
        scorecardSummary,
        governance,
        windowsMcpStatus,
      },
      decision: record.pendingDecision,
      submittedTask: template.launchPrompt,
    })
    deps.sessions.set(sessionId, record)
    return record
  }

  return {
    requestLaunch,
    handleDecision,
    readPreflight,
  }
}

function resolveSessionId(
  requestedSessionId: unknown,
  fallbackSessionId: string,
): string {
  return typeof requestedSessionId === 'string' && requestedSessionId.trim()
    ? requestedSessionId.trim()
    : fallbackSessionId
}
