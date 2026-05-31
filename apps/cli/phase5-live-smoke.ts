import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { runPhase4LiveSmokeWithOptions } from './phase4-live-smoke.js'

type SmokeOptions = {
  endpoint: string
  permissionMode: 'default' | 'auto' | 'confirm-high-risk' | 'read-only'
  runs: number
  windowsMcpManagedByParent: boolean
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

type ScenarioMetadata = {
  scenario: string
  template: string
  family: 'browser' | 'file' | 'multi_window'
}

type ScenarioRecord = ScenarioMetadata & {
  status: ScenarioStatus
  detail: string
}

type Totals = Record<ScenarioStatus, number> & {
  total_runs: number
}

type ChildExecution = {
  exitCode: number
  stdout: string
  stderr: string
}

const SCENARIOS: readonly ScenarioMetadata[] = [
  {
    scenario: 'browser-editor-chat-reply-template',
    template: 'browser-editor-chat-reply-template',
    family: 'browser',
  },
  {
    scenario: 'browser-doc-desktop-deliver-template',
    template: 'browser-doc-desktop-deliver-template',
    family: 'browser',
  },
  {
    scenario: 'file-browser-form-submit-template',
    template: 'file-browser-form-submit-template',
    family: 'file',
  },
  {
    scenario: 'multi-window-compare-summarize-deliver-template',
    template: 'multi-window-compare-summarize-deliver-template',
    family: 'multi_window',
  },
  {
    scenario: 'browser-extract-transform-post-template',
    template: 'browser-extract-transform-post-template',
    family: 'browser',
  },
] as const

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const totals = createTotals()

  for (let run = 1; run <= options.runs; run += 1) {
    const execution = await runPhase4LiveSmoke(options)
    const records = classifyPhase4LiveSmokeRun(execution)
    for (const record of records) {
      totals.total_runs += 1
      totals[record.status] += 1
      const detailSuffix = record.detail ? ` ${record.detail}` : ''
      console.log(
        `[${record.status}] phase5-live-smoke run=${run} scenario=${record.scenario} template=${record.template} family=${record.family}${detailSuffix}`,
      )
    }
  }

  console.log(formatSummaryLine('phase5-live-smoke summary', totals))
}

function parseArgs(argv: string[]): SmokeOptions {
  const endpoint =
    argv.find((value, index) => argv[index - 1] === '--endpoint') ??
    process.env.COMPUSER_WINDOWS_MCP_ENDPOINT ??
    DEFAULT_WINDOWS_MCP_ENDPOINT

  const permissionMode =
    (argv.find((value, index) => argv[index - 1] === '--permission-mode') as
      | SmokeOptions['permissionMode']
      | undefined) ??
    (process.env.COMPUSER_PERMISSION_MODE as SmokeOptions['permissionMode'] | undefined) ??
    'auto'

  const rawRuns =
    argv.find((value, index) => argv[index - 1] === '--runs') ??
    process.env.COMPUSER_PHASE5_LIVE_SMOKE_RUNS ??
    '1'
  const parsedRuns = Number.parseInt(rawRuns, 10)

  return {
    endpoint,
    permissionMode,
    runs: Number.isFinite(parsedRuns) && parsedRuns > 0 ? parsedRuns : 1,
    windowsMcpManagedByParent:
      process.env.COMPUSER_WINDOWS_MCP_MANAGED_BY_PARENT === '1' ||
      process.env.COMPUSER_WINDOWS_MCP_MANAGED_BY_PARENT?.toLowerCase() === 'true',
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

function formatSummaryLine(prefix: string, totals: Totals): string {
  return `${prefix} total_runs=${totals.total_runs} ${STATUS_ORDER.map(status => `${status}=${totals[status]}`).join(' ')}`
}

async function runPhase4LiveSmoke(options: SmokeOptions): Promise<ChildExecution> {
  const stdoutWrites: string[] = []
  const stderrWrites: string[] = []
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)

  ;(process.stdout.write as typeof process.stdout.write) = ((chunk, encoding?, callback?) => {
    const text = String(chunk)
    stdoutWrites.push(text)
    return originalStdoutWrite(chunk, encoding as never, callback as never)
  }) as typeof process.stdout.write
  ;(process.stderr.write as typeof process.stderr.write) = ((chunk, encoding?, callback?) => {
    const text = String(chunk)
    stderrWrites.push(text)
    return originalStderrWrite(chunk, encoding as never, callback as never)
  }) as typeof process.stderr.write

  try {
    await runPhase4LiveSmokeWithOptions({
      endpoint: options.endpoint,
      permissionMode: options.permissionMode,
      windowsMcpManagedByParent: options.windowsMcpManagedByParent,
    })
    return {
      exitCode: 0,
      stdout: stdoutWrites.join(''),
      stderr: stderrWrites.join(''),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderrWrites.push(`${message}\n`)
    return {
      exitCode: 1,
      stdout: stdoutWrites.join(''),
      stderr: stderrWrites.join(''),
    }
  } finally {
    ;(process.stdout.write as typeof process.stdout.write) = originalStdoutWrite
    ;(process.stderr.write as typeof process.stderr.write) = originalStderrWrite
  }
}

function classifyPhase4LiveSmokeRun(execution: ChildExecution): ScenarioRecord[] {
  const parsed = new Map<string, Omit<ScenarioRecord, keyof ScenarioMetadata>>()
  for (const line of splitLines(execution.stdout)) {
    const match = line.match(/^\[(pass|skip)\] phase4-live-smoke ([^ ]+)(?: (.*))?$/)
    if (!match) {
      continue
    }

    const scenario = match[2]
    if (!SCENARIOS.some(item => item.scenario === scenario)) {
      continue
    }

    const detail = (match[3] ?? '').trim()
    parsed.set(scenario, {
      status: classifyScenarioStatus(match[1] as 'pass' | 'skip', detail),
      detail,
    })
  }

  const fallback = classifyFallback(execution, parsed.size)
  return SCENARIOS.map(metadata => {
    const record = parsed.get(metadata.scenario)
    if (record) {
      return {
        ...metadata,
        ...record,
      }
    }

    return {
      ...metadata,
      status: fallback.status,
      detail: fallback.detail,
    }
  })
}

function classifyScenarioStatus(
  rawStatus: 'pass' | 'skip',
  detail: string,
): ScenarioStatus {
  if (rawStatus === 'pass') {
    return 'pass'
  }
  if (detail.startsWith('environment_unready ')) {
    return 'environment_unready'
  }
  if (
    detail.includes('browser target could not be focused safely') ||
    detail.includes('WeChat-like desktop target not found') ||
    detail.includes('Codex window not found') ||
    detail.includes('strong confirmable windows')
  ) {
    return 'environment_unready'
  }
  if (detail.startsWith('execution_failed ')) {
    return 'execution_failed'
  }
  if (detail.startsWith('verification_failed ')) {
    return 'verification_failed'
  }
  if (detail.startsWith('routing_failed ')) {
    return 'routing_failed'
  }
  if (detail.startsWith('permission_blocked ')) {
    return 'permission_blocked'
  }
  if (detail.startsWith('transport_error ')) {
    return 'transport_error'
  }
  if (detail.startsWith('missing_dependency ')) {
    return 'missing_dependency'
  }
  if (detail.startsWith('provider_error ')) {
    return 'provider_error'
  }
  return 'skip'
}

function classifyFallback(
  execution: ChildExecution,
  parsedScenarioCount: number,
): Pick<ScenarioRecord, 'status' | 'detail'> {
  const combinedOutput = `${execution.stdout}\n${execution.stderr}`
  const classifiedMatch = combinedOutput.match(
    /(?:Error:\s*)?(missing_dependency|transport_error|permission_blocked|environment_unready|verification_failed|provider_error|execution_failed|routing_failed)\s+([^\r\n]+)/,
  )
  if (classifiedMatch) {
    return {
      status: classifiedMatch[1] as ScenarioStatus,
      detail: `${classifiedMatch[1]} ${classifiedMatch[2].trim()}`,
    }
  }
  if (execution.exitCode !== 0) {
    return {
      status: 'provider_error',
      detail: `provider_error phase4-live-smoke exited with code ${execution.exitCode}`,
    }
  }
  if (parsedScenarioCount < SCENARIOS.length) {
    return {
      status: 'provider_error',
      detail: 'provider_error phase4-live-smoke did not report a classification for this scenario',
    }
  }
  return {
    status: 'skip',
    detail: 'skip phase4-live-smoke did not include a detailed classification',
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
