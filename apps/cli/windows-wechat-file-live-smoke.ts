import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { StreamableHttpWindowsMcpBridge } from '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import { InMemoryToolRegistry } from '../../packages/tools/Tool.js'
import {
  createPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'
import { ensureWindowsMcpReady } from './windowsMcpRuntime.js'

type SmokeOptions = {
  endpoint: string
  permissionMode: 'default' | 'auto' | 'confirm-high-risk' | 'read-only'
  filePath?: string
  targetWindowTitle?: string
  send: boolean
  listWindowsOnly: boolean
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const windowsMcp = await ensureWindowsMcpReady({
    endpoint: options.endpoint,
    launchIfNeeded: true,
  })

  try {
    const registry = new InMemoryToolRegistry()
    const adapter = new BridgeWindowsMcpAdapter(
      new StreamableHttpWindowsMcpBridge(windowsMcp.endpoint),
    )
    for (const tool of createWindowsMcpTools(adapter)) {
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
      sessionId: 'windows-wechat-file-live-smoke',
      turnId: 'turn-1',
    }

    const observed = await runtime.execute(
      {
        toolName: options.listWindowsOnly ? 'windows.snapshot' : 'skill.desktop.observe',
        input: {},
      },
      context,
    )
    const fallbackScreenshot =
      options.listWindowsOnly && !observed.ok
        ? await runtime.execute(
            {
              toolName: 'windows.screenshot',
              input: {},
            },
            context,
          )
        : undefined
    assert(
      observed.ok || fallbackScreenshot?.ok,
      `verification_failed observe failed: ${observed.summary}`,
    )

    const observationOutput =
      options.listWindowsOnly
        ? (observed.ok ? observed.data : fallbackScreenshot?.data)
        : resultOutput(observed)
    const windows = readObservedWindows(observationOutput)
    const focusedWindow = readObservedFocusedWindow(observationOutput)

    if (options.listWindowsOnly) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            summary: 'Listed current desktop windows.',
            focusedWindow,
            windows,
          },
          null,
          2,
        )}\n`,
      )
      return
    }

    assert(
      options.filePath,
      'invalid_request --file-path is required unless --list-windows is used',
    )
    assert(
      options.targetWindowTitle,
      'invalid_request --target-window-title is required unless --list-windows is used',
    )

    const result = await runtime.execute(
      {
        toolName: 'skill.file.send_to_chat_window',
        input: {
          path: options.filePath,
          targetWindowTitle: options.targetWindowTitle,
          send: options.send,
        },
      },
      context,
    )

    const data = result.data as {
      verification?: { passed?: boolean; details?: string }
      verificationEvidence?: string[]
      operations?: Array<{ target?: string; ok?: boolean; summary?: string }>
    } | undefined

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok && data?.verification?.passed === true,
          summary: result.summary,
          targetWindowTitle: options.targetWindowTitle,
          filePath: options.filePath,
          send: options.send,
          focusedWindow,
          observedWindows: windows,
          verification: data?.verification,
          verificationEvidence: data?.verificationEvidence ?? [],
          operations: data?.operations ?? [],
          output: resultOutput(result),
        },
        null,
        2,
      )}\n`,
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

  const filePath = argv.find((value, index) => argv[index - 1] === '--file-path')
  const targetWindowTitle = argv.find(
    (value, index) => argv[index - 1] === '--target-window-title',
  )

  return {
    endpoint,
    permissionMode,
    filePath,
    targetWindowTitle,
    send: argv.includes('--send'),
    listWindowsOnly: argv.includes('--list-windows'),
  }
}

function readObservedWindows(output: unknown): string[] {
  if (typeof output !== 'object' || output === null) {
    return []
  }

  const observation =
    typeof (output as { observation?: unknown }).observation === 'object' &&
    (output as { observation?: unknown }).observation !== null
      ? ((output as { observation?: unknown }).observation as { windows?: unknown })
      : (output as { windows?: unknown })

  const windows = observation.windows
  return Array.isArray(windows)
    ? windows.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
}

function readObservedFocusedWindow(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) {
    return undefined
  }

  const observation =
    typeof (output as { observation?: unknown }).observation === 'object' &&
    (output as { observation?: unknown }).observation !== null
      ? ((output as { observation?: unknown }).observation as { focusedWindow?: unknown })
      : (output as { focusedWindow?: unknown })

  const focusedWindow = observation.focusedWindow
  return typeof focusedWindow === 'string' && focusedWindow.trim()
    ? focusedWindow.trim()
    : undefined
}

function resultOutput(result: { output?: unknown; data?: unknown }): unknown {
  return result.output ?? ((result.data as { output?: unknown } | undefined)?.output)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
