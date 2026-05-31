import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { ensureWindowsMcpReady } from './windowsMcpRuntime.js'

type PermissionMode = 'default' | 'auto' | 'confirm-high-risk' | 'read-only'

type ScorecardOptions = {
  endpoint: string
  permissionMode: PermissionMode
  runs: number
  cooldownMs: number
  maxTotalMinutes: number
  perRunTimeoutMs: number
  restartWindowsMcpOnFailure: boolean
  browserRefocusBetweenRuns: boolean
  desktopResetBetweenRuns: boolean
  stopOnFailureThreshold: number
  jsonOut?: string
}

type ScenarioStatus =
  | 'pass'
  | 'skip'
  | 'verification_failed'
  | 'environment_unready'
  | 'transport_error'
  | 'provider_error'
  | 'permission_blocked'
  | 'missing_dependency'
  | 'execution_failed'
  | 'routing_failed'

type ClaimGateVerdict = 'pass' | 'fail' | 'insufficient_evidence'

type Totals = Record<ScenarioStatus, number> & {
  total_runs: number
}

type ParsedRecord = {
  status: ScenarioStatus
  run: number
  scenario: string
  template: string
  family: string
}

type RunReport = {
  run: number
  records: ParsedRecord[]
  durationMs: number
  restartCount: number
  healthcheckCount: number
}

type ClaimGateEvaluation = {
  totalRuns: number
  passCount: number
  nonPassCount: number
  passRate: number
  sampleTarget: number
  sampleGateMet: boolean
  passRateGateMet: boolean
  regressionFailureCount: number
  infrastructureFailureCount: number
  evidenceGapCount: number
  claimGate: ClaimGateVerdict
  reasonCodes: string[]
}

type TemplateAssessment = {
  template: string
  family: string
  totals: Totals
  claim: ClaimGateEvaluation
}

type FamilyAssessment = {
  family: string
  totals: Totals
  claim: ClaimGateEvaluation
  templateCount: number
}

type OverallAssessment = {
  totals: Totals
  claim: ClaimGateEvaluation
  templateGatePassCount: number
  templateGateFailCount: number
  templateGateInsufficientCount: number
  overallClaimGate: ClaimGateVerdict
  reasonCodes: string[]
}

type WeakTemplateTopUpCandidate = {
  template: string
  family: string
  currentRuns: number
  targetRuns: number
  additionalRunsNeeded: number
  currentPassRate: number
  claimGate: ClaimGateVerdict
  reasonCodes: string[]
}

type WeakTemplateTopUpPlan = {
  status: 'ready' | 'not_applicable'
  triggerSuiteRuns: number
  currentSuiteRuns: number
  targetTemplateRuns: number
  runnerGranularity: 'full_suite_only'
  candidateCount: number
  additionalFullSuiteRunsNeeded: number
  candidates: WeakTemplateTopUpCandidate[]
}

const STATUS_ORDER: readonly ScenarioStatus[] = [
  'pass',
  'skip',
  'verification_failed',
  'environment_unready',
  'transport_error',
  'provider_error',
  'permission_blocked',
  'missing_dependency',
  'execution_failed',
  'routing_failed',
] as const

const CLAIM_TARGET_PASS_RATE = 0.95
const CLAIM_MIN_TEMPLATE_RUNS = 20
const WEAK_TEMPLATE_TOPUP_TRIGGER_RUNS = 10
const WEAK_TEMPLATE_TOPUP_TARGET_RUNS = 20

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const windowsMcp = await ensureWindowsMcpReady({
    endpoint: options.endpoint,
    launchIfNeeded: true,
  })
  options.endpoint = windowsMcp.endpoint
  const service = windowsMcp.service

  try {
    const deadline = Date.now() + options.maxTotalMinutes * 60_000

    const templateTotals = new Map<string, Totals>()
    const familyTotals = new Map<string, Totals>()
    const templateFamilies = new Map<string, string>()
    const familyTemplateMembers = new Map<string, Set<string>>()
    const overallTotals = createTotals()

    let cooldownCount = 0
    let serviceRestartCount = 0
    let healthcheckCount = 0
    let earlyStopReason: string | undefined
    let consecutiveHardFailures = 0
    let completedSuiteRuns = 0

    for (let run = 1; run <= options.runs; run += 1) {
      if (Date.now() > deadline) {
        earlyStopReason = `max_total_minutes_exceeded run=${run}`
        break
      }

      if (run > 1) {
        cooldownCount += 1
        await delay(options.cooldownMs)
      }

      if (run === 1 || run % 3 === 1) {
        healthcheckCount += 1
        const status = await service.healthcheck()
        if (status.state === 'failed' || status.state === 'disconnected') {
          if (options.restartWindowsMcpOnFailure) {
            serviceRestartCount += 1
            await service.restart()
          } else {
            earlyStopReason = `service_unready state=${status.state}`
            break
          }
        }
      }

      const runStart = Date.now()
      if (options.browserRefocusBetweenRuns) {
        console.log(`[scorecard-control] run=${run} browser_refocus_between_runs=true`)
      }
      if (options.desktopResetBetweenRuns) {
        console.log(`[scorecard-control] run=${run} desktop_reset_between_runs=true`)
        await resetLiveSmokeDesktop()
      }

      let execution = await runPhase5LiveSmoke({
        endpoint: options.endpoint,
        permissionMode: options.permissionMode,
        runs: 1,
        timeoutMs: options.perRunTimeoutMs,
      })
      if (execution.exitCode !== 0 && options.restartWindowsMcpOnFailure) {
        serviceRestartCount += 1
        await service.restart()
        console.log(
          `[scorecard-control] run=${run} phase5_live_smoke_retry_after_exit_code=${execution.exitCode}`,
        )
        execution = await runPhase5LiveSmoke({
          endpoint: options.endpoint,
          permissionMode: options.permissionMode,
          runs: 1,
          timeoutMs: options.perRunTimeoutMs,
        })
      }
      const records = parsePhase5LiveSmokeRecords(execution.stdout)
      if (execution.exitCode !== 0) {
        throw new Error(
          `phase5-scorecard failed because phase5-live-smoke exited with code ${execution.exitCode}`,
        )
      }
      if (records.length === 0) {
        throw new Error(
          'phase5-scorecard did not receive any phase5-live-smoke scenario records',
        )
      }

      completedSuiteRuns += 1
      const report: RunReport = {
        run,
        records,
        durationMs: Date.now() - runStart,
        restartCount: serviceRestartCount,
        healthcheckCount,
      }

      let hardFailureInRun = false
      for (const record of report.records) {
        templateFamilies.set(record.template, record.family)
        ensureTemplateMember(familyTemplateMembers, record.family, record.template)
        incrementTotals(overallTotals, record.status)
        incrementTotals(ensureTotals(templateTotals, record.template), record.status)
        incrementTotals(ensureTotals(familyTotals, record.family), record.status)
        if (isHardFailureStatus(record.status)) {
          hardFailureInRun = true
        }
      }

      console.log(
        `phase5-scorecard run=${report.run} run_duration_ms=${report.durationMs} scenarios=${report.records.length} hard_failure_in_run=${hardFailureInRun} healthcheck_count=${report.healthcheckCount} service_restart_count=${report.restartCount}`,
      )

      if (hardFailureInRun) {
        consecutiveHardFailures += 1
        if (options.restartWindowsMcpOnFailure) {
          serviceRestartCount += 1
          await service.restart()
        }
      } else {
        consecutiveHardFailures = 0
      }

      if (consecutiveHardFailures >= options.stopOnFailureThreshold) {
        earlyStopReason = `stop_on_failure_threshold=${options.stopOnFailureThreshold}`
        break
      }
    }

    const templateAssessments = [...templateTotals.entries()]
      .map(([template, totals]) => ({
        template,
        family: templateFamilies.get(template) ?? 'unknown',
        totals,
        claim: evaluateClaimGate(totals, CLAIM_MIN_TEMPLATE_RUNS),
      }))
      .sort((left, right) => left.template.localeCompare(right.template))

    const familyAssessments = [...familyTotals.entries()]
      .map(([family, totals]) => {
        const templateCount = familyTemplateMembers.get(family)?.size ?? 0
        return {
          family,
          totals,
          claim: evaluateClaimGate(
            totals,
            Math.max(1, templateCount) * CLAIM_MIN_TEMPLATE_RUNS,
          ),
          templateCount,
        }
      })
      .sort((left, right) => left.family.localeCompare(right.family))

    const overallAssessment = buildOverallAssessment(
      overallTotals,
      templateAssessments,
      completedSuiteRuns,
      options.runs,
      earlyStopReason,
    )
    const topUpPlan = buildWeakTemplateTopUpPlan(templateAssessments, completedSuiteRuns)

    for (const assessment of templateAssessments) {
      console.log(
        formatScorecardLine({
          section: 'template',
          keyName: 'template',
          keyValue: assessment.template,
          totals: assessment.totals,
        }),
      )
      console.log(
        formatClaimGateLine({
          section: 'template',
          keyName: 'template',
          keyValue: assessment.template,
          family: assessment.family,
          claim: assessment.claim,
        }),
      )
    }

    for (const assessment of familyAssessments) {
      console.log(
        formatScorecardLine({
          section: 'family',
          keyName: 'family',
          keyValue: assessment.family,
          totals: assessment.totals,
        }),
      )
      console.log(
        formatClaimGateLine({
          section: 'family',
          keyName: 'family',
          keyValue: assessment.family,
          extraSegments: [`template_count=${assessment.templateCount}`],
          claim: assessment.claim,
        }),
      )
    }

    console.log(
      formatScorecardLine({
        section: 'overall',
        totals: overallTotals,
      }),
    )
    console.log(
      formatClaimGateLine({
        section: 'overall',
        extraSegments: [
          `completed_suite_runs=${completedSuiteRuns}`,
          `requested_suite_runs=${options.runs}`,
          `template_gate_pass=${overallAssessment.templateGatePassCount}`,
          `template_gate_fail=${overallAssessment.templateGateFailCount}`,
          `template_gate_insufficient=${overallAssessment.templateGateInsufficientCount}`,
          `overall_claim_gate=${overallAssessment.overallClaimGate}`,
          `overall_reason_codes=${joinReasonCodes(overallAssessment.reasonCodes)}`,
        ],
        claim: overallAssessment.claim,
      }),
    )
    console.log(formatTopUpPlanLine(topUpPlan))
    for (const candidate of topUpPlan.candidates) {
      console.log(formatTopUpCandidateLine(candidate))
    }
    console.log(
      `phase5-scorecard control requested_suite_runs=${options.runs} completed_suite_runs=${completedSuiteRuns} total_runs=${overallTotals.total_runs} cooldown_count=${cooldownCount} service_restart_count=${serviceRestartCount} healthcheck_count=${healthcheckCount} early_stop_reason=${earlyStopReason ?? 'none'}`,
    )

    if (options.jsonOut) {
      await writeScorecardJson(options.jsonOut, {
        generatedAt: new Date().toISOString(),
        endpoint: options.endpoint,
        permissionMode: options.permissionMode,
        totals: overallTotals,
        templateTotals: Object.fromEntries(templateTotals),
        familyTotals: Object.fromEntries(familyTotals),
        control: {
          requestedSuiteRuns: options.runs,
          completedSuiteRuns,
          cooldownCount,
          serviceRestartCount,
          healthcheckCount,
          earlyStopReason: earlyStopReason ?? 'none',
        },
        claimThresholds: {
          targetPassRate: CLAIM_TARGET_PASS_RATE,
          minTemplateRuns: CLAIM_MIN_TEMPLATE_RUNS,
          weakTemplateTopUpTriggerRuns: WEAK_TEMPLATE_TOPUP_TRIGGER_RUNS,
          weakTemplateTopUpTargetRuns: WEAK_TEMPLATE_TOPUP_TARGET_RUNS,
          gateMode: 'threshold',
        },
        assessments: {
          templates: Object.fromEntries(
            templateAssessments.map(assessment => [
              assessment.template,
              {
                family: assessment.family,
                totals: assessment.totals,
                claim: assessment.claim,
              },
            ]),
          ),
          families: Object.fromEntries(
            familyAssessments.map(assessment => [
              assessment.family,
              {
                templateCount: assessment.templateCount,
                totals: assessment.totals,
                claim: assessment.claim,
              },
            ]),
          ),
          overall: overallAssessment,
        },
        topUpPlan,
      })
    }
  } finally {
    await windowsMcp.dispose()
  }
}

async function resetLiveSmokeDesktop(): Promise<void> {
  const script = [
    '$notepadTargets = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object {',
    "  $_.MainWindowTitle -like '*phase4-live-reply-editor-*' -or",
    "  $_.MainWindowTitle -eq '无标题 - 记事本' -or",
    "  $_.MainWindowTitle -eq 'Untitled - Notepad'",
    '}',
    "$edgeTargets = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.MainWindowTitle -like '*compuser phase4 browser smoke*'",
    '}',
    "$chromeTargets = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.MainWindowTitle -like '*compuser phase4 browser smoke*'",
    '}',
    "$firefoxTargets = Get-Process firefox -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.MainWindowTitle -like '*compuser phase4 browser smoke*'",
    '}',
    '$calcTargets = Get-Process CalculatorApp -ErrorAction SilentlyContinue',
    '$targets = @()',
    'if ($notepadTargets) { $targets += $notepadTargets }',
    'if ($edgeTargets) { $targets += $edgeTargets }',
    'if ($chromeTargets) { $targets += $chromeTargets }',
    'if ($firefoxTargets) { $targets += $firefoxTargets }',
    'if ($calcTargets) { $targets += $calcTargets }',
    'if ($targets) {',
    '  $targets | Stop-Process -Force',
    '}',
  ].join('\n')

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if ((code ?? 1) === 0) {
        resolvePromise()
        return
      }
      reject(new Error(stderr.trim() || `desktop reset failed with code ${code ?? 1}`))
    })
  })

  await delay(1_000)
}

function parseArgs(argv: string[]): ScorecardOptions {
  const endpoint =
    argv.find((value, index) => argv[index - 1] === '--endpoint') ??
    process.env.COMPUSER_WINDOWS_MCP_ENDPOINT ??
    DEFAULT_WINDOWS_MCP_ENDPOINT

  const permissionMode =
    (argv.find((value, index) => argv[index - 1] === '--permission-mode') as
      | PermissionMode
      | undefined) ??
    (process.env.COMPUSER_PERMISSION_MODE as PermissionMode | undefined) ??
    'auto'

  const rawRuns =
    argv.find((value, index) => argv[index - 1] === '--runs') ??
    process.env.COMPUSER_PHASE5_LIVE_SMOKE_RUNS ??
    '3'
  const rawCooldownMs =
    argv.find((value, index) => argv[index - 1] === '--cooldown-ms') ??
    process.env.COMPUSER_PHASE5_SCORECARD_COOLDOWN_MS ??
    '5000'
  const rawMaxTotalMinutes =
    argv.find((value, index) => argv[index - 1] === '--max-total-minutes') ??
    process.env.COMPUSER_PHASE5_SCORECARD_MAX_TOTAL_MINUTES ??
    '20'
  const rawPerRunTimeoutMs =
    argv.find((value, index) => argv[index - 1] === '--per-run-timeout-ms') ??
    process.env.COMPUSER_PHASE5_SCORECARD_PER_RUN_TIMEOUT_MS ??
    '300000'
  const rawStopOnFailureThreshold =
    argv.find((value, index) => argv[index - 1] === '--stop-on-failure-threshold') ??
    process.env.COMPUSER_PHASE5_SCORECARD_STOP_ON_FAILURE_THRESHOLD ??
    '2'
  const jsonOut =
    argv.find((value, index) => argv[index - 1] === '--json-out') ??
    process.env.COMPUSER_PHASE5_SCORECARD_JSON_OUT

  return {
    endpoint,
    permissionMode,
    runs: parsePositiveInteger(rawRuns, 3),
    cooldownMs: parsePositiveInteger(rawCooldownMs, 5000),
    maxTotalMinutes: parsePositiveInteger(rawMaxTotalMinutes, 20),
    perRunTimeoutMs: parsePositiveInteger(rawPerRunTimeoutMs, 300000),
    restartWindowsMcpOnFailure: readBooleanFlag(
      argv,
      '--restart-windows-mcp-on-failure',
      process.env.COMPUSER_PHASE5_SCORECARD_RESTART_WINDOWS_MCP_ON_FAILURE,
      false,
    ),
    browserRefocusBetweenRuns: readBooleanFlag(
      argv,
      '--browser-refocus-between-runs',
      process.env.COMPUSER_PHASE5_SCORECARD_BROWSER_REFOCUS_BETWEEN_RUNS,
      false,
    ),
    desktopResetBetweenRuns: readBooleanFlag(
      argv,
      '--desktop-reset-between-runs',
      process.env.COMPUSER_PHASE5_SCORECARD_DESKTOP_RESET_BETWEEN_RUNS,
      false,
    ),
    stopOnFailureThreshold: parsePositiveInteger(rawStopOnFailureThreshold, 2),
    jsonOut,
  }
}

function createTotals(): Totals {
  return {
    total_runs: 0,
    pass: 0,
    skip: 0,
    verification_failed: 0,
    environment_unready: 0,
    transport_error: 0,
    provider_error: 0,
    permission_blocked: 0,
    missing_dependency: 0,
    execution_failed: 0,
    routing_failed: 0,
  }
}

function incrementTotals(totals: Totals, status: ScenarioStatus): void {
  totals.total_runs += 1
  totals[status] += 1
}

function ensureTotals(store: Map<string, Totals>, key: string): Totals {
  const existing = store.get(key)
  if (existing) {
    return existing
  }
  const created = createTotals()
  store.set(key, created)
  return created
}

function ensureTemplateMember(
  store: Map<string, Set<string>>,
  family: string,
  template: string,
): void {
  const existing = store.get(family)
  if (existing) {
    existing.add(template)
    return
  }
  store.set(family, new Set([template]))
}

function formatScorecardLine(input: {
  section: 'template' | 'family' | 'overall'
  totals: Totals
  keyName?: 'template' | 'family'
  keyValue?: string
}): string {
  const keySegment =
    input.keyName && input.keyValue ? ` ${input.keyName}=${input.keyValue}` : ''
  return `phase5-scorecard section=${input.section}${keySegment} total_runs=${input.totals.total_runs} ${STATUS_ORDER.map(status => `${status}=${input.totals[status]}`).join(' ')}`
}

function formatClaimGateLine(input: {
  section: 'template' | 'family' | 'overall'
  claim: ClaimGateEvaluation
  keyName?: 'template' | 'family'
  keyValue?: string
  family?: string
  extraSegments?: string[]
}): string {
  const keySegment =
    input.keyName && input.keyValue ? ` ${input.keyName}=${input.keyValue}` : ''
  const familySegment = input.family ? ` family=${input.family}` : ''
  const extraSegments = input.extraSegments ?? []
  const segments = [
    `phase5-scorecard claim section=${input.section}${keySegment}${familySegment}`,
    `claim_gate=${input.claim.claimGate}`,
    `sample_target=${input.claim.sampleTarget}`,
    `sample_gate_met=${input.claim.sampleGateMet}`,
    `pass_rate=${formatRate(input.claim.passRate)}`,
    `pass_rate_gate_met=${input.claim.passRateGateMet}`,
    `pass_count=${input.claim.passCount}`,
    `non_pass_count=${input.claim.nonPassCount}`,
    `regression_failures=${input.claim.regressionFailureCount}`,
    `infrastructure_failures=${input.claim.infrastructureFailureCount}`,
    `evidence_gaps=${input.claim.evidenceGapCount}`,
    `reason_codes=${joinReasonCodes(input.claim.reasonCodes)}`,
    ...extraSegments,
  ]
  return segments.join(' ')
}

function formatTopUpPlanLine(plan: WeakTemplateTopUpPlan): string {
  return [
    'phase5-scorecard topup',
    `status=${plan.status}`,
    `trigger_suite_runs=${plan.triggerSuiteRuns}`,
    `current_suite_runs=${plan.currentSuiteRuns}`,
    `target_template_runs=${plan.targetTemplateRuns}`,
    `runner_granularity=${plan.runnerGranularity}`,
    `candidate_count=${plan.candidateCount}`,
    `additional_full_suite_runs_needed=${plan.additionalFullSuiteRunsNeeded}`,
  ].join(' ')
}

function formatTopUpCandidateLine(candidate: WeakTemplateTopUpCandidate): string {
  return [
    'phase5-scorecard topup-candidate',
    `template=${candidate.template}`,
    `family=${candidate.family}`,
    `claim_gate=${candidate.claimGate}`,
    `current_runs=${candidate.currentRuns}`,
    `target_runs=${candidate.targetRuns}`,
    `additional_runs_needed=${candidate.additionalRunsNeeded}`,
    `current_pass_rate=${formatRate(candidate.currentPassRate)}`,
    `reason_codes=${joinReasonCodes(candidate.reasonCodes)}`,
  ].join(' ')
}

async function runPhase5LiveSmoke(options: {
  endpoint: string
  permissionMode: PermissionMode
  runs: number
  timeoutMs: number
}): Promise<{
  exitCode: number
  stdout: string
}> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url))
  const phase5Entry = resolve(cliDirectory, 'phase5-live-smoke.js')
  const args = [
    phase5Entry,
    '--endpoint',
    options.endpoint,
    '--permission-mode',
    options.permissionMode,
    '--runs',
    String(options.runs),
  ]

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        COMPUSER_WINDOWS_MCP_MANAGED_BY_PARENT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const killTimer = setTimeout(() => {
      if (settled) {
        return
      }

      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL')
        }
      }, 2000).unref()
    }, options.timeoutMs)

    child.stdout.on('data', chunk => {
      const text = String(chunk)
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(killTimer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(killTimer)
      if ((code ?? 1) !== 0 && stderr.trim().length > 0) {
        stdout += `\n${stderr}`
      }
      if (timedOut) {
        stdout += `\ntransport_error phase5-live-smoke timed out after ${options.timeoutMs}ms`
      }
      resolvePromise({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
      })
    })
  })
}

function parsePhase5LiveSmokeRecords(stdout: string): ParsedRecord[] {
  const records: ParsedRecord[] = []
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    const match = line.match(
      /^\[([a-z_]+)\] phase5-live-smoke run=(\d+) scenario=([^ ]+) template=([^ ]+) family=([^ ]+)(?: .*)?$/,
    )
    if (!match) {
      continue
    }

    records.push({
      status: match[1] as ScenarioStatus,
      run: Number.parseInt(match[2], 10),
      scenario: match[3],
      template: match[4],
      family: match[5],
    })
  }

  return records
}

function evaluateClaimGate(
  totals: Totals,
  sampleTarget: number,
): ClaimGateEvaluation {
  const passCount = totals.pass
  const totalRuns = totals.total_runs
  const nonPassCount = Math.max(0, totalRuns - passCount)
  const passRate = totalRuns > 0 ? passCount / totalRuns : 0
  const regressionFailureCount =
    totals.verification_failed + totals.execution_failed + totals.routing_failed
  const infrastructureFailureCount =
    totals.transport_error +
    totals.provider_error +
    totals.permission_blocked +
    totals.missing_dependency
  const evidenceGapCount = totals.skip + totals.environment_unready
  const sampleGateMet = totalRuns >= sampleTarget
  const passRateGateMet = passRate >= CLAIM_TARGET_PASS_RATE

  const reasonCodes: string[] = []
  if (!sampleGateMet) {
    reasonCodes.push('sample_below_target')
  }
  if (!passRateGateMet) {
    reasonCodes.push('pass_rate_below_target')
  }
  if (regressionFailureCount > 0) {
    reasonCodes.push('regression_failures_present')
  }
  if (infrastructureFailureCount > 0) {
    reasonCodes.push('infrastructure_failures_present')
  }
  if (evidenceGapCount > 0) {
    reasonCodes.push('evidence_gaps_present')
  }
  if (totalRuns === 0) {
    reasonCodes.push('no_observations')
  }

  let claimGate: ClaimGateVerdict
  if (regressionFailureCount > 0 || infrastructureFailureCount > 0 || !passRateGateMet) {
    claimGate = 'fail'
  } else if (!sampleGateMet || evidenceGapCount > 0 || totalRuns === 0) {
    claimGate = 'insufficient_evidence'
  } else {
    claimGate = 'pass'
  }

  return {
    totalRuns,
    passCount,
    nonPassCount,
    passRate,
    sampleTarget,
    sampleGateMet,
    passRateGateMet,
    regressionFailureCount,
    infrastructureFailureCount,
    evidenceGapCount,
    claimGate,
    reasonCodes,
  }
}

function buildOverallAssessment(
  totals: Totals,
  templateAssessments: TemplateAssessment[],
  completedSuiteRuns: number,
  requestedSuiteRuns: number,
  earlyStopReason: string | undefined,
): OverallAssessment {
  const claim = evaluateClaimGate(
    totals,
    Math.max(1, templateAssessments.length) * CLAIM_MIN_TEMPLATE_RUNS,
  )
  const templateGatePassCount = templateAssessments.filter(
    assessment => assessment.claim.claimGate === 'pass',
  ).length
  const templateGateFailCount = templateAssessments.filter(
    assessment => assessment.claim.claimGate === 'fail',
  ).length
  const templateGateInsufficientCount = templateAssessments.filter(
    assessment => assessment.claim.claimGate === 'insufficient_evidence',
  ).length

  const reasonCodes = [...claim.reasonCodes]
  let overallClaimGate: ClaimGateVerdict

  if (templateGateFailCount > 0) {
    overallClaimGate = 'fail'
    reasonCodes.push('template_gate_failures_present')
  } else if (templateGateInsufficientCount > 0) {
    overallClaimGate = 'insufficient_evidence'
    reasonCodes.push('template_gate_insufficient_present')
  } else {
    overallClaimGate = claim.claimGate
  }

  if (completedSuiteRuns < requestedSuiteRuns) {
    reasonCodes.push('runner_stopped_early')
    if (overallClaimGate === 'pass') {
      overallClaimGate = 'insufficient_evidence'
    }
  }

  if (earlyStopReason?.startsWith('stop_on_failure_threshold=')) {
    reasonCodes.push('early_stop_on_failure_threshold')
    overallClaimGate = 'fail'
  } else if (earlyStopReason) {
    reasonCodes.push('early_stop_control')
    if (overallClaimGate === 'pass') {
      overallClaimGate = 'insufficient_evidence'
    }
  }

  return {
    totals,
    claim,
    templateGatePassCount,
    templateGateFailCount,
    templateGateInsufficientCount,
    overallClaimGate,
    reasonCodes: dedupeReasonCodes(reasonCodes),
  }
}

function buildWeakTemplateTopUpPlan(
  templateAssessments: TemplateAssessment[],
  completedSuiteRuns: number,
): WeakTemplateTopUpPlan {
  if (completedSuiteRuns !== WEAK_TEMPLATE_TOPUP_TRIGGER_RUNS) {
    return {
      status: 'not_applicable',
      triggerSuiteRuns: WEAK_TEMPLATE_TOPUP_TRIGGER_RUNS,
      currentSuiteRuns: completedSuiteRuns,
      targetTemplateRuns: WEAK_TEMPLATE_TOPUP_TARGET_RUNS,
      runnerGranularity: 'full_suite_only',
      candidateCount: 0,
      additionalFullSuiteRunsNeeded: 0,
      candidates: [],
    }
  }

  const candidates = templateAssessments
    .filter(
      assessment =>
        assessment.claim.claimGate !== 'pass' ||
        assessment.claim.totalRuns < WEAK_TEMPLATE_TOPUP_TARGET_RUNS,
    )
    .map(assessment => ({
      template: assessment.template,
      family: assessment.family,
      currentRuns: assessment.claim.totalRuns,
      targetRuns: WEAK_TEMPLATE_TOPUP_TARGET_RUNS,
      additionalRunsNeeded: Math.max(
        0,
        WEAK_TEMPLATE_TOPUP_TARGET_RUNS - assessment.claim.totalRuns,
      ),
      currentPassRate: assessment.claim.passRate,
      claimGate: assessment.claim.claimGate,
      reasonCodes: assessment.claim.reasonCodes,
    }))
    .sort((left, right) => left.template.localeCompare(right.template))

  return {
    status: 'ready',
    triggerSuiteRuns: WEAK_TEMPLATE_TOPUP_TRIGGER_RUNS,
    currentSuiteRuns: completedSuiteRuns,
    targetTemplateRuns: WEAK_TEMPLATE_TOPUP_TARGET_RUNS,
    runnerGranularity: 'full_suite_only',
    candidateCount: candidates.length,
    additionalFullSuiteRunsNeeded: candidates.reduce(
      (maxRuns, candidate) => Math.max(maxRuns, candidate.additionalRunsNeeded),
      0,
    ),
    candidates,
  }
}

function isHardFailureStatus(status: ScenarioStatus): boolean {
  return (
    status === 'transport_error' ||
    status === 'provider_error' ||
    status === 'execution_failed' ||
    status === 'routing_failed' ||
    status === 'verification_failed'
  )
}

function formatRate(value: number): string {
  return value.toFixed(4)
}

function joinReasonCodes(reasonCodes: string[]): string {
  return reasonCodes.length > 0 ? reasonCodes.join(',') : 'none'
}

function dedupeReasonCodes(reasonCodes: string[]): string[] {
  return [...new Set(reasonCodes)]
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readBooleanFlag(
  argv: string[],
  name: string,
  envValue: string | undefined,
  fallback: boolean,
): boolean {
  if (argv.includes(name)) {
    return true
  }
  if (envValue === '1' || envValue?.toLowerCase() === 'true') {
    return true
  }
  if (envValue === '0' || envValue?.toLowerCase() === 'false') {
    return false
  }
  return fallback
}

async function writeScorecardJson(
  filePath: string,
  payload: {
    generatedAt: string
    endpoint: string
    permissionMode: PermissionMode
    totals: Totals
    templateTotals: Record<string, Totals>
    familyTotals: Record<string, Totals>
    control: {
      requestedSuiteRuns: number
      completedSuiteRuns: number
      cooldownCount: number
      serviceRestartCount: number
      healthcheckCount: number
      earlyStopReason: string
    }
    claimThresholds: {
      targetPassRate: number
      minTemplateRuns: number
      weakTemplateTopUpTriggerRuns: number
      weakTemplateTopUpTargetRuns: number
      gateMode: 'threshold'
    }
    assessments: {
      templates: Record<
        string,
        {
          family: string
          totals: Totals
          claim: ClaimGateEvaluation
        }
      >
      families: Record<
        string,
        {
          templateCount: number
          totals: Totals
          claim: ClaimGateEvaluation
        }
      >
      overall: OverallAssessment
    }
    topUpPlan: WeakTemplateTopUpPlan
  },
): Promise<void> {
  const absolutePath = resolve(filePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, JSON.stringify(payload, null, 2), 'utf8')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
