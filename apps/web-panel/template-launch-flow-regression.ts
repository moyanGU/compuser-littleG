import { createTemplateLaunchFlow } from './templateLaunchFlow.js'
import type { SessionRecord } from './sessionStore.js'
import type {
  ProductGovernanceView,
  ProductizationPanelState,
  ScorecardSummaryView,
  WindowsMcpStatusView,
} from './panelTypes.js'

async function main(): Promise<void> {
  await testBlockedPreflight()
  await testNeedsAttentionCreatesPendingLaunch()
  await testDenyClearsPendingLaunch()
  await testApproveStartsPendingLaunch()
  await testReadPreflightMissingTemplate()
  console.log('template-launch-flow-regression ok')
}

async function testBlockedPreflight(): Promise<void> {
  const harness = createHarness({
    windowsMcpStatus: {
      mode: 'endpoint',
      state: 'failed',
      reachable: false,
      summary: 'failed',
    },
  })

  const result = await harness.flow.requestLaunch(
    'browser-doc-desktop-deliver-template',
    undefined,
    'fallback-session',
  )

  assert(result.kind === 'preflight_blocked', 'failed MCP should block template launch')
  assert(harness.startTaskCalls.length === 0, 'blocked preflight should not start task')
  assert(harness.sessions.size === 1, 'blocked preflight should keep a session record for decision view')
  const record = harness.sessions.get('fallback-session')
  assert(record, 'blocked preflight should create fallback session record')
  assert(record.state.view === 'decision', 'blocked preflight should surface decision view')
  assert(
    record.state.decision?.kind === 'environment_unready',
    'blocked preflight should map to environment_unready decision',
  )
  assert(record.state.isRunning === false, 'blocked preflight should not enter running state')
}

async function testNeedsAttentionCreatesPendingLaunch(): Promise<void> {
  const harness = createHarness()

  const result = await harness.flow.requestLaunch(
    'browser-doc-desktop-deliver-template',
    '  requested-session  ',
    'fallback-session',
  )

  assert(
    result.kind === 'requires_confirmation',
    'warn-only preflight should require confirmation',
  )
  assert(
    result.sessionId === 'requested-session',
    'requestLaunch should trim and use provided session id',
  )
  assert(harness.startTaskCalls.length === 0, 'confirmation flow should not start task yet')
  const record = harness.sessions.get('requested-session')
  assert(record, 'confirmation flow should create a pending session record')
  assert(
    record.pendingTemplateLaunch?.templateId === 'browser-doc-desktop-deliver-template',
    'pending template launch should store template id',
  )
  assert(
    record.state.pendingTemplateLaunch?.templateId === 'browser-doc-desktop-deliver-template',
    'panel state should expose pending template launch',
  )
  assert(
    Array.isArray(record.state.recommendedTemplates) &&
      record.state.recommendedTemplates.length > 0,
    'pending session should include recommended templates',
  )
}

async function testDenyClearsPendingLaunch(): Promise<void> {
  const harness = createHarness()
  await harness.flow.requestLaunch(
    'browser-doc-desktop-deliver-template',
    'deny-session',
    'fallback-session',
  )

  const result = await harness.flow.handleDecision('deny-session', 'deny')

  assert(result.kind === 'accepted', 'deny decision should be accepted')
  assert(result.statusCode === 200, 'deny decision should return 200')
  assert(harness.startTaskCalls.length === 0, 'deny decision should not start task')
  const record = harness.sessions.get('deny-session')
  assert(record, 'deny session record should still exist')
  assert(record.pendingTemplateLaunch === undefined, 'deny should clear pending launch record')
  assert(
    record.state.pendingTemplateLaunch === undefined,
    'deny should clear pending launch view',
  )
  assert(record.timeline.length > 0, 'deny should append cancellation event')
}

async function testApproveStartsPendingLaunch(): Promise<void> {
  const harness = createHarness()
  await harness.flow.requestLaunch(
    'browser-doc-desktop-deliver-template',
    'approve-session',
    'fallback-session',
  )

  const result = await harness.flow.handleDecision('approve-session', 'approve')

  assert(result.kind === 'accepted', 'approve decision should be accepted')
  assert(result.statusCode === 202, 'approve decision should return 202')
  assert(harness.startTaskCalls.length === 1, 'approve should start pending task once')
  const call = harness.startTaskCalls[0]
  assert(call.sessionId === 'approve-session', 'approve should reuse session id')
  assert(
    call.launchedTemplateId === 'browser-doc-desktop-deliver-template',
    'approve should pass launched template id',
  )
  assert(call.task.length > 0, 'approve should forward launch prompt task')
  const record = harness.sessions.get('approve-session')
  assert(record, 'approve session record should exist')
  assert(
    record.pendingTemplateLaunch === undefined,
    'approve should clear pending launch record before startTask completes',
  )
}

async function testReadPreflightMissingTemplate(): Promise<void> {
  const harness = createHarness()

  const result = await harness.flow.readPreflight('missing-template')

  assert(
    result.kind === 'template_not_found',
    'readPreflight should report missing template',
  )
}

function createHarness(input?: {
  windowsMcpStatus?: WindowsMcpStatusView
  scorecardSummary?: ScorecardSummaryView
}) {
  const sessions = new Map<string, SessionRecord>()
  const startTaskCalls: Array<{
    sessionId: string
    task: string
    launchedTemplateId?: string
  }> = []
  const windowsMcpStatus =
    input?.windowsMcpStatus ??
    ({
      mode: 'endpoint',
      state: 'ready',
      reachable: true,
      summary: 'ready',
      windowCount: 2,
      observationConfidence: 0.9,
    } satisfies WindowsMcpStatusView)
  const scorecardSummary =
    input?.scorecardSummary ??
    ({
      totals: {
        total_runs: 1,
        pass: 1,
      },
      templateTotals: {
        'browser-doc-desktop-deliver-template': {
          total_runs: 1,
          pass: 1,
        },
      },
      familyTotals: {},
    } satisfies ScorecardSummaryView)
  const governance: ProductGovernanceView = {
    supportMatrixPath: 'support-matrix.json',
    scorecardArtifactPath: 'scorecard.json',
    permissionDefaults: [],
    exclusions: [],
    ordinaryUserNotes: [],
  }

  const flow = createTemplateLaunchFlow({
    sessions,
    windowsMcpService: {} as never,
    permissionMode: 'default',
    async readWindowsMcpStatus() {
      return windowsMcpStatus
    },
    async readScorecardSummary() {
      return scorecardSummary
    },
    buildGovernanceView() {
      return governance
    },
    async startTask(sessionId, task, launchedTemplateId) {
      startTaskCalls.push({
        sessionId,
        task,
        launchedTemplateId,
      })
      const record =
        sessions.get(sessionId) ?? createSessionRecord(sessionId, windowsMcpStatus)
      record.task = task
      record.state = {
        ...record.state,
        submittedTask: task,
        launchedTemplateId,
        isRunning: true,
        updatedAt: new Date().toISOString(),
      }
      sessions.set(sessionId, record)
      return record
    },
  })

  return {
    flow,
    sessions,
    startTaskCalls,
  }
}

function createSessionRecord(
  sessionId: string,
  windowsMcpStatus: WindowsMcpStatusView,
): SessionRecord {
  return {
    sessionId,
    state: createState(sessionId, windowsMcpStatus),
    timeline: [],
  }
}

function createState(
  sessionId: string,
  windowsMcpStatus: WindowsMcpStatusView,
): ProductizationPanelState {
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
    windowsMcpStatus,
    updatedAt: new Date(0).toISOString(),
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
