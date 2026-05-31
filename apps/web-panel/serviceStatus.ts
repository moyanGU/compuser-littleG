import type {
  WindowsMcpServiceStatus,
} from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import type { WindowsMcpStatusView } from './panelTypes.js'

export function mapServiceStatus(
  status: WindowsMcpServiceStatus,
): WindowsMcpStatusView {
  return {
    mode: 'endpoint',
    state: status.state,
    endpoint: status.endpointUrl,
    reachable: status.state === 'ready' || status.state === 'degraded',
    summary:
      status.state === 'ready'
        ? '桌面服务已经连好，可以继续跑桌面任务。'
        : status.detail,
    detail: status.detail,
    checkedAt: status.checkedAt,
    configPath: status.configPath,
    launchedByService: status.launchedByService,
    reusedExistingEndpoint: status.reusedExistingEndpoint,
    pid: status.pid,
    error: status.lastError,
  }
}
