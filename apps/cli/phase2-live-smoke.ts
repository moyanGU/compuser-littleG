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
import {
  InMemoryToolRegistry,
} from '../../packages/tools/Tool.js'
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
    const { runtime } = createPhase2LiveRuntime(options)

    const context = {
      cwd: CLI_WORKSPACE_ROOT,
      sessionId: 'phase2-live-smoke',
      turnId: 'turn-1',
    }

    await prepareBrowserSmokeFixture(runtime, context)

    const snapshot = await runtime.execute(
      {
        toolName: 'windows.snapshot',
        input: {},
      },
      context,
    )
    assert(snapshot.ok, 'verification_failed phase2 snapshot failed')
    const snapshotData = await resolvePossiblyStoredResult(runtime, snapshot, context)
    let liveWindowTargets = selectDistinctLiveSmokeWindows(snapshotData)

    await focusBrowserForSmoke(runtime, context, snapshotData)

    const browserResult = await runtime.execute(
      {
        toolName: 'skill.browser_to_editor.capture_verify',
        input: {
          appName: 'Notepad',
          targetWindowTitle: 'Notepad',
        },
      },
      context,
    )

    reportOptionalBrowserScenario(browserResult)

    const liveFixturePath = resolve(
      context.cwd,
      'tmp',
      'phase2-live-file-transfer.txt',
    )
    await writeFile(
      liveFixturePath,
      ['phase2 live smoke', 'file transfer chain'].join('\n'),
      'utf8',
    )

    const fileResult = await runtime.execute(
      {
        toolName: 'skill.file_read_transform_transfer',
        input: {
          path: liveFixturePath,
          targetWindowTitle: 'Notepad',
          transform: 'uppercase',
        },
      },
      context,
    )

    reportOptionalFileTransferScenario(fileResult)

    if (liveWindowTargets.length < 2) {
      liveWindowTargets = await ensureLiveSmokeWindowTargets(runtime, context)
    }

    if (liveWindowTargets.length < 2) {
      console.log(
        '[skip] phase2-live-smoke browser-route-capture-transfer environment_unready requires at least two distinct confirmable windows',
      )
      console.log(
        '[skip] phase2-live-smoke multi-window environment_unready requires at least two distinct confirmable windows',
      )
      return
    }

    const compareResult = await runtime.execute(
      {
        toolName: 'skill.app.switch_collect_compare',
        input: {
          primaryWindowTitle: liveWindowTargets[0],
          secondaryWindowTitle: liveWindowTargets[1],
        },
      },
      context,
    )

    assert(compareResult.ok, 'verification_failed app switch collect compare failed')
    assertVerificationPassed(
      compareResult.data,
      'verification_failed app switch collect compare verification failed',
    )
    assertOperationPresent(
      compareResult.data,
      'windows.app',
      'verification_failed app switch collect compare app list/switch stage missing',
    )
    assertOperationPresent(
      compareResult.data,
      'skill.desktop.observe',
      'verification_failed app switch collect compare observe stage missing',
    )
    assertEvidencePresent(
      compareResult.data,
      'comparison=',
      'verification_failed app switch collect compare comparison evidence missing',
    )

    const routeQuery = chooseLiveRouteQuery(liveWindowTargets[1])
    const routeExecuteResult = await runtime.execute(
      {
        toolName: 'skill.multi_window.observe_route_execute',
        input: {
          primaryWindowTitle: liveWindowTargets[0],
          secondaryWindowTitle: liveWindowTargets[1],
          routeQuery,
        },
      },
      context,
    )

    assert(routeExecuteResult.ok, 'verification_failed multi window observe route execute failed')
    assertVerificationPassed(
      routeExecuteResult.data,
      'verification_failed multi window observe route execute verification failed',
    )
    assertOperationPresent(
      routeExecuteResult.data,
      'skill.cross_app.open_observe_act_verify',
      'verification_failed multi window observe route execute downstream chain missing',
    )
    assertEvidencePresent(
      routeExecuteResult.data,
      'routeReason=',
      'verification_failed multi window observe route execute routing evidence missing',
    )
    assertSelectedTarget(
      routeExecuteResult.data,
      liveWindowTargets[1],
      'verification_failed multi window observe route execute selected unexpected target',
    )
    console.log(
      `[pass] phase2-live-smoke app-switch-collect-compare ${liveWindowTargets[0]} <-> ${liveWindowTargets[1]}`,
    )
    console.log(
      `[pass] phase2-live-smoke multi-window-observe-route-execute routeQuery=${routeQuery} -> ${liveWindowTargets[1]}`,
    )

    const browserRouteTargets = selectBrowserRouteTargets(liveWindowTargets)
    if (!browserRouteTargets) {
      console.log(
        '[skip] phase2-live-smoke browser-route-capture-transfer environment_unready requires one text-capable target window plus one distinct comparison window',
      )
      return
    }

    await focusBrowserForSmoke(runtime, context)

    const browserRouteResult = await runtime.execute(
      {
        toolName: 'skill.browser.route_capture_transfer',
        input: {
          primaryWindowTitle: browserRouteTargets.primaryWindowTitle,
          secondaryWindowTitle: browserRouteTargets.secondaryWindowTitle,
          routeQuery: browserRouteTargets.routeQuery,
        },
      },
      context,
    )

    reportOptionalBrowserRouteScenario(
      browserRouteResult,
      browserRouteTargets.secondaryWindowTitle,
      browserRouteTargets.routeQuery,
    )
  } catch (error) {
    throw classifyWindowsSmokeError(error)
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

  return {
    endpoint,
    permissionMode,
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
      'permission_blocked permission mode read-only does not allow browser-to-editor smoke actions',
    )
  }
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

function assertSelectedTarget(
  data: unknown,
  expectedTarget: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) {
    throw new Error(errorMessage)
  }

  if ((output as { selectedWindowTitle?: unknown }).selectedWindowTitle !== expectedTarget) {
    throw new Error(errorMessage)
  }
}

function assertRepeatedOperationCount(
  data: unknown,
  target: string,
  expectedCount: number,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const operations = (data as { operations?: unknown }).operations
  if (!Array.isArray(operations)) {
    throw new Error(errorMessage)
  }

  const count = operations.filter(
    operation =>
      typeof operation === 'object' &&
      operation !== null &&
      (operation as { target?: unknown }).target === target,
  ).length

  if (count !== expectedCount) {
    throw new Error(errorMessage)
  }
}

function reportOptionalBrowserScenario(result: {
  ok: boolean
  data?: unknown
  summary: string
}): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed browser_to_editor verification failed',
    )
    assertOperationPresent(
      result.data,
      'command.browser.inspect_dom',
      'verification_failed browser DOM stage missing',
    )
    assertOperationPresent(
      result.data,
      'skill.cross_app.open_observe_act_verify',
      'verification_failed downstream editor chain stage missing',
    )
    assertEvidencePresent(
      result.data,
      'extracted=',
      'verification_failed extraction evidence missing',
    )
    console.log('[pass] phase2-live-smoke browser-to-editor capture/transfer/verify')
    return
  }

  if (isOptionalBrowserEnvironmentUnready(result)) {
    console.log(
      `[skip] phase2-live-smoke browser-to-editor environment_unready ${result.summary}`,
    )
    return
  }

  throw new Error('verification_failed browser_to_editor chain failed')
}

function reportOptionalFileTransferScenario(result: {
  ok: boolean
  data?: unknown
  summary: string
}): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed file_read_transform_transfer verification failed',
    )
    assertOperationPresent(
      result.data,
      'skill.cross_app.open_observe_act_verify',
      'verification_failed file transfer downstream editor chain stage missing',
    )
    assertEvidencePresent(
      result.data,
      'source=',
      'verification_failed file transfer source evidence missing',
    )
    console.log('[pass] phase2-live-smoke file-to-editor read/transform/verify')
    return
  }

  if (isOptionalFileTargetEnvironmentUnready(result)) {
    console.log(
      `[skip] phase2-live-smoke file-to-editor environment_unready ${result.summary}`,
    )
    return
  }

  throw new Error('verification_failed file_read_transform_transfer chain failed')
}

function reportOptionalBrowserRouteScenario(
  result: {
    ok: boolean
    data?: unknown
    summary: string
  },
  expectedTarget: string,
  routeQuery: string,
): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed browser route capture transfer verification failed',
    )
    assertOperationPresent(
      result.data,
      'command.browser.inspect_dom',
      'verification_failed browser route capture transfer browser stage missing',
    )
    assertOperationPresent(
      result.data,
      'skill.app.switch_collect_compare',
      'verification_failed browser route capture transfer compare stage missing',
    )
    assertOperationPresent(
      result.data,
      'skill.cross_app.open_observe_act_verify',
      'verification_failed browser route capture transfer verified execute stage missing',
    )
    assertEvidencePresent(
      result.data,
      'routeReason=',
      'verification_failed browser route capture transfer route evidence missing',
    )
    assertEvidencePresent(
      result.data,
      'extracted=',
      'verification_failed browser route capture transfer extraction evidence missing',
    )
    assertSelectedTarget(
      result.data,
      expectedTarget,
      'verification_failed browser route capture transfer selected unexpected target',
    )
    console.log(
      `[pass] phase2-live-smoke browser-route-capture-transfer routeQuery=${routeQuery} -> ${expectedTarget}`,
    )
    return
  }

  if (isOptionalBrowserRouteEnvironmentUnready(result)) {
    console.log(
      `[skip] phase2-live-smoke browser-route-capture-transfer environment_unready ${result.summary}`,
    )
    return
  }

  throw new Error('verification_failed browser route capture transfer chain failed')
}

function classifyWindowsSmokeError(error: unknown): Error {
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith('missing_dependency ') ||
      message.startsWith('transport_error ') ||
      message.startsWith('permission_blocked ') ||
      message.startsWith('environment_unready ') ||
      message.startsWith('verification_failed ')
    ) {
      return error
    }
    if (message.includes('TOOL_PERMISSION')) {
      return new Error(`permission_blocked ${message}`)
    }
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('HTTP') ||
      message.includes('fetch')
    ) {
      return new Error(`transport_error ${message}`)
    }
    return new Error(`provider_error ${message}`)
  }

  return new Error(`provider_error ${String(error)}`)
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

async function resolvePossiblyStoredResult(
  runtime: ToolRuntime,
  result: {
    data?: unknown
    pointer?: string
  },
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown> {
  if (!result.pointer) {
    return result.data
  }

  let offset = 0
  let content = ''

  for (let index = 0; index < 32; index += 1) {
    const readBack = await runtime.execute(
      {
        toolName: 'artifacts.read_result',
        input: {
          pointer: result.pointer,
          maxChars: 20_000,
          offset,
        },
      },
      context,
    )

    assert(readBack.ok, 'verification_failed phase2 snapshot pointer read failed')

    const payload = readBack.data as {
      content?: unknown
      hasMore?: unknown
      nextOffset?: unknown
    } | undefined

    if (typeof payload?.content !== 'string') {
      throw new Error('verification_failed phase2 snapshot pointer content missing')
    }

    content += payload.content

    if (payload.hasMore !== true) {
      return parseNestedJsonString(content)
    }

    if (typeof payload.nextOffset !== 'number') {
      throw new Error('verification_failed phase2 snapshot pointer nextOffset missing')
    }

    offset = payload.nextOffset
  }

  throw new Error('verification_failed phase2 snapshot pointer read exceeded chunk budget')
}

function parseNestedJsonString(content: string): unknown {
  let current: unknown = content

  for (let index = 0; index < 2; index += 1) {
    if (typeof current !== 'string') {
      return current
    }

    try {
      current = JSON.parse(current) as unknown
    } catch {
      return current
    }
  }

  return current
}

async function prepareBrowserSmokeFixture(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<void> {
  const fixturePath = resolve(
    context.cwd,
    'tmp',
    'phase2-live-browser-fixture.html',
  )
  const fixtureUrl = `file:///${fixturePath.replace(/\\/g, '/')}`
  await writeFile(
    fixturePath,
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8" />',
      '  <title>compuser phase2 browser smoke</title>',
      '</head>',
      '<body>',
      '  <main>',
      '    <h1>compuser phase2 browser smoke</h1>',
      '    <p>Transfer target text: compuser browser smoke text for verified routing.</p>',
      '    <p>Select this page content if DOM capture needs selectedText.</p>',
      '  </main>',
      '</body>',
      '</html>',
    ].join('\n'),
    'utf8',
  )

  const launchCommands = [
    `Start-Process msedge.exe '${fixtureUrl}'`,
    `Start-Process chrome.exe '${fixtureUrl}'`,
    `Start-Process firefox.exe '${fixtureUrl}'`,
  ]

  for (const command of launchCommands) {
    const launchResult = await runtime.execute(
      {
        toolName: 'windows.shell',
        input: {
          command,
        },
      },
      context,
    )

    if (!launchResult.ok) {
      continue
    }

    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: {
          durationSeconds: 2,
        },
      },
      context,
    )
    await focusBrowserForSmoke(runtime, context)
    return
  }
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
  const candidateTitles = [
    ...readBrowserWindowCandidates(snapshotData),
    'compuser phase2 browser smoke',
    'Microsoft Edge',
    'Edge',
    'Chrome',
    'Firefox',
  ]

  for (const windowTitle of candidateTitles) {
    const focusResult = await runtime.execute(
      {
        toolName: 'windows.focus_window',
        input: { windowTitle },
      },
      context,
    )

    if (focusResult.ok) {
      await runtime.execute(
        {
          toolName: 'windows.wait',
          input: {
            durationSeconds: 1,
          },
        },
        context,
      )
      return
    }
  }
}

function readBrowserWindowCandidates(snapshotData: unknown): string[] {
  if (typeof snapshotData !== 'object' || snapshotData === null) {
    return []
  }

  const candidate = snapshotData as {
    focusedWindow?: unknown
    windows?: unknown
    anchors?: unknown
  }
  const values = [
    candidate.focusedWindow,
    ...(Array.isArray(candidate.windows) ? candidate.windows : []),
    ...(Array.isArray(candidate.anchors) ? candidate.anchors : []),
  ]

  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized) || !looksLikeBrowserWindowTitle(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function looksLikeBrowserWindowTitle(value: string): boolean {
  return /(edge|chrome|firefox|浏览器|microsoft)/i.test(value)
}

async function ensureLiveSmokeWindowTargets(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<string[]> {
  const bootstrapApps = ['Notepad', 'Calculator']
  for (const appName of bootstrapApps) {
    await runtime.execute(
      {
        toolName: 'command.app.open_or_focus',
        input: { appName },
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
  return selectDistinctLiveSmokeWindows(refreshedData)
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
  const secondaryWindowTitle = windowTitles.find(isTextTransferWindowTitle)
  if (!secondaryWindowTitle) {
    return undefined
  }

  const primaryWindowTitle = windowTitles.find(
    windowTitle => windowTitle !== secondaryWindowTitle,
  )
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
  return /(notepad|记事本)/i.test(windowTitle)
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

function isOptionalFileTargetEnvironmentUnready(result: {
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
    output?: unknown
    recoveryPoint?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown; details?: unknown })
      : undefined
  const chainState =
    typeof candidate.chainState === 'object' && candidate.chainState !== null
      ? (candidate.chainState as { chainStatus?: unknown })
      : undefined
  const output =
    typeof candidate.output === 'object' && candidate.output !== null
      ? (candidate.output as { transferred?: unknown; targetWindowTitle?: unknown })
      : undefined
  const recoveryPoint =
    typeof candidate.recoveryPoint === 'string' ? candidate.recoveryPoint : undefined

  return (
    verification?.passed === false &&
    chainState?.chainStatus === 'execution_failed' &&
    output?.transferred === false &&
    typeof output.targetWindowTitle === 'string' &&
    (result.summary.includes(`editor chain failed for ${output.targetWindowTitle}`) ||
      recoveryPoint === `focus:${output.targetWindowTitle}`)
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

function createPhase2LiveRuntime(options: SmokeOptions): {
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

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
