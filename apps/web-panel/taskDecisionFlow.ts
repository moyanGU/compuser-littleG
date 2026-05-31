import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import {
  buildDecisionPanelState,
  buildHomePanelState,
  createEmptyPanelState,
} from './panelState.js'
import type {
  ProductGovernanceView,
  ProductizationDecisionView,
  ScorecardSummaryView,
  SupportTemplateView,
  WindowsMcpStatusView,
} from './panelTypes.js'
import type { SessionRecord } from './sessionStore.js'
import { buildRecommendedTemplateViews } from './templateRecommendations.js'

interface TaskRule {
  templateId: string
  rewriteSuggestion: string
  title: string
  summary: string
  matches(text: string): boolean
  isStrong(text: string): boolean
}

export interface TaskDecisionFlowDependencies {
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

export type TaskDecisionResult =
  | {
      kind: 'accepted'
      sessionId: string
      state: SessionRecord['state']
    }
  | {
      kind: 'session_not_found'
    }
  | {
      kind: 'no_pending_decision'
    }
  | {
      kind: 'invalid_action'
    }

const TASK_RULES: TaskRule[] = [
  {
    templateId: 'browser-editor-chat-reply-template',
    title: '浏览器内容转成聊天回复',
    summary: '任务看起来落在“浏览器 -> 编辑整理 -> 聊天回复”模板内。',
    rewriteSuggestion:
      '请把当前浏览器页面里可见的稳定文本整理成回复，并发送到本地 Codex 或已确认的聊天窗口。',
    matches(text) {
      return includesAny(text, ['浏览器', '网页', '页面']) &&
        includesAny(text, ['聊天', '微信', '回复', '对话']) &&
        includesAny(text, ['发送', '发到', '回复', '整理'])
    },
    isStrong(text) {
      return includesAny(text, ['本地 codex', 'codex', '微信', '聊天窗口']) &&
        includesAny(text, ['整理', '回复', '发送', '发到'])
    },
  },
  {
    templateId: 'browser-doc-desktop-deliver-template',
    title: '浏览器文档投递到桌面目标',
    summary: '任务看起来落在“浏览器文档 -> 桌面投递”模板内。',
    rewriteSuggestion:
      '请把当前浏览器里的文档内容提取出来，并投递到本地 Codex 桌面窗口。',
    matches(text) {
      return includesAny(text, ['浏览器', '网页', '页面']) &&
        includesAny(text, ['文档', '文章', '内容']) &&
        includesAny(text, ['桌面', '窗口', 'codex']) &&
        includesAny(text, ['发送', '投递', '发到', '提交'])
    },
    isStrong(text) {
      return includesAny(text, ['文档', '文章']) &&
        includesAny(text, ['桌面', 'codex', '窗口']) &&
        includesAny(text, ['发送', '投递', '发到'])
    },
  },
  {
    templateId: 'file-browser-form-submit-template',
    title: '工作区文件提交到浏览器表单',
    summary: '任务看起来落在“文件 -> 浏览器表单提交”模板内。',
    rewriteSuggestion:
      '请读取工作区里的指定文件内容，并通过当前浏览器表单完成提交。',
    matches(text) {
      return includesAny(text, ['文件', '本地', '工作区']) &&
        includesAny(text, ['浏览器', '网页', '表单']) &&
        includesAny(text, ['提交', '上传', '填写', '发到'])
    },
    isStrong(text) {
      return includesAny(text, ['文件', '工作区']) &&
        includesAny(text, ['表单', '网页']) &&
        includesAny(text, ['提交', '上传'])
    },
  },
  {
    templateId: 'multi-window-compare-summarize-deliver-template',
    title: '多窗口对比后总结投递',
    summary: '任务看起来落在“多窗口对比 -> 总结 -> 投递”模板内。',
    rewriteSuggestion:
      '请对比至少两个可确认窗口中的内容，总结差异，并发送到本地 Codex 或已确认的聊天窗口。',
    matches(text) {
      return includesAny(text, ['多个窗口', '多窗口', '两个窗口', '对比', '比较']) &&
        includesAny(text, ['总结', '汇总', '差异']) &&
        includesAny(text, ['发送', '发到', '投递', '回复'])
    },
    isStrong(text) {
      return includesAny(text, ['两个窗口', '多窗口', '对比']) &&
        includesAny(text, ['总结', '汇总', '差异']) &&
        includesAny(text, ['codex', '聊天', '微信', '发送', '发到'])
    },
  },
  {
    templateId: 'browser-extract-transform-post-template',
    title: '浏览器提取后转换发布',
    summary: '任务看起来落在“浏览器提取 -> 转换 -> 发布”模板内。',
    rewriteSuggestion:
      '请提取当前浏览器页面中的稳定文本，完成整理或转换后，发送到本地 Codex 或已确认的聊天窗口。',
    matches(text) {
      return includesAny(text, ['浏览器', '网页', '页面']) &&
        includesAny(text, ['提取', '抓取', '整理', '转换', '改写']) &&
        includesAny(text, ['发布', '发送', '发到', '提交'])
    },
    isStrong(text) {
      return includesAny(text, ['提取', '抓取']) &&
        includesAny(text, ['整理', '转换', '改写']) &&
        includesAny(text, ['codex', '聊天', '微信', '发布', '发送'])
    },
  },
]

export function createTaskDecisionFlow(
  deps: TaskDecisionFlowDependencies,
) {
  async function decideTask(
    sessionId: string,
    task: string,
  ): Promise<TaskDecisionResult> {
    const context = await loadDecisionContext(sessionId, deps)
    const ruleMatches = TASK_RULES.filter(rule => rule.matches(task))
    const recommendedTemplates = context.recommendedTemplates

    let decision: ProductizationDecisionView
    if (ruleMatches.length !== 1) {
      decision = buildExplicitRejectDecision(context.governance)
    } else {
      const rule = ruleMatches[0]
      const templateView = recommendedTemplates.find(item => item.id === rule.templateId)
      if (!templateView) {
        decision = buildExplicitRejectDecision(context.governance)
      } else if (!rule.isStrong(task)) {
        decision = buildGuidedRewriteDecision(rule, templateView)
      } else if (templateView.readiness !== 'ready') {
        decision = buildEnvironmentUnreadyDecision(templateView, context.windowsMcpStatus)
      } else {
        decision = buildDirectExecuteDecision(rule, templateView, task)
      }
    }

    const baseRecord = context.record
    baseRecord.pendingDecision = decision
    baseRecord.task = task
    baseRecord.state = buildDecisionPanelState({
      baseState: {
        ...baseRecord.state,
        sessionId,
        submittedTask: task,
        recommendedTemplates,
        scorecardSummary: context.scorecardSummary,
        governance: context.governance,
        windowsMcpStatus: context.windowsMcpStatus,
      },
      decision,
      submittedTask: task,
    })
    deps.sessions.set(sessionId, baseRecord)
    return {
      kind: 'accepted',
      sessionId,
      state: baseRecord.state,
    }
  }

  async function applyDecisionAction(
    sessionId: string,
    actionId: string,
  ): Promise<TaskDecisionResult> {
    const record = deps.sessions.get(sessionId)
    if (!record) {
      return { kind: 'session_not_found' }
    }
    const decision = record.pendingDecision ?? record.state.decision
    if (!decision) {
      return { kind: 'no_pending_decision' }
    }

    const action = [
      decision.primaryAction,
      ...decision.secondaryActions,
    ].find(item => item.id === actionId)
    if (!action) {
      return { kind: 'invalid_action' }
    }

    if (action.kind === 'execute' || action.kind === 'rewrite_execute') {
      record.pendingDecision = undefined
      record.state = {
        ...record.state,
        decision: undefined,
        updatedAt: new Date().toISOString(),
      }
      const launchRecord = await deps.startTask(
        sessionId,
        action.taskOverride ?? record.task ?? record.state.submittedTask ?? '',
        decision.matchedTemplateId,
      )
      return {
        kind: 'accepted',
        sessionId,
        state: launchRecord.state,
      }
    }

    record.pendingDecision = undefined
    record.state = buildHomePanelState({
      ...record.state,
      decision: undefined,
      submittedTask: undefined,
    })
    deps.sessions.set(sessionId, record)
    return {
      kind: 'accepted',
      sessionId,
      state: record.state,
    }
  }

  async function dismissDecision(
    sessionId: string,
  ): Promise<TaskDecisionResult> {
    const record = deps.sessions.get(sessionId)
    if (!record) {
      return { kind: 'session_not_found' }
    }
    if (!record.pendingDecision && !record.state.decision) {
      return { kind: 'no_pending_decision' }
    }

    record.pendingDecision = undefined
    record.state = buildHomePanelState({
      ...record.state,
      decision: undefined,
      submittedTask: undefined,
    })
    deps.sessions.set(sessionId, record)
    return {
      kind: 'accepted',
      sessionId,
      state: record.state,
    }
  }

  return {
    decideTask,
    applyDecisionAction,
    dismissDecision,
  }
}

async function loadDecisionContext(
  sessionId: string,
  deps: TaskDecisionFlowDependencies,
) {
  const windowsMcpStatus = await deps.readWindowsMcpStatus(deps.windowsMcpService)
  const scorecardSummary = await deps.readScorecardSummary()
  const governance = deps.buildGovernanceView()
  const recommendedTemplates = buildRecommendedTemplateViews(
    windowsMcpStatus,
    deps.permissionMode,
    scorecardSummary,
  )
  const record =
    deps.sessions.get(sessionId) ??
    ({
      sessionId,
      state: {
        ...createEmptyPanelState(windowsMcpStatus),
        sessionId,
        recommendedTemplates,
        scorecardSummary,
        governance,
      },
      timeline: [],
    } satisfies SessionRecord)

  return {
    record,
    windowsMcpStatus,
    scorecardSummary,
    governance,
    recommendedTemplates,
  }
}

function includesAny(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase()
  return patterns.some(pattern => normalized.includes(pattern.toLowerCase()))
}

function buildDirectExecuteDecision(
  rule: TaskRule,
  templateView: SupportTemplateView,
  task: string,
): ProductizationDecisionView {
  return {
    kind: 'direct_execute',
    title: '可以直接进入执行',
    summary: rule.summary,
    reasonText: templateView.readinessReason ?? '当前模板前置检查已经通过。',
    actionText: '确认后才会真正开始执行。',
    matchedTemplateId: templateView.id,
    primaryAction: {
      id: 'decision-execute',
      label: '开始执行',
      kind: 'execute',
      taskOverride: task,
    },
    secondaryActions: [
      {
        id: 'decision-dismiss',
        label: '返回首页',
        kind: 'dismiss',
      },
    ],
  }
}

function buildGuidedRewriteDecision(
  rule: TaskRule,
  templateView: SupportTemplateView,
): ProductizationDecisionView {
  return {
    kind: 'guided_rewrite',
    title: '先把任务改写清楚再执行',
    summary: rule.summary,
    reasonText: '当前描述已经接近支持模板，但目标、来源或投递对象还不够明确。',
    actionText: '使用建议句式后，才会按固定模板进入执行。',
    matchedTemplateId: templateView.id,
    rewriteSuggestion: rule.rewriteSuggestion,
    primaryAction: {
      id: 'decision-rewrite-execute',
      label: '按建议继续',
      kind: 'rewrite_execute',
      taskOverride: rule.rewriteSuggestion,
    },
    secondaryActions: [
      {
        id: 'decision-dismiss',
        label: '返回首页',
        kind: 'dismiss',
      },
    ],
  }
}

function buildEnvironmentUnreadyDecision(
  templateView: SupportTemplateView,
  windowsMcpStatus: WindowsMcpStatusView,
): ProductizationDecisionView {
  const checklist = [
    ...(templateView.preflight?.checks.map(item => item.detail) ?? []),
    ...templateView.prerequisites,
    windowsMcpStatus.summary,
  ].filter(Boolean)

  return {
    kind: 'environment_unready',
    title: '现在还不能直接执行',
    summary: '任务落在已支持模板内，但当前环境信号还不满足执行条件。',
    reasonText: templateView.readinessReason ?? '前置检查没有通过。',
    actionText: '先补齐下面这些条件，再回首页重新发起。',
    matchedTemplateId: templateView.id,
    environmentChecklist: checklist,
    primaryAction: {
      id: 'decision-back-home',
      label: '返回首页',
      kind: 'dismiss',
    },
    secondaryActions: [
      {
        id: 'decision-view-supported-templates',
        label: '查看支持范围',
        kind: 'view_supported_templates',
      },
    ],
  }
}

function buildExplicitRejectDecision(
  governance: ProductGovernanceView,
): ProductizationDecisionView {
  const supportBoundarySummary = [
    ...(governance.ordinaryUserNotes ?? []).slice(-2),
    ...(governance.exclusions ?? []).slice(0, 2),
  ]

  return {
    kind: 'explicit_reject',
    title: '这个任务暂时不走普通用户入口',
    summary: '当前描述没有稳定命中已冻结的五个模板，或目标超出支持边界。',
    reasonText: '为了避免误投、误判或越界执行，这类任务不会直接启动。',
    actionText: '你可以回到首页改成支持模板内的任务，再重新发起。',
    supportBoundarySummary,
    primaryAction: {
      id: 'decision-dismiss',
      label: '返回首页',
      kind: 'dismiss',
    },
    secondaryActions: [
      {
        id: 'decision-view-supported-templates',
        label: '查看支持范围',
        kind: 'view_supported_templates',
      },
    ],
  }
}
