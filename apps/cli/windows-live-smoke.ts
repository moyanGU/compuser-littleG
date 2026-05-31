import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
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
    })) {
      registry.register(tool)
    }
    const context = {
      cwd: CLI_WORKSPACE_ROOT,
      sessionId: 'windows-live-smoke',
      turnId: 'turn-1',
    }

    const snapshot = await runtime.execute(
      {
        toolName: 'windows.snapshot',
        input: {},
      },
      context,
    )
    assert(snapshot.ok, 'verification_failed snapshot failed')
    const snapshotData = await resolvePossiblyStoredResult(runtime, snapshot, context)
    assertNormalizedSnapshot(snapshotData)
    const snapshotTarget = selectLiveSmokeWindowTarget(snapshotData)
    assert(snapshotTarget, 'verification_failed no live window target found from snapshot')

    const focus = await runtime.execute(
      {
        toolName: 'windows.focus_window',
        input: { windowTitle: snapshotTarget },
      },
      context,
    )
    assert(focus.ok, 'verification_failed focus_window failed')

    const capabilityObserve = await runtime.execute(
      {
        toolName: 'skill.desktop.observe',
        input: {},
      },
      context,
    )
    assert(capabilityObserve.ok, 'verification_failed capability observe failed')
    assertVerificationPassed(
      capabilityObserve.data,
      'verification_failed capability observe verification failed',
    )

    const clipboard = await runtime.execute(
      {
        toolName: 'windows.clipboard',
        input: { mode: 'get' },
      },
      context,
    )
    assert(clipboard.ok, 'verification_failed clipboard failed')

    const clipboardCapability = await runtime.execute(
      {
        toolName: 'command.clipboard.read_write',
        input: { mode: 'get' },
      },
      context,
    )
    assert(clipboardCapability.ok, 'verification_failed capability clipboard failed')
    assertVerificationPassed(
      clipboardCapability.data,
      'verification_failed capability clipboard verification failed',
    )

    const appList = await runtime.execute(
      {
        toolName: 'windows.app',
        input: { mode: 'list' },
      },
      context,
    )
    if (appList.ok) {
      assertNonEmptySummary(appList.summary, 'verification_failed app list summary missing')
    }

    const appSwitch = await runtime.execute(
      {
        toolName: 'windows.app',
        input: { mode: 'switch', name: snapshotTarget },
      },
      context,
    )
    assert(appSwitch.ok, 'verification_failed app switch failed')

    const crossAppChain = await runtime.execute(
      {
        toolName: 'skill.cross_app.open_observe_act_verify',
        input: {
          appName: 'Notepad',
          text: 'windows-live-smoke',
          targetWindowTitle: 'Notepad',
        },
      },
      context,
    )
    assert(
      crossAppChain.ok,
      'verification_failed cross-app open/observe/act/verify failed',
    )
    assertVerificationPassed(
      crossAppChain.data,
      'verification_failed cross-app open/observe/act/verify verification failed',
    )
    assertOperationPresent(
      crossAppChain.data,
      'command.app.open_or_focus',
      'verification_failed cross-app open/observe/act/verify missing focus stage',
    )
    assertOperationPresent(
      crossAppChain.data,
      'command.desktop.capture_and_locate',
      'verification_failed cross-app open/observe/act/verify missing observe stage',
    )
    assertOperationPresent(
      crossAppChain.data,
      'skill.cross_app.transfer_text',
      'verification_failed cross-app open/observe/act/verify missing act stage',
    )
    assertOperationPresent(
      crossAppChain.data,
      'skill.desktop.observe',
      'verification_failed cross-app open/observe/act/verify missing verify stage',
    )

    const captureLocate = await runtime.execute(
      {
        toolName: 'command.desktop.capture_and_locate',
        input: { query: snapshotTarget },
      },
      context,
    )
    assert(captureLocate.ok, 'verification_failed capture and locate failed')
    assertVerificationPassed(
      captureLocate.data,
      'verification_failed capture and locate verification failed',
    )

    console.log(
      '[pass] windows-live-smoke snapshot/focus/clipboard/app-list/app-switch/cross-app-open-observe-act-verify/capability-observe',
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
      'permission_blocked permission mode read-only does not allow focus_window smoke actions',
    )
  }
}

function classifyWindowsSmokeError(error: unknown): Error {
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith('missing_dependency ') ||
      message.startsWith('transport_error ') ||
      message.startsWith('permission_blocked ') ||
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
    if (
      message.includes('verification_failed') ||
      message.includes('snapshot failed') ||
      message.includes('focus_window failed') ||
      message.includes('clipboard failed') ||
      message.includes('app list failed')
    ) {
      return new Error(message)
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

function assertNormalizedSnapshot(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error('verification_failed snapshot returned no normalized data')
  }

  const candidate = data as {
    summary?: unknown
    windows?: unknown
    observationMode?: unknown
  }

  if (
    typeof candidate.summary !== 'string' ||
    !Array.isArray(candidate.windows) ||
    typeof candidate.observationMode !== 'string'
  ) {
    throw new Error('verification_failed snapshot normalization fields missing')
  }
}

function selectLiveSmokeWindowTarget(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const candidate = data as {
    focusedWindow?: unknown
    windows?: unknown
  }

  if (typeof candidate.focusedWindow === 'string') {
    const focusedWindow = candidate.focusedWindow.trim()
    if (isUsableLiveWindowTarget(focusedWindow)) {
      return focusedWindow
    }
  }

  if (Array.isArray(candidate.windows)) {
    const firstWindow = candidate.windows.find(
      value =>
        typeof value === 'string' &&
        isUsableLiveWindowTarget(value.trim()),
    )
    return typeof firstWindow === 'string' ? firstWindow.trim() : undefined
  }

  return undefined
}

function isUsableLiveWindowTarget(value: string): boolean {
  return Boolean(value) && !/^(no active window found|none|null|undefined)$/i.test(value)
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

function assertNonEmptySummary(summary: string, errorMessage: string): void {
  if (!summary.trim()) {
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

    assert(readBack.ok, 'verification_failed could not read snapshot pointer result')

    const readBackData = readBack.data as {
      content?: unknown
      hasMore?: unknown
      nextOffset?: unknown
    } | undefined

    if (typeof readBackData?.content !== 'string') {
      throw new Error('verification_failed snapshot pointer content missing')
    }

    content += readBackData.content

    if (readBackData.hasMore !== true) {
      return parseNestedJsonString(content)
    }

    if (typeof readBackData.nextOffset !== 'number') {
      throw new Error('verification_failed snapshot pointer nextOffset missing')
    }

    offset = readBackData.nextOffset
  }

  throw new Error('verification_failed snapshot pointer read exceeded chunk budget')
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
