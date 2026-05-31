import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import {
  listRecommendedSupportTemplates,
  type SupportTemplateMetadata,
} from '../../packages/product/SupportMatrix.js'
import type {
  ScorecardSummaryView,
  SupportTemplateView,
  WindowsMcpStatusView,
} from './panelTypes.js'

export function buildRecommendedTemplateViews(
  windowsMcpStatus: WindowsMcpStatusView,
  permissionMode: PermissionMode,
  scorecardSummary: ScorecardSummaryView | undefined,
): SupportTemplateView[] {
  return listRecommendedSupportTemplates().map(template =>
    annotateTemplateReadiness(template, windowsMcpStatus, permissionMode, scorecardSummary),
  )
}

export function annotateTemplateReadiness(
  template: SupportTemplateMetadata,
  windowsMcpStatus: WindowsMcpStatusView,
  permissionMode: PermissionMode,
  scorecardSummary: ScorecardSummaryView | undefined,
): SupportTemplateView {
  const scorecardHealth = buildTemplateScorecardHealth(template.id, scorecardSummary)
  const withTier = (view: SupportTemplateView): SupportTemplateView =>
    applyRecommendationTier(view)

  if (permissionMode === 'read-only') {
    return withTier({
      ...template,
      launchPrompt: template.launchPrompt,
      readiness: 'blocked',
      readinessReason: '当前是只读保护模式，所以这类需要发出去的模板先不能跑。',
      scorecardHealth,
    })
  }

  if (!scorecardSummary?.totals) {
    return withTier({
      ...template,
      launchPrompt: template.launchPrompt,
      readiness: 'attention',
      readinessReason: '现在还没拿到最近稳定度摘要，建议先别急着点。',
      scorecardHealth,
    })
  }

  if (
    windowsMcpStatus.state === 'failed' ||
    windowsMcpStatus.state === 'disconnected'
  ) {
    return withTier({
      ...template,
      launchPrompt: template.launchPrompt,
      readiness: 'blocked',
      readinessReason: '现在还连不上桌面服务，所以这类桌面任务先不能跑。',
      scorecardHealth,
    })
  }

  if (
    windowsMcpStatus.state === 'starting' ||
    windowsMcpStatus.state === 'degraded'
  ) {
    return withTier({
      ...template,
      launchPrompt: template.launchPrompt,
      readiness: 'attention',
      readinessReason: '桌面服务正在准备，还没稳到适合直接开始。',
      scorecardHealth,
    })
  }

  if (template.family === 'multi_window') {
    if (
      typeof windowsMcpStatus.windowCount === 'number' &&
      windowsMcpStatus.windowCount < 2
    ) {
      return withTier({
        ...template,
        launchPrompt: template.launchPrompt,
        readiness: 'attention',
        readinessReason: '多窗口任务至少要先看见两个能分清的窗口，现在还不够。',
        scorecardHealth,
      })
    }

    if (
      typeof windowsMcpStatus.observationConfidence === 'number' &&
      windowsMcpStatus.observationConfidence < 0.6
    ) {
      return withTier({
        ...template,
        launchPrompt: template.launchPrompt,
        readiness: 'attention',
        readinessReason: '现在对多个窗口的把握还不够高，直接跑容易投错。',
        scorecardHealth,
      })
    }
  }

  if (template.family === 'browser') {
    if (
      typeof windowsMcpStatus.observationConfidence === 'number' &&
      windowsMcpStatus.observationConfidence < 0.5
    ) {
      return withTier({
        ...template,
        launchPrompt: template.launchPrompt,
        readiness: 'attention',
        readinessReason: '现在对浏览器页面的把握还不够高，先别急着让它继续。',
        scorecardHealth,
      })
    }

    return withTier({
      ...template,
      launchPrompt: template.launchPrompt,
      readiness: 'ready',
      readinessReason: '浏览器相关前提看起来都还不错，可以试着直接跑。',
      scorecardHealth,
    })
  }

  if (template.family === 'file') {
    return withTier({
      ...template,
      launchPrompt: template.launchPrompt,
      readiness: 'ready',
      readinessReason: '只要发出内容的权限还在，工作区文件类任务通常可以直接试。',
      scorecardHealth,
    })
  }

  return withTier({
    ...template,
    launchPrompt: template.launchPrompt,
    readiness: 'ready',
    readinessReason: '当前信号看起来比较稳，可以试着跑这个模板。',
    scorecardHealth,
  })
}

export function buildTemplateConfirmationReason(
  view: SupportTemplateView,
): string {
  const warnChecks =
    view.preflight?.checks.filter(check => check.status === 'warn') ?? []

  if (warnChecks.some(check => check.category === 'permissions')) {
    return '这次启动可能会碰到保护边界，所以真正发出去前会先停下来问你。'
  }

  if (warnChecks.some(check => check.category === 'sensitive_target')) {
    return '这次启动可能会碰到容易投错的目标，所以会先让你确认目标再继续。'
  }

  if (warnChecks.some(check => check.category === 'environment')) {
    return '现在环境不是最理想，所以面板会先提醒你这次可能需要多看一眼。'
  }

  return '启动前有几件事值得你先看一下。'
}

export function buildTemplateConfirmationNextAction(
  template: SupportTemplateMetadata,
): string {
  switch (template.id) {
    case 'browser-doc-desktop-deliver-template':
      return '如果继续，它会按已经验证过的路径，把浏览器里的内容送到桌面目标；如果后面还碰到敏感写入，会再停下来问你。'
    case 'multi-window-compare-summarize-deliver-template':
      return '如果继续，它会先看清多个窗口，再选准目标，只有在对比结果还能核对时才继续发出去。'
    default:
      return '如果继续，它会按已经验证过的模板往下做，中途如果再碰到保护门槛，还会继续停下来问你。'
  }
}

function buildTemplateScorecardHealth(
  templateId: string,
  scorecardSummary: ScorecardSummaryView | undefined,
): NonNullable<SupportTemplateView['scorecardHealth']> {
  const templateTotals = scorecardSummary?.templateTotals?.[templateId]
  if (!templateTotals) {
    return {
      totalRuns: 0,
      pass: 0,
      verificationFailed: 0,
      executionFailed: 0,
      routingFailed: 0,
      environmentUnready: 0,
      label: 'unknown',
      summary: '这个模板最近还没有可展示的稳定度样本。',
    }
  }

  const totalRuns = readScoreValue(templateTotals.total_runs)
  const pass = readScoreValue(templateTotals.pass)
  const verificationFailed = readScoreValue(templateTotals.verification_failed)
  const executionFailed = readScoreValue(templateTotals.execution_failed)
  const routingFailed = readScoreValue(templateTotals.routing_failed)
  const environmentUnready = readScoreValue(templateTotals.environment_unready)
  const label =
    verificationFailed === 0 && executionFailed === 0 && routingFailed === 0
      ? 'healthy'
      : 'warning'

  return {
    totalRuns,
    pass,
    verificationFailed,
    executionFailed,
    routingFailed,
    environmentUnready,
    label,
    summary:
      `运行=${totalRuns} 通过=${pass} 验证失败=${verificationFailed} ` +
      `执行失败=${executionFailed} 路由失败=${routingFailed} 环境未就绪=${environmentUnready}`,
  }
}

function readScoreValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function applyRecommendationTier(view: SupportTemplateView): SupportTemplateView {
  const preflight = buildTemplatePreflight(view)

  if (view.readiness === 'blocked') {
    return {
      ...view,
      recommendationTier: 'not_recommended',
      recommendationReason: '当前信号不够稳，现在不建议把这个模板放到前面让你点。',
      preflight,
    }
  }

  if (view.readiness === 'ready' && view.scorecardHealth?.label === 'healthy') {
    return {
      ...view,
      recommendationTier: 'priority',
      recommendationReason: '这个模板现在最稳，最适合优先点。',
      preflight,
    }
  }

  return {
    ...view,
    recommendationTier: 'caution',
    recommendationReason: '这个模板大概率能跑，但你最好先看一眼当前环境提示。',
    preflight,
  }
}

function buildTemplatePreflight(
  view: SupportTemplateView,
): NonNullable<SupportTemplateView['preflight']> {
  const checks: NonNullable<SupportTemplateView['preflight']>['checks'] = []

  checks.push({
    category: 'environment',
    name: 'readiness',
    status:
      view.readiness === 'ready'
        ? 'pass'
        : view.readiness === 'attention'
          ? 'warn'
          : 'fail',
    detail: view.readinessReason ?? '当前没有就绪原因说明。',
  })

  checks.push({
    category: 'scorecard',
    name: 'scorecard',
    status: view.scorecardHealth?.label === 'healthy' ? 'pass' : 'warn',
    detail: view.scorecardHealth?.summary ?? '当前没有模板级 scorecard 摘要。',
  })

  checks.push({
    category: 'template_prerequisite',
    name: 'prerequisites',
    status: view.prerequisites.length > 0 ? 'warn' : 'pass',
    detail:
      view.prerequisites.length > 0
        ? ['启动前请先检查这些前提条件:', view.prerequisites.join(' ')].join(' ')
        : '没有额外前提条件。',
  })

  if (view.id === 'browser-doc-desktop-deliver-template') {
    checks.push({
      category: 'permissions',
      name: 'desktop_confirmation',
      status: 'warn',
      detail: '这条链可能会把内容送到桌面敏感窗口，所以真正写入前大概率还会再问你一次。',
    })
    checks.push({
      category: 'sensitive_target',
      name: 'desktop_target_sensitivity',
      status: 'warn',
      detail: '只有当目标窗口明显就是你想投递的那个，才应该继续。',
    })
  }

  const hasFail = checks.some(check => check.status === 'fail')
  const hasWarn = checks.some(check => check.status === 'warn')

  return {
    status: hasFail ? 'blocked' : hasWarn ? 'needs_attention' : 'ready',
    summary: hasFail
      ? '按当前环境看，这个模板现在先别启动。'
      : hasWarn
        ? '启动前还有几件事值得你先看一眼。'
        : '启动前检查已经通过，可以直接开始。',
    checks,
  }
}
