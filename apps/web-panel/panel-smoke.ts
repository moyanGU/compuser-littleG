import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { listVerifiedSupportTemplates } from '../../packages/product/SupportMatrix.js'
import { PANEL_DEFAULT_SESSION_ID } from './defaults.js'

const disconnectedPort = 4318
const readyPort = 4320
const fakeWindowsMcpPort = 4319
const taskDecisionFlowSource = readFileSync(
  resolve(process.cwd(), 'apps/web-panel/taskDecisionFlow.ts'),
  'utf8',
)

async function main(): Promise<void> {
  await withPanelServer(
    {
      port: disconnectedPort,
    },
    async port => {
      await verifyFrontendShellHtml(port)
      await verifyBaseState(port, 'disconnected')
      await verifyProductEndpoints(port, 'disconnected')
      await verifyEnvironmentSensitiveDecisionPaths(port)
      await verifyTemplateLaunchPaths(port)
      await verifyLegacyTaskPathAndResultView(port)
    },
  )

  await withFakeWindowsMcpServer(async () => {
    await withPanelServer(
      {
        port: readyPort,
        windowsMcpEndpoint: `http://127.0.0.1:${fakeWindowsMcpPort}/mcp`,
      },
      async port => {
        await verifyBaseState(port, 'ready')
        await verifyProductEndpoints(port, 'ready')
        await verifyReadyDecisionPaths(port)
      },
    )
  })

  console.log('web-panel-shell-smoke ok')
}

async function withPanelServer(
  options: {
    port: number
    windowsMcpEndpoint?: string
  },
  run: (port: number) => Promise<void>,
): Promise<void> {
  const args = ['dist/apps/web-panel/server.js', '--port', String(options.port)]
  if (options.windowsMcpEndpoint) {
    args.push('--windows-mcp-endpoint', options.windowsMcpEndpoint)
  }
  args.push('--model-provider', 'demo')

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForServer(child, options.port)
    await run(options.port)
  } finally {
    child.kill()
  }
}

async function withFakeWindowsMcpServer(run: () => Promise<void>): Promise<void> {
  const server = createFakeWindowsMcpServer()
  await listenServer(server, fakeWindowsMcpPort)
  try {
    await run()
  } finally {
    await closeServer(server)
  }
}

async function verifyFrontendShellHtml(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert(response.ok, 'GET / should return web-panel shell')

  const html = await response.text()
  const requiredMarkers = [
    'Compuser',
    'id="home-view"',
    'id="decision-view"',
    'id="executing-view"',
    'id="result-view"',
    'id="task-input"',
    'id="recommended-templates"',
    'id="windows-status"',
    'id="advanced-panel"',
  ]
  for (const marker of requiredMarkers) {
    assert(html.includes(marker), `web-panel shell should contain ${marker}`)
  }

  const removedShellMarkers = [
    'conversation-panel',
    'app-sidebar',
    'thread-item',
    'Little G Workspace',
  ]
  for (const marker of removedShellMarkers) {
    assert(!html.includes(marker), `web-panel shell should not contain ${marker}`)
  }
}

async function verifyBaseState(
  port: number,
  expectedWindowsState: 'disconnected' | 'ready',
): Promise<void> {
  const stateResponse = await fetch(
    `http://127.0.0.1:${port}/session/${PANEL_DEFAULT_SESSION_ID}/state`,
  )
  assert(stateResponse.ok, 'GET /session/:id/state should succeed')
  const state = (await stateResponse.json()) as {
    sessionId?: unknown
    currentStage?: unknown
    view?: unknown
    windowsMcpStatus?: { state?: unknown }
    recommendedTemplates?: unknown
  }
  assert(typeof state.sessionId === 'string', 'state should expose sessionId')
  assert(typeof state.currentStage === 'string', 'state should expose currentStage')
  assert(state.view === 'home', 'initial state should expose home view')
  assert(
    typeof state.windowsMcpStatus === 'object' && state.windowsMcpStatus !== null,
    'state should expose windowsMcpStatus',
  )
  assert(
    state.windowsMcpStatus.state === expectedWindowsState,
    `initial windows-mcp status should be ${expectedWindowsState}`,
  )

  const stateRecommendedTemplates = Array.isArray(state.recommendedTemplates)
    ? state.recommendedTemplates
    : []
  assert(
    stateRecommendedTemplates.length > 0,
    'initial state should expose recommended templates',
  )
  assert(
    stateRecommendedTemplates.every(
      item =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { readiness?: unknown }).readiness === 'string' &&
        typeof (item as { recommendationTier?: unknown }).recommendationTier ===
          'string' &&
        typeof (item as { preflight?: { status?: unknown } }).preflight?.status ===
          'string',
    ),
    'recommended templates should expose readiness, recommendationTier, and preflight status',
  )
}

async function verifyProductEndpoints(
  port: number,
  expectedWindowsState: 'disconnected' | 'ready',
): Promise<void> {
  const statusResponse = await fetch(
    `http://127.0.0.1:${port}/system/windows-mcp/status`,
  )
  assert(statusResponse.ok, 'GET /system/windows-mcp/status should succeed')
  const statusPayload = (await statusResponse.json()) as { state?: unknown }
  assert(typeof statusPayload.state === 'string', 'windows-mcp status should expose state')
  assert(
    statusPayload.state === expectedWindowsState,
    `windows-mcp status endpoint should be ${expectedWindowsState}`,
  )

  const supportMatrixResponse = await fetch(
    `http://127.0.0.1:${port}/product/support-matrix`,
  )
  assert(supportMatrixResponse.ok, 'GET /product/support-matrix should succeed')
  const supportMatrixPayload = (await supportMatrixResponse.json()) as {
    templates?: unknown
    exclusions?: unknown
  }
  assert(Array.isArray(supportMatrixPayload.templates), 'support matrix should expose templates')
  assert(Array.isArray(supportMatrixPayload.exclusions), 'support matrix should expose exclusions')
  const templateIds = readTemplateIds(supportMatrixPayload.templates)
  const expectedTemplateIds = listVerifiedSupportTemplates().map(item => item.id)
  assert(
    templateIds.length === expectedTemplateIds.length,
    'support matrix template count should match verified support templates',
  )
  assert(
    expectedTemplateIds.every(value => templateIds.includes(value)),
    'support matrix template ids should match verified support templates',
  )

  const scorecardResponse = await fetch(
    `http://127.0.0.1:${port}/product/scorecard-summary`,
  )
  assert(scorecardResponse.ok, 'GET /product/scorecard-summary should succeed')

  const governanceResponse = await fetch(
    `http://127.0.0.1:${port}/product/governance`,
  )
  assert(governanceResponse.ok, 'GET /product/governance should succeed')
  const governancePayload = (await governanceResponse.json()) as {
    exclusions?: unknown
    permissionDefaults?: unknown
    ordinaryUserNotes?: unknown
  }
  assert(Array.isArray(governancePayload.exclusions), 'governance should expose exclusions')
  assert(
    Array.isArray(governancePayload.permissionDefaults),
    'governance should expose permission defaults',
  )
  assert(
    Array.isArray(governancePayload.ordinaryUserNotes),
    'governance should expose ordinary-user notes',
  )
}

async function verifyEnvironmentSensitiveDecisionPaths(port: number): Promise<void> {
  const environmentUnready = await postJson(port, '/session/task-decision', {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    task: encodeTask(
      '\u8bf7\u628a\u5f53\u524d\u6d4f\u89c8\u5668\u91cc\u7684\u6587\u6863\u5185\u5bb9\u63d0\u53d6\u51fa\u6765\uff0c\u5e76\u6295\u9012\u5230\u672c\u5730 Codex \u684c\u9762\u7a97\u53e3\u3002',
    ),
  })
  assert(environmentUnready.status === 202, 'environment unready task should be accepted')
  assert(
    environmentUnready.body.state?.view === 'decision',
    'environment unready task should enter decision view',
  )
  assert(
    environmentUnready.body.state?.decision?.kind === 'environment_unready',
    'desktop deliver task should map to environment_unready under disconnected preflight',
  )
  assert(
    Array.isArray(environmentUnready.body.state?.decision?.environmentChecklist) &&
      environmentUnready.body.state.decision.environmentChecklist.length > 0,
    'environment_unready should expose environmentChecklist',
  )

  const explicitReject = await postJson(port, '/session/task-decision', {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    task: encodeTask(
      '\u8bf7\u8fdc\u7a0b\u8fde\u63a5\u53e6\u4e00\u53f0\u673a\u5668\u5e76\u66ff\u6211\u64cd\u4f5c\u4efb\u610f\u684c\u9762\u5e94\u7528\u3002',
    ),
  })
  assert(explicitReject.status === 202, 'explicit reject task should be accepted as decision')
  assert(
    explicitReject.body.state?.decision?.kind === 'explicit_reject',
    'out-of-bound task should map to explicit_reject',
  )
  assert(
    Array.isArray(explicitReject.body.state?.decision?.supportBoundarySummary) &&
      explicitReject.body.state.decision.supportBoundarySummary.length > 0,
    'explicit_reject should expose supportBoundarySummary',
  )

  const dismissDecision = await postJson(
    port,
    `/session/${encodeURIComponent(PANEL_DEFAULT_SESSION_ID)}/decision-dismiss`,
    {},
  )
  assert(dismissDecision.status === 200, 'decision-dismiss should succeed')
  assert(
    dismissDecision.body.state?.view === 'home',
    'decision-dismiss should return session to home view',
  )
  assert(
    dismissDecision.body.state?.decision === undefined,
    'decision-dismiss should clear decision payload',
  )
}

async function verifyReadyDecisionPaths(port: number): Promise<void> {
  const directDecision = await postJson(port, '/session/task-decision', {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    task: encodeTask(
      '\u8bf7\u628a\u5f53\u524d\u6d4f\u89c8\u5668\u9875\u9762\u91cc\u7684\u5185\u5bb9\u6574\u7406\u540e\u56de\u590d\u5230\u5fae\u4fe1\u804a\u5929\u7a97\u53e3\u3002',
    ),
  })
  assert(directDecision.status === 202, 'task-decision should accept direct_execute task')
  assert(
    directDecision.body.state?.view === 'decision',
    'direct_execute should enter decision view',
  )
  assert(
    directDecision.body.state?.decision?.kind === 'direct_execute',
    'strong matched task should map to direct_execute when environment is ready',
  )
  assert(
    directDecision.body.state?.isRunning === false,
    'task-decision should not start running immediately',
  )
  assert(
    directDecision.body.state?.emergencyStopAvailable !== true,
    'task-decision should not expose emergency stop before execution',
  )

  const guidedRewrite = await postJson(port, '/session/task-decision', {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    task: encodeTask(
      '\u8bf7\u628a\u6d4f\u89c8\u5668\u91cc\u7684\u5185\u5bb9\u5904\u7406\u540e\u56de\u590d\u3002',
    ),
  })
  assert(guidedRewrite.status === 202, 'guided rewrite task should be accepted')
  assert(
    guidedRewrite.body.state?.decision?.kind === 'guided_rewrite',
    'weakly specified matched task should map to guided_rewrite',
  )
  assert(
    typeof guidedRewrite.body.state?.decision?.rewriteSuggestion === 'string' &&
      guidedRewrite.body.state.decision.rewriteSuggestion.length > 0,
    'guided_rewrite should expose rewriteSuggestion',
  )

  const explicitReject = await postJson(port, '/session/task-decision', {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    task: encodeTask(
      '\u8bf7\u8fdc\u7a0b\u8fde\u63a5\u53e6\u4e00\u53f0\u673a\u5668\u5e76\u66ff\u6211\u64cd\u4f5c\u4efb\u610f\u684c\u9762\u5e94\u7528\u3002',
    ),
  })
  assert(explicitReject.status === 202, 'explicit reject task should still be accepted')
  assert(
    explicitReject.body.state?.decision?.kind === 'explicit_reject',
    'out-of-bound task should still map to explicit_reject in ready environment',
  )

  const dismissDecision = await postJson(
    port,
    `/session/${encodeURIComponent(PANEL_DEFAULT_SESSION_ID)}/decision-dismiss`,
    {},
  )
  assert(dismissDecision.status === 200, 'decision-dismiss should succeed after ready-path checks')
  assert(
    dismissDecision.body.state?.view === 'home',
    'decision-dismiss should return ready-path session to home view',
  )
}

async function verifyTemplateLaunchPaths(port: number): Promise<void> {
  const launchResponse = await postJson(
    port,
    '/product/templates/browser-editor-chat-reply-template/launch',
    {
      sessionId: PANEL_DEFAULT_SESSION_ID,
    },
  )
  assert(
    launchResponse.status >= 200 && launchResponse.status < 500,
    'template launch should return handled response',
  )
  if (launchResponse.status === 202) {
    assert(
      typeof launchResponse.body.state === 'object' && launchResponse.body.state !== null,
      'template launch should expose state object',
    )
    if (launchResponse.body.requiresConfirmation === true) {
      assert(
        launchResponse.body.state?.view === 'executing',
        'attention template launch should enter executing view',
      )
      assert(
        typeof launchResponse.body.state?.pendingTemplateLaunch?.whyConfirmation ===
          'string',
        'attention template launch should explain confirmation reason',
      )
    } else {
      assert(
        launchResponse.body.state?.view === 'executing',
        'accepted template launch should enter executing view',
      )
      assert(
        launchResponse.body.state?.isRunning === true,
        'accepted template launch should mark session as running',
      )
    }
  } else {
    assert(
      typeof launchResponse.body.error === 'string',
      'template launch non-202 response should expose error text',
    )
  }

  const preflightResponse = await fetch(
    `http://127.0.0.1:${port}/product/templates/browser-editor-chat-reply-template/preflight`,
  )
  assert(preflightResponse.ok, 'GET /product/templates/:id/preflight should succeed')
  const preflightPayload = (await preflightResponse.json()) as {
    preflight?: {
      checks?: Array<{ category?: unknown }>
    }
  }
  assert(
    Array.isArray(preflightPayload.preflight?.checks),
    'template preflight should expose checks',
  )
  assert(
    (preflightPayload.preflight?.checks ?? []).every(
      check => typeof check.category === 'string',
    ),
    'template preflight checks should expose category',
  )
}

async function verifyLegacyTaskPathAndResultView(port: number): Promise<void> {
  const taskResponse = await postJson(port, '/session/task', {
    sessionId: PANEL_DEFAULT_SESSION_ID,
    task: 'Inspect the workspace tree and summarize the current route.',
  })
  assert(taskResponse.status === 202, 'legacy session/task should still accept task')
  assert(
    taskResponse.body.state?.view === 'executing',
    'legacy session/task should enter executing view immediately',
  )
  assert(
    taskResponse.body.state?.isRunning === true,
    'legacy session/task should expose running state',
  )
  assert(
    taskResponse.body.state?.emergencyStopAvailable === true,
    'legacy session/task should expose emergency stop availability',
  )

  const completedState = await waitForSessionView(port, PANEL_DEFAULT_SESSION_ID, 'result')
  assert(
    completedState.view === 'result',
    'completed task should eventually enter result view',
  )
  assert(
    typeof completedState.result === 'object' && completedState.result !== null,
    'result view should expose result payload',
  )
  assert(
    typeof completedState.result.title === 'string' &&
      completedState.result.title.length > 0,
    'result view should expose result title',
  )
}

async function waitForSessionView(
  port: number,
  sessionId: string,
  expectedView: string,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}/state`,
    )
    if (response.ok) {
      const state = (await response.json()) as Record<string, any>
      if (state.view === expectedView) {
        return state
      }
      if (expectedView === 'result' && state.stopReason === 'aborted') {
        return state
      }
    }
    await delay(200)
  }

  throw new Error(`session ${sessionId} did not reach view=${expectedView}`)
}

async function postJson(
  port: number,
  pathname: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const body = (await response.json()) as Record<string, any>
  return {
    status: response.status,
    body,
  }
}

function readTemplateIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  return input
    .map(item =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id
        : undefined,
    )
    .filter((value): value is string => Boolean(value))
}

function encodeTask(input: string): string {
  return new TextDecoder('utf8').decode(Buffer.from(input, 'utf8'))
}

function createFakeWindowsMcpServer(): Server {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: {
            name: 'panel-smoke-fake-windows-mcp',
            version: '0.1.0',
          },
        },
      }),
    )
  })
}

async function listenServer(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function waitForServer(
  child: ReturnType<typeof spawn>,
  port: number,
): Promise<void> {
  let stderr = ''
  if (child.stderr) {
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`web-panel server exited early: ${stderr}`)
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/session/${PANEL_DEFAULT_SESSION_ID}/state`,
      )
      if (response.ok) {
        return
      }
    } catch {
      // keep polling
    }

    await delay(200)
  }

  throw new Error(`web-panel server did not become ready. ${stderr}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
