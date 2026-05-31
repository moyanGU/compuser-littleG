import { resolve } from 'node:path'
import { homedir } from 'node:os'
import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { PowerShellCliBackendAdapter } from '../../packages/adapters/cli/CliBackendAdapter.js'
import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import { createResultPointerTools } from '../../packages/tools/ResultPointerTools.js'
import { InMemoryToolRegistry, type AnyToolDefinition } from '../../packages/tools/Tool.js'
import {
  createPermissionChecker,
  type ToolRuntimeHooks,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import type {
  CliAppOptions,
} from './cliApp.js'
import {
  CLI_WORKSPACE_ROOT,
  createWindowsMcpBridge,
} from './cliApp.js'

export interface CliCapabilityRuntimeOptions {
  windowsMcpEndpoint?: string
  windowsMcpService?: WindowsMcpService
  permissionMode?: CliAppOptions['permissionMode']
  permissionPrompt?: CliAppOptions['permissionPrompt']
  runtimeHooks?: ToolRuntimeHooks
  additionalTools?: AnyToolDefinition[]
}

export interface CliCapabilityRuntimeEnvironment {
  registry: InMemoryToolRegistry
  capabilityCatalog: InMemoryCapabilityCatalog
  runtime: ToolRuntime
  cliBackendAdapter: PowerShellCliBackendAdapter
}

export function createCliCapabilityRuntimeEnvironment(
  options: CliCapabilityRuntimeOptions = {},
): CliCapabilityRuntimeEnvironment {
  const registry = new InMemoryToolRegistry()
  const cliBackendAdapter = new PowerShellCliBackendAdapter()
  const windowsBridge = createWindowsMcpBridge({
    windowsMcpEndpoint: options.windowsMcpEndpoint,
    windowsMcpService: options.windowsMcpService,
  })
  const windowsAdapter = new BridgeWindowsMcpAdapter(windowsBridge)
  const capabilityCatalog = new InMemoryCapabilityCatalog(
    createBuiltinCapabilities(),
  )

  for (const tool of options.additionalTools ?? []) {
    registry.register(tool)
  }

  for (const tool of createResultPointerTools(CLI_WORKSPACE_ROOT)) {
    registry.register(tool)
  }

  for (const tool of createWindowsMcpTools(windowsAdapter)) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(
    registry,
    createPermissionChecker(
      registry,
      options.permissionMode,
      options.permissionPrompt,
      {
        filesystemRoots: {
          workspaceRoot: CLI_WORKSPACE_ROOT,
          desktopRoot: resolve(homedir(), 'Desktop'),
        },
      },
    ),
    undefined,
    options.runtimeHooks,
  )

  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
    cliAdapter: cliBackendAdapter,
  })) {
    registry.register(tool)
  }

  return {
    registry,
    capabilityCatalog,
    runtime,
    cliBackendAdapter,
  }
}
