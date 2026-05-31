import { createSessionControlFlow } from './sessionControlFlow.js'
import type { SessionRecord } from './sessionStore.js'
import type { ProductizationPanelState } from './panelTypes.js'

async function main(): Promise<void> {
  await testStopMissingSession()
  await testStopActiveSession()
  await testResolveMissingPermission()
  await testResolvePermissionDecision()
  console.log('session-control-flow-regression ok')
}

async function testStopMissingSession(): Promise<void> {
  const flow = createSessionControlFlow({
    sessions: new Map(),
  })

  const result = flow.stopSession('missing')
  assert(result.kind === 'session_not_found', 'missing session should return session_not_found')
}

async function testStopActiveSession(): Promise<void> {
  const sessions = new Map<string, SessionRecord>()
  let aborted: boolean = false
  const abortController = new AbortController()
  abortController.signal.addEventListener('abort', () => {
    aborted = true
  })
  const record = createSessionRecord('running-session')
  record.abortController = abortController
  sessions.set(record.sessionId, record)
  const flow = createSessionControlFlow({ sessions })

  const result = flow.stopSession(record.sessionId)

  assert(result.kind === 'accepted', 'active session stop should be accepted')
  assert(aborted, 'stop should abort the active controller')
  assert(result.state.stopReason === 'aborted', 'stop should surface aborted stopReason')
  assert(result.state.isRunning === false, 'stop should mark the session as not running')
  assert(
    result.state.emergencyStopAvailable === false,
    'stop should disable emergency stop availability',
  )
  assert(result.state.timeline.length === 1, 'stop should append one timeline event')
}

async function testResolveMissingPermission(): Promise<void> {
  const flow = createSessionControlFlow({
    sessions: new Map(),
  })

  const result = flow.resolvePermissionDecision({
    sessionId: 'missing',
    decision: 'approve',
  })
  assert(
    result.kind === 'no_pending_permission',
    'missing pending permission should return no_pending_permission',
  )
}

async function testResolvePermissionDecision(): Promise<void> {
  const sessions = new Map<string, SessionRecord>()
  let resolvedDecision: unknown
  const record = createSessionRecord('permission-session')
  record.pendingPermission = {
    id: 'pending-1',
    request: {} as NonNullable<SessionRecord['pendingPermission']>['request'],
    resolve(decision) {
      resolvedDecision = decision
    },
  }
  sessions.set(record.sessionId, record)
  const flow = createSessionControlFlow({ sessions })

  const result = flow.resolvePermissionDecision({
    sessionId: record.sessionId,
    decision: 'approve',
    grantScope: 'tool',
    reason: 'approved for regression',
  })

  assert(result.kind === 'accepted', 'permission decision should be accepted')
  assert(record.pendingPermission === undefined, 'pending permission should be cleared')
  assert(
    record.state.pendingPermission === undefined,
    'panel state should clear pending permission view',
  )
  assert(
    typeof record.state.updatedAt === 'string' && record.state.updatedAt.length > 0,
    'permission decision should refresh updatedAt',
  )
  const resolved = resolvedDecision as {
    approved?: unknown
    grantScope?: unknown
    reason?: unknown
  }
  assert(resolved.approved === true, 'resolved decision should mark approved=true')
  assert(resolved.grantScope === 'tool', 'resolved decision should keep grantScope')
  assert(
    resolved.reason === 'approved for regression',
    'resolved decision should keep reason text',
  )
}

function createSessionRecord(sessionId: string): SessionRecord {
  return {
    sessionId,
    state: createState(sessionId),
    timeline: [],
  }
}

function createState(sessionId: string): ProductizationPanelState {
  return {
    sessionId,
    view: 'executing',
    currentStage: 'idle',
    stageLabel: 'Idle',
    isRunning: true,
    emergencyStopAvailable: true,
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
