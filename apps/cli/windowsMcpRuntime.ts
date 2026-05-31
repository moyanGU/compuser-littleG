import { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { getDefaultWindowsMcpServiceConfigPath } from './workspaceRoot.js'

export type WindowsMcpRuntimeOptions = {
  endpoint?: string
  launchIfNeeded?: boolean
}

export type WindowsMcpRuntimeHandle = {
  endpoint: string
  service: WindowsMcpService
  dispose(): Promise<void>
}

export async function ensureWindowsMcpReady(
  options: WindowsMcpRuntimeOptions = {},
): Promise<WindowsMcpRuntimeHandle> {
  const service = new WindowsMcpService({
    configPath: getDefaultWindowsMcpServiceConfigPath(),
    endpointUrl: options.endpoint ?? DEFAULT_WINDOWS_MCP_ENDPOINT,
  })

  const status = await service.ensureReady({
    launchIfNeeded: options.launchIfNeeded !== false,
  })

  if (status.state !== 'ready') {
    const prefix =
      status.state === 'degraded'
        ? 'missing_dependency'
        : status.state === 'disconnected'
          ? 'transport_error'
          : 'provider_error'
    await service.dispose()
    throw new Error(`${prefix} Windows-MCP endpoint not ready: ${status.detail}`)
  }

  return {
    endpoint: status.endpointUrl,
    service,
    async dispose() {
      await service.dispose()
    },
  }
}
