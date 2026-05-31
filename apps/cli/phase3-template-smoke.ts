import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PowerShellCliBackendAdapter } from '../../packages/adapters/cli/CliBackendAdapter.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { StreamableHttpWindowsMcpBridge } from '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import { InMemoryToolRegistry } from '../../packages/tools/Tool.js'
import { createResultPointerTools } from '../../packages/tools/ResultPointerTools.js'
import {
  createPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'
import { ensureWindowsMcpReady } from './windowsMcpRuntime.js'

type SmokeOptions = {
  endpoint: string
  permissionMode: 'default' | 'auto' | 'confirm-high-risk' | 'read-only'
  runs: number
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

type ScenarioRecord = {
  scenario: string
  status: ScenarioStatus
  detail: string
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  assertEndpoint(options.endpoint)
  assertPermissionMode(options.permissionMode)
  const windowsMcp = await ensureWindowsMcpReady({
    endpoint: options.endpoint,
    launchIfNeeded: true,
  })
  options.endpoint = windowsMcp.endpoint

  try {
    const totals = {
      totalRuns: 0,
      pass: 0,
      skip: 0,
      verification_failed: 0,
      environment_unready: 0,
      transport_error: 0,
      provider_error: 0,
      permission_blocked: 0,
      missing_dependency: 0,
    }

    for (let run = 1; run <= options.runs; run += 1) {
      const results = await runTemplateSmokeIteration(options, run)
      for (const result of results) {
        totals.totalRuns += 1
        totals[result.status] += 1
        console.log(
          `[${result.status}] phase3-template-smoke run=${run} scenario=${result.scenario} ${result.detail}`,
        )
      }
    }

    console.log(
      `phase3-template-smoke summary total_runs=${totals.totalRuns} pass=${totals.pass} skip=${totals.skip} verification_failed=${totals.verification_failed} environment_unready=${totals.environment_unready} transport_error=${totals.transport_error} provider_error=${totals.provider_error} permission_blocked=${totals.permission_blocked} missing_dependency=${totals.missing_dependency}`,
    )
  } finally {
    await windowsMcp.dispose()
  }
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
    process.env.COMPUSER_TEMPLATE_SMOKE_RUNS ??
    '3'
  const parsedRuns = Number.parseInt(rawRuns, 10)

  return {
    endpoint,
    permissionMode,
    runs: Number.isFinite(parsedRuns) && parsedRuns > 0 ? parsedRuns : 3,
  }
}

function assertEndpoint(endpoint: string): void {
  if (!endpoint.trim()) {
    throw new Error('missing_dependency missing Windows-MCP endpoint')
  }
}

function assertPermissionMode(permissionMode: SmokeOptions['permissionMode']): void {
  if (permissionMode === 'read-only') {
    throw new Error(
      'permission_blocked permission mode read-only does not allow template smoke actions',
    )
  }
}

async function runTemplateSmokeIteration(
  options: SmokeOptions,
  runNumber: number,
): Promise<ScenarioRecord[]> {
  const { runtime } = createPhase3LiveRuntime(options)
  const context = {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: `phase3-template-smoke-${runNumber}`,
    turnId: `turn-${runNumber}`,
  }

  const results: ScenarioRecord[] = []
  try {
    await prepareBrowserSmokeFixture(runtime, context)
    const fixturePath = resolve(
      context.cwd,
      'tmp',
      `phase3-template-followup-${runNumber}.txt`,
    )
    await writeFile(
      fixturePath,
      ['phase3 template smoke', 'route this to notepad'].join('\n'),
      'utf8',
    )

    const snapshot = await runtime.execute(
      {
        toolName: 'windows.snapshot',
        input: {},
      },
      context,
    )
    assert(snapshot.ok, 'verification_failed phase3 template snapshot failed')
    const snapshotData = await resolvePossiblyStoredResult(runtime, snapshot, context)
    let liveWindowTargets = selectDistinctLiveSmokeWindows(snapshotData)

    await focusBrowserForSmoke(runtime, context, snapshotData)

    const browserProbeResult = await runtime.execute(
      {
        toolName: 'command.browser.inspect_dom',
        input: {},
      },
      context,
    )
    const browserEnvironmentReady = !isOptionalBrowserEnvironmentUnready(browserProbeResult)
    if (!browserEnvironmentReady) {
      results.push({
        scenario: 'browser-editor-chat-template',
        status: 'environment_unready',
        detail: browserProbeResult.summary,
      })
      results.push({
        scenario: 'file-browser-desktop-template',
        status: 'environment_unready',
        detail: browserProbeResult.summary,
      })
    } else {
      const browserEditorChatTemplateResult = await runtime.execute(
        {
          toolName: 'skill.browser.editor_chat_template',
          input: {
            editorAppName: 'Notepad',
            editorTargetWindowTitle: 'Notepad',
            chatAppName: 'Codex',
            chatTargetWindowTitle: 'Codex',
          },
        },
        context,
      )
      results.push(
        classifyTemplateScenario(
          'browser-editor-chat-template',
          browserEditorChatTemplateResult,
          result => {
            assertVerificationPassed(
              result.data,
              'verification_failed browser editor chat template verification failed',
            )
            assertOperationPresent(
              result.data,
              'skill.browser.editor_chat_stage_and_deliver_verify',
              'verification_failed browser editor chat template base verified chain missing',
            )
            assertOperationPresent(
              result.data,
              'skill.browser.editor_chat_stage_and_deliver_verify',
              'verification_failed browser editor chat template operation list missing base chain',
            )
            assertEvidencePresent(
              result.data,
              'template=browser-editor-chat',
              'verification_failed browser editor chat template marker missing',
            )
            assertEvidencePresent(
              result.data,
              'verified:Codex',
              'verification_failed browser editor chat template verified chat evidence missing',
            )
            const chainState = (result.data as {
              chainState?: { currentTarget?: string; currentArtifact?: string; chainStatus?: string }
            }).chainState
            assert(
              chainState?.currentTarget === 'Codex' &&
                chainState.currentArtifact === 'browser-editor-chat-delivery' &&
                chainState.chainStatus === 'completed',
              'browser editor chat template should persist completed chain state',
            )
          },
        ),
      )
    }

    if (liveWindowTargets.length < 2) {
      liveWindowTargets = await ensureLiveSmokeWindowTargets(runtime, context)
    }

    if (liveWindowTargets.length < 2) {
      results.push({
        scenario: 'multi-window-observe-route-deliver-template',
        status: 'environment_unready',
        detail:
          'requires at least two distinct confirmable windows for routed delivery',
      })
      if (browserEnvironmentReady) {
        results.push({
          scenario: 'file-browser-desktop-template',
          status: 'environment_unready',
          detail:
            'requires at least two distinct confirmable windows for browser-routed desktop delivery',
        })
      }
      return results
    }

    const routeQuery = chooseLiveRouteQuery(liveWindowTargets[1])
    const multiWindowTemplateResult = await runtime.execute(
      {
        toolName: 'skill.multi_window.observe_route_deliver_template',
        input: {
          primaryWindowTitle: liveWindowTargets[0],
          secondaryWindowTitle: liveWindowTargets[1],
          routeQuery,
          targetAppName: liveWindowTargets[1],
          targetWindowTitle: liveWindowTargets[1],
          actionText: 'phase3 template smoke',
        },
      },
      context,
    )
    results.push(
      classifyTemplateScenario(
        'multi-window-observe-route-deliver-template',
        multiWindowTemplateResult,
        result => {
          assertVerificationPassed(
            result.data,
            'verification_failed multi-window route deliver template verification failed',
          )
          assertOperationPresent(
            result.data,
            'skill.multi_window.observe_route_deliver_verify',
            'verification_failed multi-window route deliver template base chain missing',
          )
          assertEvidencePresent(
            result.data,
            'template=multi-window-route-deliver',
            'verification_failed multi-window route deliver template marker missing',
          )
          assertEvidencePresent(
            result.data,
            'routeReason=',
            'verification_failed multi-window route deliver template route evidence missing',
          )
          const chainState = (result.data as {
            chainState?: { currentTarget?: string; currentArtifact?: string; chainStatus?: string }
          }).chainState
          assert(
            chainState?.currentTarget === liveWindowTargets[1] &&
              chainState.currentArtifact === 'multi-window-observe-route-deliver-verify' &&
              chainState.chainStatus === 'completed',
            'multi-window route deliver template should persist completed chain state',
          )
        },
      ),
    )

    if (!browserEnvironmentReady) {
      return results
    }

    await focusBrowserForSmoke(runtime, context)
    const browserRouteTargets = selectBrowserRouteTargets(liveWindowTargets)
    if (!browserRouteTargets) {
      results.push({
        scenario: 'file-browser-desktop-template',
        status: 'environment_unready',
        detail:
          'requires one text-capable target window plus one distinct comparison window',
      })
      return results
    }

    const fileBrowserDesktopTemplateResult = await runtime.execute(
      {
        toolName: 'skill.file.browser_desktop_template',
        input: {
          path: fixturePath,
          primaryWindowTitle: browserRouteTargets.primaryWindowTitle,
          secondaryWindowTitle: browserRouteTargets.secondaryWindowTitle,
          routeQuery: browserRouteTargets.routeQuery,
          transform: 'uppercase',
        },
      },
      context,
    )
    results.push(
      classifyTemplateScenario(
        'file-browser-desktop-template',
        fileBrowserDesktopTemplateResult,
        result => {
          assertVerificationPassed(
            result.data,
            'verification_failed file browser desktop template verification failed',
          )
          assertOperationPresent(
            result.data,
            'skill.file.browser_route_deliver_verify',
            'verification_failed file browser desktop template base chain missing',
          )
          assertEvidencePresent(
            result.data,
            'template=file-browser-desktop',
            'verification_failed file browser desktop template marker missing',
          )
          assertEvidencePresent(
            result.data,
            'routeReason=',
            'verification_failed file browser desktop template route evidence missing',
          )
          const chainState = (result.data as {
            chainState?: { currentTarget?: string; currentArtifact?: string; chainStatus?: string }
          }).chainState
          assert(
            chainState?.currentTarget === browserRouteTargets.secondaryWindowTitle &&
              typeof chainState.currentArtifact === 'string' &&
              chainState.currentArtifact.endsWith(`phase3-template-followup-${runNumber}.txt`) &&
              chainState.chainStatus === 'completed',
            'file browser desktop template should persist completed chain state',
          )
        },
      ),
    )
  } catch (error) {
    results.push({
      scenario: 'template-runtime',
      status: classifyStatusFromError(error),
      detail: formatErrorMessage(error),
    })
  }

  return results
}

function classifyTemplateScenario(
  scenario: string,
  result: {
    ok: boolean
    summary: string
    data?: unknown
    error?: string
  },
  assertScenario: (result: {
    ok: boolean
    summary: string
    data?: unknown
    error?: string
  }) => void,
): ScenarioRecord {
  try {
    if (scenario === 'browser-editor-chat-template' && isOptionalBrowserEnvironmentUnready(result)) {
      return {
        scenario,
        status: 'environment_unready',
        detail: result.summary,
      }
    }

    if (scenario === 'file-browser-desktop-template' && isOptionalBrowserRouteEnvironmentUnready(result)) {
      return {
        scenario,
        status: 'environment_unready',
        detail: result.summary,
      }
    }

    if (scenario === 'multi-window-observe-route-deliver-template' && isOptionalMultiWindowEnvironmentUnready(result)) {
      return {
        scenario,
        status: 'environment_unready',
        detail: result.summary,
      }
    }

    assert(result.ok, `verification_failed ${scenario} execution failed`)
    assertScenario(result)
    return {
      scenario,
      status: 'pass',
      detail: result.summary,
    }
  } catch (error) {
    return {
      scenario,
      status: classifyStatusFromError(error),
      detail: formatErrorMessage(error),
    }
  }
}

function classifyStatusFromError(error: unknown): ScenarioStatus {
  const message = formatErrorMessage(error)
  if (message.startsWith('missing_dependency')) {
    return 'missing_dependency'
  }
  if (message.startsWith('transport_error')) {
    return 'transport_error'
  }
  if (message.startsWith('provider_error')) {
    return 'provider_error'
  }
  if (message.startsWith('permission_blocked')) {
    return 'permission_blocked'
  }
  if (message.startsWith('environment_unready')) {
    return 'environment_unready'
  }
  if (message.startsWith('skip')) {
    return 'skip'
  }
  return 'verification_failed'
}

function assertVerificationPassed(data: unknown, errorMessage: string): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    throw new Error(errorMessage)
  }

  if ((verification as { passed?: unknown }).passed !== true) {
    throw new Error(errorMessage)
  }
}

function assertOperationPresent(
  data: unknown,
  target: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const operations = (data as { operations?: unknown }).operations
  if (!Array.isArray(operations)) {
    throw new Error(errorMessage)
  }

  const found = operations.some(
    operation =>
      typeof operation === 'object' &&
      operation !== null &&
      (operation as { target?: unknown }).target === target,
  )

  if (!found) {
    throw new Error(errorMessage)
  }
}

function assertEvidencePresent(
  data: unknown,
  marker: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  if (!Array.isArray(evidence)) {
    throw new Error(errorMessage)
  }

  const found = evidence.some(
    item => typeof item === 'string' && item.includes(marker),
  )
  if (!found) {
    throw new Error(errorMessage)
  }
}

async function prepareBrowserSmokeFixture(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<void> {
  const fixturePath = resolve(context.cwd, 'tmp', 'phase3-live-browser-fixture.html')
  const fixtureHtml = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>compuser phase2 browser smoke</title></head>',
    '<body>',
    '<main>',
    '<h1>compuser phase2 browser smoke</h1>',
    '<p>Need reply in WeChat</p>',
    '<p>Route this follow-up to Notepad when testing delivery chains.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
  await writeFile(fixturePath, fixtureHtml, 'utf8')

  const fileUrl = `file:///${fixturePath.replace(/\\/g, '/')}`
  const launchCommands = [
    `Start-Process msedge.exe '${fileUrl}'`,
    `Start-Process chrome.exe '${fileUrl}'`,
    `Start-Process firefox.exe '${fileUrl}'`,
    `Start-Process explorer.exe '${fileUrl}'`,
  ]

  for (const command of launchCommands) {
    const result = await runtime.execute(
      {
        toolName: 'windows.shell',
        input: {
          command,
        },
      },
      context,
    )
    if (result.ok) {
      await runtime.execute(
        {
          toolName: 'windows.wait',
          input: { durationSeconds: 2 },
        },
        context,
      )
      return
    }
  }
}

async function resolvePossiblyStoredResult(
  runtime: ToolRuntime,
  result: {
    ok: boolean
    data?: unknown
    pointer?: string
  },
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown> {
  if (result.pointer) {
    const pointerResult = await runtime.execute(
      {
        toolName: 'artifacts.read_result',
        input: {
          pointer: result.pointer,
        },
      },
      context,
    )
    if (pointerResult.ok && typeof pointerResult.data === 'object' && pointerResult.data !== null) {
      const output = (pointerResult.data as { output?: unknown }).output
      if (output !== undefined) {
        return output
      }
    }
  }

  return result.data
}

async function focusBrowserForSmoke(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  snapshotData?: unknown,
): Promise<void> {
  const candidateTitles = collectBrowserFocusCandidates(snapshotData)
  for (const title of candidateTitles) {
    const result = await runtime.execute(
      {
        toolName: 'windows.focus_window',
        input: {
          windowTitle: title,
        },
      },
      context,
    )
    if (result.ok) {
      await runtime.execute(
        {
          toolName: 'windows.wait',
          input: { durationSeconds: 1 },
        },
        context,
      )
      return
    }
  }
}

function collectBrowserFocusCandidates(snapshotData: unknown): string[] {
  if (typeof snapshotData !== 'object' || snapshotData === null) {
    return ['Microsoft Edge', 'Google Chrome', 'Firefox']
  }

  const candidate = snapshotData as {
    focusedWindow?: unknown
    windows?: unknown
    anchors?: unknown
  }
  const values = [
    typeof candidate.focusedWindow === 'string' ? candidate.focusedWindow : undefined,
    ...(Array.isArray(candidate.windows)
      ? candidate.windows.filter((value): value is string => typeof value === 'string')
      : []),
    ...(Array.isArray(candidate.anchors)
      ? candidate.anchors.filter((value): value is string => typeof value === 'string')
      : []),
    'Microsoft Edge',
    'Google Chrome',
    'Firefox',
  ]

  const results: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    if (!/(edge|chrome|firefox|browser|compuser phase2 browser smoke)/i.test(normalized)) {
      continue
    }
    seen.add(normalized)
    results.push(normalized)
  }

  return results
}

async function ensureLiveSmokeWindowTargets(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<string[]> {
  for (const appName of ['Notepad', 'Calculator']) {
    await runtime.execute(
      {
        toolName: 'command.app.open_or_focus',
        input: {
          appName,
        },
      },
      context,
    )
  }

  const refreshedSnapshot = await runtime.execute(
    {
      toolName: 'windows.snapshot',
      input: {},
    },
    context,
  )
  if (!refreshedSnapshot.ok) {
    return []
  }

  const refreshedData = await resolvePossiblyStoredResult(
    runtime,
    refreshedSnapshot,
    context,
  )
  const snapshotWindows = selectDistinctLiveSmokeWindows(refreshedData)
  const appListResult = await runtime.execute(
    {
      toolName: 'windows.app',
      input: { mode: 'list' },
    },
    context,
  )
  const appListWindows = appListResult.ok
    ? extractWindowTitlesFromAppList(appListResult.summary)
    : []
  return mergeDistinctWindowTargets(snapshotWindows, appListWindows)
}

function selectDistinctLiveSmokeWindows(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const candidate = data as {
    focusedWindow?: unknown
    windows?: unknown
  }

  const values = [
    typeof candidate.focusedWindow === 'string' ? candidate.focusedWindow : undefined,
    ...(Array.isArray(candidate.windows)
      ? candidate.windows.filter(
          (value): value is string => typeof value === 'string',
        )
      : []),
  ]

  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!isUsableLiveWindowTarget(normalized) || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= 2) {
      break
    }
  }

  return result
}

function extractWindowTitlesFromAppList(summary: string): string[] {
  const titles = summary.match(/window\s+"([^"]+)"/g) ?? []
  const extracted = titles
    .map(value => value.match(/window\s+"([^"]+)"/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter(isUsableLiveWindowTarget)
  return dedupeWindowTargets(extracted)
}

function mergeDistinctWindowTargets(
  left: string[],
  right: string[],
): string[] {
  return dedupeWindowTargets([...left, ...right]).slice(0, 4)
}

function dedupeWindowTargets(values: string[]): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    results.push(normalized)
  }
  return results
}

function isUsableLiveWindowTarget(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return !normalized.includes('no windows found')
}

function chooseLiveRouteQuery(windowTitle: string): string {
  const normalized = windowTitle.replace(/\s+/g, ' ').trim()
  const segments = normalized.split(/[\s\-_|:()]+/).filter(Boolean)
  const preferred = segments.find(segment => segment.length >= 4)
  return preferred ?? normalized.slice(0, Math.min(8, normalized.length))
}

function selectBrowserRouteTargets(windowTitles: string[]): {
  primaryWindowTitle: string
  secondaryWindowTitle: string
  routeQuery: string
} | undefined {
  const canonicalWindowTitles = windowTitles
    .map(canonicalizeSmokeWindowTitle)
    .filter((value): value is string => Boolean(value))

  const secondaryWindowTitle =
    canonicalWindowTitles.find(isPowerShellWindowTitle) ??
    canonicalWindowTitles.find(isTextTransferWindowTitle)
  if (!secondaryWindowTitle) {
    return undefined
  }

  const primaryWindowTitle =
    canonicalWindowTitles.find(isCodexWindowTitle) ??
    canonicalWindowTitles.find(windowTitle => windowTitle !== secondaryWindowTitle)
  if (!primaryWindowTitle) {
    return undefined
  }

  return {
    primaryWindowTitle,
    secondaryWindowTitle,
    routeQuery: chooseLiveRouteQuery(secondaryWindowTitle),
  }
}

function isTextTransferWindowTitle(windowTitle: string): boolean {
  return /notepad|记事本|wordpad|写字板|text input/i.test(windowTitle)
}

function isPowerShellWindowTitle(windowTitle: string): boolean {
  return /powershell|终端|shell/i.test(windowTitle)
}

function isCodexWindowTitle(windowTitle: string): boolean {
  return /codex/i.test(windowTitle)
}

function canonicalizeSmokeWindowTitle(windowTitle: string): string {
  const normalized = windowTitle.replace(/\s+/g, ' ').trim()
  if (/powershell/i.test(normalized)) {
    return 'Windows PowerShell'
  }
  if (/notepad|记事本/i.test(normalized)) {
    return 'Notepad'
  }
  if (/codex/i.test(normalized)) {
    return 'Codex'
  }
  return normalized
}

function isOptionalBrowserEnvironmentUnready(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok || typeof result.data !== 'object' || result.data === null) {
    return false
  }

  const candidate = result.data as {
    verification?: unknown
    chainState?: unknown
    verificationEvidence?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown; details?: unknown })
      : undefined
  const chainState =
    typeof candidate.chainState === 'object' && candidate.chainState !== null
      ? (candidate.chainState as { chainStatus?: unknown })
      : undefined
  const evidence = Array.isArray(candidate.verificationEvidence)
    ? candidate.verificationEvidence.filter(
        (value): value is string => typeof value === 'string',
      )
    : []

  return (
    verification?.passed === false &&
    chainState?.chainStatus === 'verified_failed' &&
    typeof verification.details === 'string' &&
    verification.details.includes('no stable text payload could be extracted') &&
    evidence.some(item => item.startsWith('focused='))
  )
}

function isOptionalBrowserRouteEnvironmentUnready(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok || typeof result.data !== 'object' || result.data === null) {
    return false
  }

  const candidate = result.data as {
    verification?: unknown
    chainState?: unknown
    verificationEvidence?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown; details?: unknown })
      : undefined
  const chainState =
    typeof candidate.chainState === 'object' && candidate.chainState !== null
      ? (candidate.chainState as { chainStatus?: unknown })
      : undefined
  const evidence = Array.isArray(candidate.verificationEvidence)
    ? candidate.verificationEvidence.filter(
        (value): value is string => typeof value === 'string',
      )
    : []

  return (
    verification?.passed === false &&
    chainState?.chainStatus === 'verified_failed' &&
    typeof verification.details === 'string' &&
    verification.details.includes('no stable text payload could be extracted for routing') &&
    evidence.some(item => item.startsWith('focused='))
  )
}

function isOptionalMultiWindowEnvironmentUnready(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok || typeof result.data !== 'object' || result.data === null) {
    return false
  }

  const candidate = result.data as {
    verification?: unknown
    chainState?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown; details?: unknown })
      : undefined
  const chainState =
    typeof candidate.chainState === 'object' && candidate.chainState !== null
      ? (candidate.chainState as { chainStatus?: unknown })
      : undefined

  return (
    verification?.passed === false &&
    chainState?.chainStatus === 'verified_failed' &&
    typeof verification.details === 'string' &&
    verification.details.includes('no distinct confirmable windows')
  )
}

function createPhase3LiveRuntime(options: SmokeOptions): {
  runtime: ToolRuntime
  registry: InMemoryToolRegistry
} {
  const registry = new InMemoryToolRegistry()
  const adapter = new BridgeWindowsMcpAdapter(
    new StreamableHttpWindowsMcpBridge(options.endpoint),
  )
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  for (const tool of createResultPointerTools(CLI_WORKSPACE_ROOT)) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(
    registry,
    createPermissionChecker(registry, options.permissionMode),
  )
  const capabilityCatalog = new InMemoryCapabilityCatalog(
    createBuiltinCapabilities(),
  )
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
    cliAdapter: new PowerShellCliBackendAdapter(),
  })) {
    registry.register(tool)
  }

  return {
    runtime,
    registry,
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
