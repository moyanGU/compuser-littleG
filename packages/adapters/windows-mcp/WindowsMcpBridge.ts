export interface WindowsMcpToolCall {
  toolName: string
  args: Record<string, unknown>
}

export interface WindowsMcpBridge {
  call<TResponse = unknown>(request: WindowsMcpToolCall): Promise<TResponse>
}

export class StubWindowsMcpBridge implements WindowsMcpBridge {
  async call<TResponse = unknown>(
    request: WindowsMcpToolCall,
  ): Promise<TResponse> {
    const payload = this.buildStubPayload(request) as TResponse
    return payload
  }

  private buildStubPayload(request: WindowsMcpToolCall): unknown {
    switch (request.toolName) {
      case 'Screenshot':
        return {
          summary: 'stub windows screenshot',
          windows: ['资源管理器', '设置'],
          focusedWindow: '资源管理器',
          raw: request,
        }
      case 'Snapshot':
        return {
          summary: 'stub windows snapshot',
          windows: ['资源管理器', '设置', '浏览器'],
          focusedWindow: '浏览器',
          raw: request,
        }
      case 'App':
        return {
          ok: true,
          summary: `stub app mode=${String(request.args.mode ?? '')}`,
          raw: request,
        }
      case 'Click':
      case 'Type':
        return {
          ok: true,
          summary: `stub ${request.toolName.toLowerCase()} executed`,
          raw: request,
        }
      default:
        return {
          ok: true,
          summary: `stub tool ${request.toolName}`,
          raw: request,
        }
    }
  }
}
