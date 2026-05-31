import { createSystemProductFlow } from './systemProductFlow.js'
import type { SessionRecord } from './sessionStore.js'
import type {
  ProductGovernanceView,
  ProductizationPanelState,
  ScorecardSummaryView,
  WindowsMcpStatusView,
} from './panelTypes.js'

async function main(): Promise<void> {
  await testReadEndpoints()
  await testRestartUpdatesSessions()
  console.log('system-product-flow-regression ok')
}

async function testReadEndpoints(): Promise<void> {
  const flow = createFlow()

  const status = await flow.readWindowsMcpStatus()
  assert(status.state === 'ready', 'readWindowsMcpStatus should return mapped status')

  const matrix = await flow.readSupportMatrix()
  assert(Array.isArray(matrix.templates), 'readSupportMatrix should expose templates array')
  assert(Array.isArray(matrix.exclusions), 'readSupportMatrix should expose exclusions array')

  const scorecard = await flow.readScorecardSummary()
  assert(
    typeof scorecard.scorecard === 'object' && scorecard.scorecard !== null,
    'readScorecardSummary should expose scorecard object',
  )

  const governance = await flow.readGovernance()
  assert(
    Array.isArray(governance.permissionDefaults),
    'readGovernance should expose permissionDefaults',
  )
}

async function testRestartUpdatesSessions(): Promise<void> {
  const sessions = new Map<string, SessionRecord>()
  const record = createSessionRecord('restart-session')
  sessions.set(record.sessionId, record)

  const flow = createFlow(sessions)
  const view = await flow.restartWindowsMcp()

  assert(view.state === 'ready', 'restart should return mapped ready view')
  assert(record.state.windowsMcpStatus.state === 'ready', 'restart should refresh session windows status')
  assert(Array.isArray(record.state.recommendedTemplates), 'restart should refresh recommended templates')
  assert(record.state.recommendedTemplates!.length > 0, 'restart should populate recommended templates')
  assert(
    typeof record.state.scorecardSummary === 'object' && record.state.scorecardSummary !== null,
    'restart should refresh scorecard summary',
  )
  assert(
    typeof record.state.governance === 'object' && record.state.governance !== null,
    'restart should refresh governance view',
  )
}

function createFlow(sessions = new Map<string, SessionRecord>()) {
  const windowsMcpStatus: WindowsMcpStatusView = {
    mode: 'endpoint',
    state: 'ready',
    reachable: true,
    summary: 'ready',
  }
  const scorecardSummary: ScorecardSummaryView = {
    totals: { pass: 1, total_runs: 1 },
    templateTotals: {
      'browser-doc-desktop-deliver-template': {
        total_runs: 1,
        pass: 1,
      },
    },
    familyTotals: {},
  }
  const governance: ProductGovernanceView = {
    supportMatrixPath: 'support-matrix.json',
    scorecardArtifactPath: 'scorecard.json',
    permissionDefaults: [],
    exclusions: [],
    ordinaryUserNotes: [],
  }
  const service = {
    async restart() {
      return {
        state: 'ready',
        endpointUrl: 'http://127.0.0.1:8010/mcp',
        detail: 'ready',
        checkedAt: new Date(0).toISOString(),
        configPath: 'memory/windows-mcp-service.json',
        launchedByService: false,
        reusedExistingEndpoint: true,
        pid: 1234,
        lastError: undefined,
      }
    },
  }

  return createSystemProductFlow({
    sessions,
    windowsMcpService: service as never,
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
    mapRestartStatus() {
      return windowsMcpStatus
    },
  })
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
      state: 'starting',
      reachable: false,
      summary: 'starting',
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
