const MCP_PROTOCOL_VERSION = '2025-03-26'
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

export interface WindowsMcpEndpointProbeResult {
  endpointUrl: string
  checkedAt: string
  ready: boolean
  reachable: boolean
  statusCode?: number
  statusText?: string
  detail: string
  error?: string
}

export async function probeWindowsMcpEndpoint(
  endpointUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WindowsMcpEndpointProbeResult> {
  const checkedAt = new Date().toISOString()

  try {
    const response = await fetchImpl(endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: MCP_STREAMABLE_HTTP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'compuser-service-probe',
            version: '0.1.0',
          },
        },
      }),
    })

    if (!response.ok) {
      const body = (await response.text()).trim()
      const detail = body
        ? `HTTP ${response.status} ${response.statusText}: ${body}`
        : `HTTP ${response.status} ${response.statusText}`

      return {
        endpointUrl,
        checkedAt,
        ready: false,
        reachable: true,
        statusCode: response.status,
        statusText: response.statusText,
        detail,
      }
    }

    return {
      endpointUrl,
      checkedAt,
      ready: true,
      reachable: true,
      statusCode: response.status,
      statusText: response.statusText,
      detail: 'MCP 初始化探测成功。',
    }
  } catch (error) {
    const detail = `请求失败: ${stringifyError(error)}`

    return {
      endpointUrl,
      checkedAt,
      ready: false,
      reachable: false,
      detail,
      error: detail,
    }
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
