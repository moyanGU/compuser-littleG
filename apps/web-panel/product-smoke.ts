import { access, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  listRecommendedSupportTemplates,
  listVerifiedSupportTemplates,
} from '../../packages/product/SupportMatrix.js'
import {
  PANEL_DEFAULT_SESSION_ID,
  PRODUCT_SCORECARD_SUMMARY_PATH,
} from './defaults.js'

const port = 4319

async function main(): Promise<void> {
  await access(PRODUCT_SCORECARD_SUMMARY_PATH)
  const expectedTemplateIds = listVerifiedSupportTemplates().map(item => item.id).sort()
  const expectedRecommendedIds = listRecommendedSupportTemplates().map(item => item.id).sort()

  const child = spawn(process.execPath, ['dist/apps/web-panel/server.js', '--port', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForServer(child, port)

    const supportMatrixResponse = await fetch(`http://127.0.0.1:${port}/product/support-matrix`)
    assert(supportMatrixResponse.ok, 'GET /product/support-matrix should succeed')
    const supportMatrix = (await supportMatrixResponse.json()) as {
      templates?: unknown
      exclusions?: unknown
    }
    assert(Array.isArray(supportMatrix.templates), 'support matrix should expose templates')
    assert(Array.isArray(supportMatrix.exclusions), 'support matrix should expose exclusions')
    const supportMatrixIds = readTemplateIds(supportMatrix.templates).sort()
    assert(
      equalStringArrays(supportMatrixIds, expectedTemplateIds),
      'support matrix ids should match verified support templates',
    )

    const stateResponse = await fetch(`http://127.0.0.1:${port}/session/${PANEL_DEFAULT_SESSION_ID}/state`)
    assert(stateResponse.ok, 'GET /session/:id/state should succeed')
    const state = (await stateResponse.json()) as {
      recommendedTemplates?: unknown
      scorecardSummary?: unknown
      windowsMcpStatus?: unknown
    }
    assert(Array.isArray(state.recommendedTemplates), 'session state should expose recommendedTemplates')
    const recommendedIds = readTemplateIds(state.recommendedTemplates).sort()
    assert(
      equalStringArrays(recommendedIds, expectedRecommendedIds),
      'recommended template ids should match recommended support templates',
    )
    assert(
      typeof state.scorecardSummary === 'object' && state.scorecardSummary !== null,
      'session state should expose scorecardSummary',
    )
    const stateScorecard = state.scorecardSummary as {
      endpoint?: unknown
      assessments?: {
        overall?: {
          overallClaimGate?: unknown
        }
      }
    }
    assert(
      stateScorecard.assessments?.overall?.overallClaimGate === 'pass',
      'session state scorecard summary should expose overallClaimGate=pass for the published support claim',
    )
    assert(
      typeof stateScorecard.endpoint === 'string' && stateScorecard.endpoint.length > 0,
      'session state scorecard summary should expose the published scorecard endpoint',
    )
    assert(
      typeof state.windowsMcpStatus === 'object' && state.windowsMcpStatus !== null,
      'session state should expose windowsMcpStatus',
    )
    assert(
      (state.recommendedTemplates as Array<{
        launchPreview?: unknown
        likelyPauseReason?: unknown
        preflight?: { checks?: Array<{ category?: unknown }> }
      }>).every(
        item =>
          typeof item.launchPreview === 'string' &&
          typeof item.likelyPauseReason === 'string' &&
          Array.isArray(item.preflight?.checks) &&
          (item.preflight?.checks ?? []).every(check => typeof check.category === 'string'),
      ),
      'recommended templates should expose launch previews, likely pause reasons, and categorized preflight checks',
    )

    const scorecardResponse = await fetch(`http://127.0.0.1:${port}/product/scorecard-summary`)
    assert(scorecardResponse.ok, 'GET /product/scorecard-summary should succeed')
    const scorecardPayload = (await scorecardResponse.json()) as {
      scorecard?: unknown
    }
    assert(
      typeof scorecardPayload.scorecard === 'object' && scorecardPayload.scorecard !== null,
      'scorecard summary should expose scorecard payload',
    )
    assert(
      typeof (scorecardPayload.scorecard as { totals?: unknown }).totals === 'object' &&
        (scorecardPayload.scorecard as { totals?: unknown }).totals !== null,
      'scorecard summary should expose totals',
    )
    assert(
      ((scorecardPayload.scorecard as {
        assessments?: { overall?: { overallClaimGate?: unknown } }
      }).assessments?.overall?.overallClaimGate ?? null) === 'pass',
      'scorecard summary should expose overallClaimGate=pass',
    )

    const publishedScorecard = JSON.parse(
      await readFile(PRODUCT_SCORECARD_SUMMARY_PATH, 'utf8'),
    ) as {
      totals?: unknown
      templateTotals?: unknown
    }
    assert(
      typeof publishedScorecard.totals === 'object' && publishedScorecard.totals !== null,
      'published scorecard should expose totals',
    )
    assert(
      typeof publishedScorecard.templateTotals === 'object' && publishedScorecard.templateTotals !== null,
      'published scorecard should expose templateTotals',
    )

    const governanceResponse = await fetch(`http://127.0.0.1:${port}/product/governance`)
    assert(governanceResponse.ok, 'GET /product/governance should succeed')
    const governance = (await governanceResponse.json()) as {
      exclusions?: unknown
      permissionDefaults?: unknown
      ordinaryUserNotes?: unknown
      supportBoundary?: {
        machineScope?: unknown
        endpointScope?: unknown
        templateScope?: unknown
        supportedWindowClasses?: unknown
      }
    }
    assert(Array.isArray(governance.exclusions), 'governance should expose exclusions')
    assert(
      Array.isArray(governance.permissionDefaults),
      'governance should expose permissionDefaults',
    )
    assert(
      Array.isArray(governance.ordinaryUserNotes),
      'governance should expose ordinaryUserNotes',
    )
    assert(
      (governance.ordinaryUserNotes as unknown[]).some(
        item =>
          typeof item === 'string' &&
          (
            item.includes('95%+ claim gate') ||
            item.includes('95%+ 声明门槛')
          ),
      ),
      'governance should expose the published 95%+ claim-gate note',
    )
    assert(
      typeof governance.supportBoundary?.machineScope === 'string' &&
        governance.supportBoundary.machineScope.length > 0,
      'governance should expose machineScope boundary text',
    )
    assert(
      typeof governance.supportBoundary?.endpointScope === 'string' &&
        governance.supportBoundary.endpointScope.length > 0,
      'governance should expose endpointScope boundary text',
    )
    assert(
      typeof governance.supportBoundary?.templateScope === 'string' &&
        governance.supportBoundary.templateScope.length > 0,
      'governance should expose templateScope boundary text',
    )
    assert(
      Array.isArray(governance.supportBoundary?.supportedWindowClasses) &&
        governance.supportBoundary.supportedWindowClasses.length > 0,
      'governance should expose supportedWindowClasses',
    )

    const taskResponse = await fetch(`http://127.0.0.1:${port}/session/task`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: PANEL_DEFAULT_SESSION_ID,
        task: 'Inspect the workspace tree and summarize the current route.',
        attachments: [
          {
            name: 'notes.txt',
            mimeType: 'text/plain',
            base64: Buffer.from('uploaded from product smoke', 'utf8').toString('base64'),
          },
        ],
      }),
    })
    assert(taskResponse.ok, 'POST /session/task should return a response')
    const taskPayload = (await taskResponse.json()) as {
      error?: unknown
      sessionId?: unknown
      state?: {
        isRunning?: unknown
        emergencyStopAvailable?: unknown
      }
    }
    if (taskResponse.status === 200 || taskResponse.status === 202) {
      assert(typeof taskPayload.sessionId === 'string', 'task response should expose sessionId')
      assert(
        typeof taskPayload.state === 'object' && taskPayload.state !== null,
        'task response should expose state object',
      )
      assert(
        Array.isArray((taskPayload.state as { recommendedTemplates?: unknown }).recommendedTemplates),
        'task response should expose recommended templates immediately',
      )
      assert(
        (
          (taskPayload.state as {
            recommendedTemplates?: Array<{ preflight?: { status?: unknown } }>
          }).recommendedTemplates ?? []
        ).every(item => typeof item.preflight?.status === 'string'),
        'task response recommended templates should already expose preflight status',
      )
      if (taskResponse.status === 202) {
        assert(taskPayload.state?.isRunning === true, '202 task response should mark the task as running')
        assert(
          taskPayload.state?.emergencyStopAvailable === true,
          '202 task response should expose emergency stop availability',
        )
      }
    } else {
      assert(
        typeof taskPayload.error === 'string' && taskPayload.error.length > 0,
        'task failure response should expose error text',
      )
    }

    const stopResponse = await fetch(`http://127.0.0.1:${port}/session/${PANEL_DEFAULT_SESSION_ID}/stop`, {
      method: 'POST',
    })
    assert(stopResponse.ok, 'POST /session/:id/stop should succeed')
    const stopPayload = (await stopResponse.json()) as {
      accepted?: unknown
      state?: { stopReason?: unknown }
    }
    assert(stopPayload.accepted === true, 'stop endpoint should accept the stop request')
    assert(
      stopPayload.state?.stopReason === 'aborted',
      'stop endpoint should surface aborted stopReason',
    )

    const windowsStatusResponse = await fetch(`http://127.0.0.1:${port}/system/windows-mcp/status`)
    assert(windowsStatusResponse.ok, 'GET /system/windows-mcp/status should succeed')
    const windowsStatus = (await windowsStatusResponse.json()) as {
      state?: unknown
      configPath?: unknown
    }
    assert(typeof windowsStatus.state === 'string', 'windows-mcp status should expose state')
    assert(
      windowsStatus.configPath === undefined || typeof windowsStatus.configPath === 'string',
      'windows-mcp status should expose optional configPath string',
    )

    console.log(
      'product-smoke ok support_matrix scorecard_summary recommended_templates windows_mcp_status task_submission',
    )
  } finally {
    child.kill()
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

function equalStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function waitForServer(child: ReturnType<typeof spawn>, portValue: number): Promise<void> {
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
      const response = await fetch(`http://127.0.0.1:${portValue}/session/${PANEL_DEFAULT_SESSION_ID}/state`)
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
