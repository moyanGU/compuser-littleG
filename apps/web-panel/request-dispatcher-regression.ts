import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleWebPanelRequest } from './requestDispatcher.js'
import type { ProductizationPanelState } from './panelTypes.js'
import type { SessionRecord } from './sessionStore.js'
import type { WebPanelServerOptions } from './serverOptions.js'
import type { WebPanelRuntime } from './serverRuntime.js'

type TemplateLaunchResult =
  | { kind: 'template_not_found' }
  | {
      kind: 'preflight_blocked'
      preflight: {
        status: 'blocked'
        summary: string
        checks: Array<{ category: string; name: string; status: string; detail: string }>
      }
    }
  | {
      kind: 'requires_confirmation'
      sessionId: string
      state: ProductizationPanelState
    }
  | {
      kind: 'accepted'
      sessionId: string
      state: ProductizationPanelState
    }

type TemplateDecisionResult =
  | { kind: 'no_pending_template_launch' }
  | {
      kind: 'accepted'
      statusCode: number
      state: ProductizationPanelState
    }

type PermissionDecisionResult =
  | { kind: 'no_pending_permission' }
  | { kind: 'accepted' }

type TaskDecisionResult =
  | { kind: 'accepted'; sessionId: string; state: ProductizationPanelState }
  | { kind: 'session_not_found' }
  | { kind: 'no_pending_decision' }
  | { kind: 'invalid_action' }

async function main(): Promise<void> {
  await testSessionTaskAndFallbackRoutes()
  await testApiTaskMatchesSessionTaskBehavior()
  await testDecisionRoutes()
  await testDefaultProviderIsForwardedWhenUnset()
  await testConfiguredProviderIsForwarded()
  await testProviderFailureDoesNotCrashAcceptedTask()
  await testTransportProviderFailureStaysVisibleInSessionState()
  await testStructuredProviderFailureStaysVisibleInSessionState()
  await testTemplateLaunchBranches()
  await testTemplateDecisionBranches()
  await testPermissionDecisionBranches()
  console.log('request-dispatcher-regression ok')
}

async function testSessionTaskAndFallbackRoutes(): Promise<void> {
  const harness = createHarness()
  const baseUrl = await harness.ready()

  try {
    const emptyTaskResponse = await postJson(baseUrl, '/session/task', {})
    assert(emptyTaskResponse.status === 400, 'empty /session/task should return 400')

    const acceptedResponse = await postJson(baseUrl, '/session/task', {
      sessionId: '  requested-session  ',
      task: '  launch task  ',
    })
    assert(acceptedResponse.status === 202, '/session/task should accept valid task')
    assert(
      acceptedResponse.body.sessionId === 'requested-session',
      '/session/task should return trimmed session id',
    )
    assert(acceptedResponse.body.accepted === true, '/session/task should mark accepted=true')
    assert(harness.startTaskCalls.length === 1, '/session/task should call startTask once')
    assert(
      harness.startTaskCalls[0].sessionId === 'requested-session',
      '/session/task should forward trimmed session id to startTask',
    )
    assert(
      harness.startTaskCalls[0].task === 'launch task',
      '/session/task should forward trimmed task to startTask',
    )

    const missingRouteResponse = await fetch(`${baseUrl}/missing`)
    const missingRouteBody = (await missingRouteResponse.json()) as { error?: unknown }
    assert(missingRouteResponse.status === 404, 'unknown route should return 404')
    assert(missingRouteBody.error === 'not_found', 'unknown route should return not_found')
  } finally {
    await harness.close()
  }
}

async function testApiTaskMatchesSessionTaskBehavior(): Promise<void> {
  const harness = createHarness()
  const baseUrl = await harness.ready()

  try {
    const acceptedResponse = await postJson(baseUrl, '/api/task', {
      sessionId: 'api-session',
      task: 'inspect attachment',
      attachments: [
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          base64: Buffer.from('hello from api task', 'utf8').toString('base64'),
        },
      ],
    })
    assert(acceptedResponse.status === 202, '/api/task should accept valid task')
    assert(
      acceptedResponse.body.sessionId === 'api-session',
      '/api/task should return explicit session id',
    )
    assert(acceptedResponse.body.accepted === true, '/api/task should mark accepted=true')
    assert(harness.startTaskCalls.length === 1, '/api/task should call startTask once')
    assert(
      harness.startTaskCalls[0].sessionId === 'api-session',
      '/api/task should forward explicit session id',
    )
    assert(
      harness.startTaskCalls[0].task.includes('已上传文件'),
      '/api/task should include uploaded attachment context in forwarded task',
    )
    assert(
      harness.startTaskCalls[0].task.includes('notes.txt'),
      '/api/task should mention uploaded attachment name in forwarded task',
    )
  } finally {
    await harness.close()
  }
}

async function testDecisionRoutes(): Promise<void> {
  const harness = createHarness()
  const baseUrl = await harness.ready()
  harness.taskDecisionResponse = {
    kind: 'accepted',
    sessionId: 'decision-session',
    state: {
      ...createState('decision-session'),
      view: 'decision',
      decision: {
        kind: 'direct_execute',
        title: 'Ready to execute',
        summary: 'summary',
        reasonText: 'reason',
        actionText: 'action',
        primaryAction: {
          id: 'decision-execute',
          label: 'execute',
          kind: 'execute',
          taskOverride: 'launch task',
        },
        secondaryActions: [],
      },
    },
  }
  harness.decisionActionResponses.set('decision-session:decision-execute', {
    kind: 'accepted',
    sessionId: 'decision-session',
    state: {
      ...createState('decision-session'),
      view: 'executing',
      isRunning: true,
    },
  })
  harness.decisionDismissResponses.set('decision-session', {
    kind: 'accepted',
    sessionId: 'decision-session',
    state: createState('decision-session'),
  })

  try {
    const emptyDecisionResponse = await postJson(baseUrl, '/session/task-decision', {})
    assert(
      emptyDecisionResponse.status === 400,
      'empty /session/task-decision should return 400',
    )

    const acceptedDecisionResponse = await postJson(baseUrl, '/session/task-decision', {
      sessionId: '  decision-session  ',
      task: '  decide this task  ',
    })
    assert(
      acceptedDecisionResponse.status === 202,
      '/session/task-decision should accept valid task',
    )
    assert(
      acceptedDecisionResponse.body.sessionId === 'decision-session',
      '/session/task-decision should return trimmed session id',
    )
    assert(
      acceptedDecisionResponse.body.accepted === true,
      '/session/task-decision should mark accepted=true',
    )
    assert(
      harness.taskDecisionCalls.length === 1,
      '/session/task-decision should call decision flow once',
    )
    assert(
      harness.taskDecisionCalls[0].sessionId === 'decision-session',
      '/session/task-decision should forward trimmed session id',
    )
    assert(
      harness.taskDecisionCalls[0].task === 'decide this task',
      '/session/task-decision should forward trimmed task',
    )

    const invalidActionResponse = await postJson(
      baseUrl,
      '/session/decision-session/decision-action',
      {},
    )
    assert(
      invalidActionResponse.status === 400,
      'missing actionId should return 400',
    )

    const acceptedActionResponse = await postJson(
      baseUrl,
      '/session/decision-session/decision-action',
      { actionId: ' decision-execute ' },
    )
    assert(
      acceptedActionResponse.status === 202,
      'accepted decision action should return 202',
    )
    assert(
      harness.decisionActionCalls.length === 1,
      'decision action should call decision flow once',
    )
    assert(
      harness.decisionActionCalls[0].actionId === 'decision-execute',
      'decision action should forward trimmed actionId',
    )

    const missingDismissResponse = await postJson(
      baseUrl,
      '/session/missing-session/decision-dismiss',
      {},
    )
    assert(
      missingDismissResponse.status === 404,
      'missing decision-dismiss should return 404',
    )

    const acceptedDismissResponse = await postJson(
      baseUrl,
      '/session/decision-session/decision-dismiss',
      {},
    )
    assert(
      acceptedDismissResponse.status === 200,
      'accepted decision-dismiss should return 200',
    )
    assert(
      harness.decisionDismissCalls.length === 2,
      'decision-dismiss should call flow for each request',
    )
  } finally {
    await harness.close()
  }
}

async function testConfiguredProviderIsForwarded(): Promise<void> {
  const harness = createHarness({
    defaultModelProvider: 'openai-compatible',
    modelBaseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    modelName: 'gpt-test',
  })
  const baseUrl = await harness.ready()

  try {
    const acceptedResponse = await postJson(baseUrl, '/session/task', {
      sessionId: 'provider-session',
      task: 'provider passthrough',
    })
    assert(acceptedResponse.status === 202, 'configured provider task should be accepted')
    assert(harness.startTaskCalls.length === 1, 'provider passthrough should call startTask once')
    assert(
      harness.startTaskCalls[0].options?.modelProvider === 'openai-compatible',
      'request dispatcher should forward configured model provider',
    )
    assert(
      harness.startTaskCalls[0].options?.modelBaseUrl ===
        'http://127.0.0.1:11434/v1/chat/completions',
      'request dispatcher should forward provider base URL',
    )
    assert(
      harness.startTaskCalls[0].options?.modelName === 'gpt-test',
      'request dispatcher should forward provider model name',
    )
  } finally {
    await harness.close()
  }
}

async function testDefaultProviderIsForwardedWhenUnset(): Promise<void> {
  const harness = createHarness({
    defaultModelProvider: 'openai-compatible',
  })
  const baseUrl = await harness.ready()

  try {
    const acceptedResponse = await postJson(baseUrl, '/session/task', {
      sessionId: 'default-provider-session',
      task: 'default provider passthrough',
    })
    assert(
      acceptedResponse.status === 202,
      'default provider task should be accepted',
    )
    assert(
      harness.startTaskCalls.length === 1,
      'default provider passthrough should call startTask once',
    )
    assert(
      harness.startTaskCalls[0].options?.modelProvider === 'openai-compatible',
      'request dispatcher should forward openai-compatible as the default provider',
    )
  } finally {
    await harness.close()
  }
}

async function testProviderFailureDoesNotCrashAcceptedTask(): Promise<void> {
  const harness = createHarness({
    defaultModelProvider: 'openai-compatible',
    startTaskError: new Error(
      'missing_dependency missing modelBaseUrl / COMPUSER_MODEL_BASE_URL',
    ),
  })
  const baseUrl = await harness.ready()

  try {
    const acceptedResponse = await postJson(baseUrl, '/session/task', {
      sessionId: 'provider-failure-session',
      task: 'provider failure should stay visible in session state',
    })
    assert(
      acceptedResponse.status === 202,
      'provider failure should still return accepted task response',
    )

    await new Promise(resolve => setTimeout(resolve, 0))

    const stateResponse = await fetch(
      `${baseUrl}/session/provider-failure-session/state`,
    )
    assert(
      stateResponse.status === 200,
      'session state should remain readable after provider failure',
    )
    const state = (await stateResponse.json()) as {
      currentStage?: unknown
      stopReason?: unknown
      finalText?: unknown
      isRunning?: unknown
    }
    assert(
      state.currentStage === 'execution_failed',
      'provider failure should surface execution_failed stage in session state',
    )
    assert(
      state.stopReason === 'missing_dependency',
      'provider failure should classify as missing_dependency',
    )
    assert(
      typeof state.finalText === 'string' &&
        state.finalText.includes('missing modelBaseUrl'),
      'provider failure should preserve explicit failure text in session state',
    )
    assert(
      state.isRunning === false,
      'provider failure should clear running state after background failure',
    )
  } finally {
    await harness.close()
  }
}

async function testTransportProviderFailureStaysVisibleInSessionState(): Promise<void> {
  const harness = createHarness({
    defaultModelProvider: 'openai-compatible',
    startTaskError: new Error(
      'transport_error provider endpoint unreachable: connect ECONNREFUSED 127.0.0.1:4317',
    ),
  })
  const baseUrl = await harness.ready()

  try {
    const acceptedResponse = await postJson(baseUrl, '/session/task', {
      sessionId: 'provider-transport-session',
      task: 'transport failure should stay visible in session state',
    })
    assert(
      acceptedResponse.status === 202,
      'transport provider failure should still return accepted task response',
    )

    await new Promise(resolve => setTimeout(resolve, 0))

    const stateResponse = await fetch(
      `${baseUrl}/session/provider-transport-session/state`,
    )
    assert(
      stateResponse.status === 200,
      'session state should remain readable after transport provider failure',
    )
    const state = (await stateResponse.json()) as {
      stopReason?: unknown
      finalText?: unknown
      isRunning?: unknown
    }
    assert(
      state.stopReason === 'transport_error',
      'transport provider failure should classify as transport_error',
    )
    assert(
      typeof state.finalText === 'string' &&
        state.finalText.includes('transport_error provider endpoint unreachable'),
      'transport provider failure should preserve explicit transport error text',
    )
    assert(
      state.isRunning === false,
      'transport provider failure should clear running state after background failure',
    )
  } finally {
    await harness.close()
  }
}

async function testStructuredProviderFailureStaysVisibleInSessionState(): Promise<void> {
  const harness = createHarness({
    defaultModelProvider: 'openai-compatible',
    startTaskError: new Error(
      'provider_error code=http_error retryable=false status=400 message=bad provider request',
    ),
  })
  const baseUrl = await harness.ready()

  try {
    const acceptedResponse = await postJson(baseUrl, '/session/task', {
      sessionId: 'provider-structured-session',
      task: 'structured provider failure should stay visible in session state',
    })
    assert(
      acceptedResponse.status === 202,
      'structured provider failure should still return accepted task response',
    )

    await new Promise(resolve => setTimeout(resolve, 0))

    const stateResponse = await fetch(
      `${baseUrl}/session/provider-structured-session/state`,
    )
    assert(
      stateResponse.status === 200,
      'session state should remain readable after structured provider failure',
    )
    const state = (await stateResponse.json()) as {
      stopReason?: unknown
      finalText?: unknown
      isRunning?: unknown
    }
    assert(
      state.stopReason === 'provider_error',
      'structured provider failure should classify as provider_error',
    )
    assert(
      typeof state.finalText === 'string' &&
        state.finalText.includes('provider_error code=http_error'),
      'structured provider failure should preserve explicit provider error text',
    )
    assert(
      state.isRunning === false,
      'structured provider failure should clear running state after background failure',
    )
  } finally {
    await harness.close()
  }
}

async function testTemplateLaunchBranches(): Promise<void> {
  const harness = createHarness()
  const baseUrl = await harness.ready()
  harness.templateLaunchResponses.set('missing-template', {
    kind: 'template_not_found',
  })
  harness.templateLaunchResponses.set('blocked-template', {
    kind: 'preflight_blocked',
    preflight: {
      status: 'blocked',
      summary: 'blocked',
      checks: [],
    },
  })
  harness.templateLaunchResponses.set('confirm-template', {
    kind: 'requires_confirmation',
    sessionId: 'confirm-session',
    state: createState('confirm-session'),
  })
  harness.templateLaunchResponses.set('accept-template', {
    kind: 'accepted',
    sessionId: 'accept-session',
    state: createState('accept-session'),
  })

  try {
    const missingResponse = await postJson(
      baseUrl,
      '/product/templates/missing-template/launch',
      {},
    )
    assert(missingResponse.status === 404, 'missing template launch should return 404')

    const blockedResponse = await postJson(
      baseUrl,
      '/product/templates/blocked-template/launch',
      {},
    )
    assert(blockedResponse.status === 409, 'blocked template launch should return 409')
    assert(
      blockedResponse.body.error === 'template_preflight_blocked',
      'blocked template launch should expose template_preflight_blocked',
    )

    const confirmResponse = await postJson(
      baseUrl,
      '/product/templates/confirm-template/launch',
      {
        sessionId: '  requested-session  ',
      },
    )
    assert(confirmResponse.status === 202, 'confirmation template launch should return 202')
    assert(
      confirmResponse.body.requiresConfirmation === true,
      'confirmation template launch should expose requiresConfirmation=true',
    )
    assert(
      harness.templateLaunchCalls[2].payloadSession === '  requested-session  ',
      'template launch should receive the raw payload session for downstream trimming',
    )

    const acceptedResponse = await postJson(
      baseUrl,
      '/product/templates/accept-template/launch',
      {},
    )
    assert(acceptedResponse.status === 202, 'accepted template launch should return 202')
    assert(
      acceptedResponse.body.accepted === true,
      'accepted template launch should expose accepted=true',
    )
  } finally {
    await harness.close()
  }
}

async function testTemplateDecisionBranches(): Promise<void> {
  const harness = createHarness()
  const baseUrl = await harness.ready()
  harness.templateDecisionResponses.set('missing-session', {
    kind: 'no_pending_template_launch',
  })
  harness.templateDecisionResponses.set('approve-session', {
    kind: 'accepted',
    statusCode: 202,
    state: createState('approve-session'),
  })

  try {
    const invalidDecisionResponse = await postJson(
      baseUrl,
      '/session/approve-session/template-launch-decision',
      {
        decision: 'maybe',
      },
    )
    assert(invalidDecisionResponse.status === 400, 'invalid template decision should return 400')

    const missingDecisionResponse = await postJson(
      baseUrl,
      '/session/missing-session/template-launch-decision',
      {
        decision: 'approve',
      },
    )
    assert(
      missingDecisionResponse.status === 404,
      'missing template decision should return 404',
    )

    const acceptedDecisionResponse = await postJson(
      baseUrl,
      '/session/approve-session/template-launch-decision',
      {
        decision: 'approve',
      },
    )
    assert(
      acceptedDecisionResponse.status === 202,
      'accepted template decision should return handler status code',
    )
    assert(
      harness.templateDecisionCalls.length === 2,
      'template decision should call flow for valid decisions only',
    )
    assert(
      harness.templateDecisionCalls[1].decision === 'approve',
      'template decision should forward approve decision',
    )
  } finally {
    await harness.close()
  }
}

async function testPermissionDecisionBranches(): Promise<void> {
  const harness = createHarness()
  const baseUrl = await harness.ready()
  harness.permissionDecisionResponses.set('missing-session', {
    kind: 'no_pending_permission',
  })
  harness.permissionDecisionResponses.set('approve-session', {
    kind: 'accepted',
  })

  try {
    const invalidDecisionResponse = await postJson(
      baseUrl,
      '/session/approve-session/permission-decision',
      {
        decision: 'maybe',
      },
    )
    assert(invalidDecisionResponse.status === 400, 'invalid permission decision should return 400')

    const missingDecisionResponse = await postJson(
      baseUrl,
      '/session/missing-session/permission-decision',
      {
        decision: 'approve',
      },
    )
    assert(
      missingDecisionResponse.status === 404,
      'missing permission decision should return 404',
    )

    const acceptedDecisionResponse = await postJson(
      baseUrl,
      '/session/approve-session/permission-decision',
      {
        decision: 'approve',
        grantScope: 'tool',
        reason: '  approved for regression  ',
      },
    )
    assert(
      acceptedDecisionResponse.status === 200,
      'accepted permission decision should return 200',
    )
    assert(
      acceptedDecisionResponse.body.accepted === true,
      'accepted permission decision should expose accepted=true',
    )
    assert(
      harness.permissionDecisionCalls.length === 2,
      'permission decision should call flow for valid decisions only',
    )
    assert(
      harness.permissionDecisionCalls[1].grantScope === 'tool',
      'permission decision should forward normalized grantScope',
    )
    assert(
      harness.permissionDecisionCalls[1].reason === 'approved for regression',
      'permission decision should forward trimmed reason text',
    )
  } finally {
    await harness.close()
  }
}

function createHarness(input?: {
  defaultModelProvider?: WebPanelServerOptions['defaultModelProvider']
  modelBaseUrl?: string
  modelName?: string
  startTaskError?: Error
}) {
  const sessions = new Map<string, SessionRecord>()
  const startTaskCalls: Array<{
    sessionId: string
    task: string
    options?: {
      modelProvider?: unknown
      modelBaseUrl?: unknown
      modelName?: unknown
    }
  }> = []
  const templateLaunchCalls: Array<{
    templateId: string
    payloadSession: unknown
    defaultSessionId: string
  }> = []
  const taskDecisionCalls: Array<{ sessionId: string; task: string }> = []
  const decisionActionCalls: Array<{ sessionId: string; actionId: string }> = []
  const decisionDismissCalls: string[] = []
  const templateDecisionCalls: Array<{ sessionId: string; decision: string }> = []
  const permissionDecisionCalls: Array<{
    sessionId: string
    decision: string
    grantScope?: string
    reason?: string
  }> = []
  const templateLaunchResponses = new Map<string, TemplateLaunchResult>()
  let taskDecisionResponse: TaskDecisionResult = {
    kind: 'accepted',
    sessionId: 'default-decision-session',
    state: {
      ...createState('default-decision-session'),
      view: 'decision',
    },
  }
  const decisionActionResponses = new Map<string, TaskDecisionResult>()
  const decisionDismissResponses = new Map<string, TaskDecisionResult>()
  const templateDecisionResponses = new Map<string, TemplateDecisionResult>()
  const permissionDecisionResponses = new Map<string, PermissionDecisionResult>()
  const options: WebPanelServerOptions = {
    port: 0,
    permissionMode: 'default',
    windowsMcpEndpoint: 'http://127.0.0.1:8010/mcp',
    defaultModelProvider: input?.defaultModelProvider ?? 'demo',
    modelBaseUrl: input?.modelBaseUrl,
    modelName: input?.modelName,
  }
  const runtime = {
    sessions,
    windowsMcpService: {},
    sessionOrchestrator: {
      async refreshSessionState(sessionId: string) {
        return getOrCreateRecord(sessions, sessionId)
      },
      async startTask(sessionId: string, task: string, startOptions?: unknown) {
        startTaskCalls.push({
          sessionId,
          task,
          options:
            typeof startOptions === 'object' && startOptions !== null
              ? (startOptions as {
                  modelProvider?: unknown
                  modelBaseUrl?: unknown
                  modelName?: unknown
                })
              : undefined,
        })
        const record = getOrCreateRecord(sessions, sessionId)
        record.task = task
        record.state = {
          ...record.state,
          sessionId,
          submittedTask: task,
          isRunning: true,
          updatedAt: new Date().toISOString(),
        }
        sessions.set(sessionId, record)
        if (input?.startTaskError) {
          const stopReason = classifyHarnessStopReason(input.startTaskError)
          queueMicrotask(() => {
            record.state = {
              ...record.state,
              currentStage: 'execution_failed',
              stageLabel: 'Failure',
              isRunning: false,
              emergencyStopAvailable: false,
              finalText: input.startTaskError?.message,
              stopReason,
              updatedAt: new Date().toISOString(),
            }
            sessions.set(sessionId, record)
          })
        }
        return record
      },
    },
    taskDecisionFlow: {
      async decideTask(sessionId: string, task: string) {
        taskDecisionCalls.push({ sessionId, task })
        return taskDecisionResponse
      },
      async applyDecisionAction(sessionId: string, actionId: string) {
        decisionActionCalls.push({ sessionId, actionId })
        return (
          decisionActionResponses.get(`${sessionId}:${actionId}`) ?? {
            kind: 'invalid_action',
          }
        )
      },
      async dismissDecision(sessionId: string) {
        decisionDismissCalls.push(sessionId)
        return (
          decisionDismissResponses.get(sessionId) ?? {
            kind: 'session_not_found',
          }
        )
      },
    },
    templateLaunchFlow: {
      async requestLaunch(
        templateId: string,
        payloadSession: unknown,
        defaultSessionId: string,
      ) {
        templateLaunchCalls.push({
          templateId,
          payloadSession,
          defaultSessionId,
        })
        return (
          templateLaunchResponses.get(templateId) ?? {
            kind: 'accepted',
            sessionId: 'default-template-session',
            state: createState('default-template-session'),
          }
        )
      },
      async handleDecision(sessionId: string, decision: string) {
        templateDecisionCalls.push({ sessionId, decision })
        return (
          templateDecisionResponses.get(sessionId) ?? {
            kind: 'accepted',
            statusCode: 200,
            state: createState(sessionId),
          }
        )
      },
      async readPreflight(templateId: string) {
        return {
          kind: 'ready',
          templateId,
          preflight: {
            status: 'ready',
            summary: 'ready',
            checks: [],
          },
        }
      },
    },
    systemProductFlow: {
      async readWindowsMcpStatus() {
        return {
          mode: 'endpoint',
          state: 'ready',
          reachable: true,
          summary: 'ready',
        }
      },
      async readSupportMatrix() {
        return {
          templates: [],
          exclusions: [],
        }
      },
      async readScorecardSummary() {
        return {
          totals: { total_runs: 0, pass: 0 },
          templateTotals: {},
          familyTotals: {},
        }
      },
      async readGovernance() {
        return {
          supportMatrixPath: 'support-matrix.json',
          scorecardArtifactPath: 'scorecard.json',
          permissionDefaults: [],
          exclusions: [],
          ordinaryUserNotes: [],
        }
      },
      async restartWindowsMcp() {
        return {
          mode: 'endpoint',
          state: 'ready',
          reachable: true,
          summary: 'ready',
        }
      },
    },
    sessionControlFlow: {
      stopSession() {
        return {
          kind: 'session_not_found',
        }
      },
      resolvePermissionDecision(input: {
        sessionId: string
        decision: string
        grantScope?: string
        reason?: string
      }) {
        permissionDecisionCalls.push(input)
        return (
          permissionDecisionResponses.get(input.sessionId) ?? {
            kind: 'accepted',
          }
        )
      },
    },
  } as unknown as WebPanelRuntime

  const server = createServer((request, response) => {
    void handleWebPanelRequest(request, response, options, runtime).catch(error => {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      })
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    })
  })

  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    startTaskCalls,
    templateLaunchCalls,
    taskDecisionCalls,
    decisionActionCalls,
    decisionDismissCalls,
    templateDecisionCalls,
    permissionDecisionCalls,
    get taskDecisionResponse() {
      return taskDecisionResponse
    },
    set taskDecisionResponse(value: TaskDecisionResult) {
      taskDecisionResponse = value
    },
    decisionActionResponses,
    decisionDismissResponses,
    templateLaunchResponses,
    templateDecisionResponses,
    permissionDecisionResponses,
    async ready() {
      await listening
      const address = server.address() as AddressInfo | null
      if (!address) {
        throw new Error('request-dispatcher harness server is not listening')
      }
      return `http://127.0.0.1:${address.port}`
    },
    async close() {
      await listening
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

function getOrCreateRecord(
  sessions: Map<string, SessionRecord>,
  sessionId: string,
): SessionRecord {
  const existing = sessions.get(sessionId)
  if (existing) {
    return existing
  }

  const record: SessionRecord = {
    sessionId,
    state: createState(sessionId),
    timeline: [],
  }
  sessions.set(sessionId, record)
  return record
}

function createState(sessionId: string): ProductizationPanelState {
  return {
    sessionId,
    view: 'home',
    currentStage: 'idle',
    stageLabel: 'Idle',
    isRunning: false,
    emergencyStopAvailable: false,
    planSummary: [],
    routeCards: [],
    timeline: [],
    permissionEvents: [],
    verification: [],
    results: [],
    windowsMcpStatus: {
      mode: 'endpoint',
      state: 'ready',
      reachable: true,
      summary: 'ready',
    },
    updatedAt: new Date(0).toISOString(),
  }
}

function classifyHarnessStopReason(
  error: Error,
): 'missing_dependency' | 'transport_error' | 'provider_error' {
  if (error.message.startsWith('missing_dependency ')) {
    return 'missing_dependency'
  }

  if (error.message.startsWith('transport_error ')) {
    return 'transport_error'
  }

  if (error.message.startsWith('provider_error ')) {
    return 'provider_error'
  }

  return 'provider_error'
}

async function postJson(
  baseUrl: string,
  pathname: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
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
