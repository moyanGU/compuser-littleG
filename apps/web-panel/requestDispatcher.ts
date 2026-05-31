import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { CLI_WORKSPACE_ROOT } from '../cli/workspaceRoot.js'
import {
  PANEL_DEFAULT_SESSION_ID,
  PANEL_PUBLIC_DIR,
  PANEL_UPLOADS_DIR,
} from './defaults.js'
import {
  parseDecisionActionPayload,
  parsePermissionDecisionPayload,
  parseTemplateLaunchDecisionPayload,
  readJsonBody,
  respondCss,
  respondHtml,
  respondJavaScript,
  respondJson,
} from './httpTypes.js'
import { parseTaskSubmissionPayload } from './taskSubmission.js'
import { buildTaskWithAttachments } from './uploads.js'
import type { WebPanelServerOptions } from './serverOptions.js'
import type { WebPanelRuntime } from './serverRuntime.js'

export async function handleWebPanelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebPanelServerOptions,
  runtime: WebPanelRuntime,
) {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? '127.0.0.1'}`,
  )
  const pathname = url.pathname

  if (request.method === 'GET' && pathname === '/') {
    respondHtml(response, await readStaticAsset('index.html'))
    return
  }

  if (request.method === 'GET' && pathname === '/app.js') {
    respondJavaScript(response, await readStaticAsset('app.js'))
    return
  }

  if (request.method === 'GET' && pathname === '/styles.css') {
    respondCss(response, await readStaticAsset('styles.css'))
    return
  }

  if (request.method === 'GET' && pathname === '/api/state') {
    const record = await runtime.sessionOrchestrator.refreshSessionState(
      PANEL_DEFAULT_SESSION_ID,
    )
    respondJson(response, 200, record.state)
    return
  }

  if (request.method === 'GET' && pathname === '/api/windows-mcp-status') {
    respondJson(
      response,
      200,
      await runtime.systemProductFlow.readWindowsMcpStatus(),
    )
    return
  }

  if (request.method === 'POST' && pathname === '/api/task') {
    const payload = await readJsonBody(request)
    const { task, attachments, sessionId } = parseTaskSubmissionPayload(
      payload,
      PANEL_DEFAULT_SESSION_ID,
    )
    if (!task && attachments.length === 0) {
      respondJson(response, 400, {
        error: '请先输入任务内容，或上传至少一个附件。',
      })
      return
    }

    const preparedTask = await buildTaskWithAttachments({
      task,
      attachments,
      sessionId,
      uploadsRoot: PANEL_UPLOADS_DIR,
      workspaceRoot: CLI_WORKSPACE_ROOT,
    })
    const record = await runtime.sessionOrchestrator.startTask(
      sessionId,
      preparedTask,
      {
        windowsMcpEndpoint: options.windowsMcpEndpoint,
        permissionMode: options.permissionMode,
        modelProvider: options.defaultModelProvider,
        modelBaseUrl: options.modelBaseUrl,
        modelApiKey: options.modelApiKey,
        modelName: options.modelName,
        modelTemperature: options.modelTemperature,
        modelMaxTokens: options.modelMaxTokens,
        modelTimeoutMs: options.modelTimeoutMs,
        modelStream: options.modelStream,
        modelMaxRetries: options.modelMaxRetries,
        modelRetryDelayMs: options.modelRetryDelayMs,
        modelCompatibilityMode: options.modelCompatibilityMode,
      },
    )
    respondJson(response, 202, {
      sessionId,
      state: record.state,
      accepted: true,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/session/task') {
    const payload = await readJsonBody(request)
    const { task, attachments, sessionId } = parseTaskSubmissionPayload(
      payload,
      PANEL_DEFAULT_SESSION_ID,
    )
    if (!task && attachments.length === 0) {
      respondJson(response, 400, {
        error: '请先输入任务内容，或上传至少一个附件。',
      })
      return
    }

    const preparedTask = await buildTaskWithAttachments({
      task,
      attachments,
      sessionId,
      uploadsRoot: PANEL_UPLOADS_DIR,
      workspaceRoot: CLI_WORKSPACE_ROOT,
    })
    const record = await runtime.sessionOrchestrator.startTask(
      sessionId,
      preparedTask,
      {
        windowsMcpEndpoint: options.windowsMcpEndpoint,
        permissionMode: options.permissionMode,
        modelProvider: options.defaultModelProvider,
        modelBaseUrl: options.modelBaseUrl,
        modelApiKey: options.modelApiKey,
        modelName: options.modelName,
        modelTemperature: options.modelTemperature,
        modelMaxTokens: options.modelMaxTokens,
        modelTimeoutMs: options.modelTimeoutMs,
        modelStream: options.modelStream,
        modelMaxRetries: options.modelMaxRetries,
        modelRetryDelayMs: options.modelRetryDelayMs,
        modelCompatibilityMode: options.modelCompatibilityMode,
      },
    )
    respondJson(response, 202, {
      sessionId,
      state: record.state,
      accepted: true,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/session/task-decision') {
    const payload = await readJsonBody(request)
    const { task, attachments, sessionId } = parseTaskSubmissionPayload(
      payload,
      PANEL_DEFAULT_SESSION_ID,
    )
    if (!task && attachments.length === 0) {
      respondJson(response, 400, {
        error: '请先输入任务内容，或上传至少一个附件。',
      })
      return
    }

    const preparedTask = await buildTaskWithAttachments({
      task,
      attachments,
      sessionId,
      uploadsRoot: PANEL_UPLOADS_DIR,
      workspaceRoot: CLI_WORKSPACE_ROOT,
    })
    const result = await runtime.taskDecisionFlow.decideTask(
      sessionId,
      preparedTask,
    )
    if (result.kind !== 'accepted') {
      respondJson(response, 500, { error: result.kind })
      return
    }
    respondJson(response, 202, {
      sessionId,
      accepted: true,
      state: result.state,
    })
    return
  }

  const templateLaunchMatch = pathname.match(
    /^\/product\/templates\/([^/]+)\/launch$/u,
  )
  if (request.method === 'POST' && templateLaunchMatch) {
    const templateId = decodeURIComponent(templateLaunchMatch[1])
    const payload = await readJsonBody(request)
    const payloadSession =
      typeof payload === 'object' && payload !== null
        ? (payload as { sessionId?: unknown }).sessionId
        : undefined
    const launchResult = await runtime.templateLaunchFlow.requestLaunch(
      templateId,
      payloadSession,
      PANEL_DEFAULT_SESSION_ID,
    )
    if (launchResult.kind === 'template_not_found') {
      respondJson(response, 404, {
        error: '没有找到这个模板，或它不在普通用户可启动范围内。',
      })
      return
    }

    if (launchResult.kind === 'preflight_blocked') {
      respondJson(response, 409, {
        sessionId: launchResult.sessionId,
        state: launchResult.state,
        error: 'template_preflight_blocked',
        preflight: launchResult.preflight,
      })
      return
    }

    if (launchResult.kind === 'requires_confirmation') {
      respondJson(response, 202, {
        sessionId: launchResult.sessionId,
        state: launchResult.state,
        requiresConfirmation: true,
      })
      return
    }

    respondJson(response, 202, {
      sessionId: launchResult.sessionId,
      state: launchResult.state,
      accepted: true,
    })
    return
  }

  const templateDecisionMatch = pathname.match(
    /^\/session\/([^/]+)\/template-launch-decision$/u,
  )
  if (request.method === 'POST' && templateDecisionMatch) {
    const sessionId = decodeURIComponent(templateDecisionMatch[1])
    const payload = await readJsonBody(request)
    const { decision } = parseTemplateLaunchDecisionPayload(payload)
    if (!decision) {
      respondJson(response, 400, { error: 'decision must be approve or deny' })
      return
    }

    const decisionResult = await runtime.templateLaunchFlow.handleDecision(
      sessionId,
      decision,
    )
    if (decisionResult.kind === 'no_pending_template_launch') {
      respondJson(response, 404, { error: 'no_pending_template_launch' })
      return
    }

    respondJson(response, decisionResult.statusCode, {
      sessionId,
      accepted: true,
      state: decisionResult.state,
    })
    return
  }

  const decisionActionMatch = pathname.match(
    /^\/session\/([^/]+)\/decision-action$/u,
  )
  if (request.method === 'POST' && decisionActionMatch) {
    const sessionId = decodeURIComponent(decisionActionMatch[1])
    const payload = await readJsonBody(request)
    const { actionId } = parseDecisionActionPayload(payload)
    if (!actionId) {
      respondJson(response, 400, { error: 'actionId is required' })
      return
    }

    const actionResult = await runtime.taskDecisionFlow.applyDecisionAction(
      sessionId,
      actionId,
    )
    if (actionResult.kind === 'session_not_found') {
      respondJson(response, 404, { error: 'session_not_found' })
      return
    }
    if (actionResult.kind === 'no_pending_decision') {
      respondJson(response, 404, { error: 'no_pending_decision' })
      return
    }
    if (actionResult.kind === 'invalid_action') {
      respondJson(response, 400, { error: 'invalid_action' })
      return
    }
    respondJson(response, 202, {
      sessionId,
      accepted: true,
      state: actionResult.state,
    })
    return
  }

  const decisionDismissMatch = pathname.match(
    /^\/session\/([^/]+)\/decision-dismiss$/u,
  )
  if (request.method === 'POST' && decisionDismissMatch) {
    const sessionId = decodeURIComponent(decisionDismissMatch[1])
    const dismissResult = await runtime.taskDecisionFlow.dismissDecision(
      sessionId,
    )
    if (dismissResult.kind === 'session_not_found') {
      respondJson(response, 404, { error: 'session_not_found' })
      return
    }
    if (dismissResult.kind === 'no_pending_decision') {
      respondJson(response, 404, { error: 'no_pending_decision' })
      return
    }
    if (dismissResult.kind !== 'accepted') {
      respondJson(response, 500, { error: dismissResult.kind })
      return
    }

    respondJson(response, 200, {
      sessionId,
      accepted: true,
      state: dismissResult.state,
    })
    return
  }

  const templatePreflightMatch = pathname.match(
    /^\/product\/templates\/([^/]+)\/preflight$/u,
  )
  if (request.method === 'GET' && templatePreflightMatch) {
    const templateId = decodeURIComponent(templatePreflightMatch[1])
    const preflightResult = await runtime.templateLaunchFlow.readPreflight(
      templateId,
    )
    if (preflightResult.kind === 'template_not_found') {
      respondJson(response, 404, {
        error: '没有找到这个模板，或它不在普通用户可启动范围内。',
      })
      return
    }

    respondJson(response, 200, {
      templateId: preflightResult.templateId,
      preflight: preflightResult.preflight,
    })
    return
  }

  const sessionStateMatch = pathname.match(/^\/session\/([^/]+)\/state$/u)
  if (request.method === 'GET' && sessionStateMatch) {
    const sessionId = decodeURIComponent(sessionStateMatch[1])
    const record = await runtime.sessionOrchestrator.refreshSessionState(
      sessionId,
    )
    respondJson(response, 200, record.state)
    return
  }

  const sessionTimelineMatch = pathname.match(/^\/session\/([^/]+)\/timeline$/u)
  if (request.method === 'GET' && sessionTimelineMatch) {
    const sessionId = decodeURIComponent(sessionTimelineMatch[1])
    const record = await runtime.sessionOrchestrator.refreshSessionState(
      sessionId,
    )
    respondJson(response, 200, {
      sessionId,
      timeline: record.timeline,
      updatedAt: record.state.updatedAt,
    })
    return
  }

  const sessionStopMatch = pathname.match(/^\/session\/([^/]+)\/stop$/u)
  if (request.method === 'POST' && sessionStopMatch) {
    const sessionId = decodeURIComponent(sessionStopMatch[1])
    const stopResult = runtime.sessionControlFlow.stopSession(sessionId)
    if (stopResult.kind === 'session_not_found') {
      respondJson(response, 404, { error: 'session_not_found' })
      return
    }

    respondJson(response, 200, {
      sessionId,
      accepted: true,
      state: stopResult.state,
    })
    return
  }

  const permissionDecisionMatch = pathname.match(
    /^\/session\/([^/]+)\/permission-decision$/u,
  )
  if (request.method === 'POST' && permissionDecisionMatch) {
    const sessionId = decodeURIComponent(permissionDecisionMatch[1])
    const payload = await readJsonBody(request)
    const { decision, grantScope, reason } =
      parsePermissionDecisionPayload(payload)
    if (!decision) {
      respondJson(response, 400, { error: 'decision must be approve or deny' })
      return
    }

    const permissionResult =
      runtime.sessionControlFlow.resolvePermissionDecision({
        sessionId,
        decision,
        grantScope,
        reason,
      })
    if (permissionResult.kind === 'no_pending_permission') {
      respondJson(response, 404, { error: 'no_pending_permission' })
      return
    }

    respondJson(response, 200, {
      sessionId,
      accepted: true,
    })
    return
  }

  if (request.method === 'GET' && pathname === '/system/windows-mcp/status') {
    respondJson(
      response,
      200,
      await runtime.systemProductFlow.readWindowsMcpStatus(),
    )
    return
  }

  if (request.method === 'GET' && pathname === '/product/support-matrix') {
    respondJson(
      response,
      200,
      await runtime.systemProductFlow.readSupportMatrix(),
    )
    return
  }

  if (request.method === 'GET' && pathname === '/product/scorecard-summary') {
    respondJson(
      response,
      200,
      await runtime.systemProductFlow.readScorecardSummary(),
    )
    return
  }

  if (request.method === 'GET' && pathname === '/product/governance') {
    respondJson(
      response,
      200,
      await runtime.systemProductFlow.readGovernance(),
    )
    return
  }

  if (request.method === 'POST' && pathname === '/system/windows-mcp/restart') {
    const view = await runtime.systemProductFlow.restartWindowsMcp()
    respondJson(response, 200, view)
    return
  }

  respondJson(response, 404, { error: 'not_found' })
}

async function readStaticAsset(fileName: string) {
  return readFile(resolve(PANEL_PUBLIC_DIR, fileName), 'utf8')
}
