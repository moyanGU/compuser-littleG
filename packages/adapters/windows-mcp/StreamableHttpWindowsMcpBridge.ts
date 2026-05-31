import type { WindowsMcpBridge, WindowsMcpToolCall } from './WindowsMcpBridge.js'

type JsonRpcId = number

type JsonRpcSuccess<T> = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: T
}

type JsonRpcFailure = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure

type InitializeResult = {
  protocolVersion?: string
  capabilities?: Record<string, unknown>
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string
}

type CallToolResult = {
  content?: unknown[]
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'
const MCP_PROTOCOL_VERSION = '2025-03-26'

export class StreamableHttpWindowsMcpBridge implements WindowsMcpBridge {
  private initialized = false
  private sessionId?: string
  private nextRequestId = 1

  constructor(
    private readonly endpointUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<TResponse = unknown>(
    request: WindowsMcpToolCall,
  ): Promise<TResponse> {
    await this.ensureInitialized()

    const rawResult = await this.sendRequest<CallToolResult>('tools/call', {
      name: request.toolName,
      arguments: request.args,
    })

    if (rawResult.isError) {
      throw new Error(this.extractToolError(rawResult))
    }

    return this.unwrapToolResult(rawResult) as TResponse
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.sendRequest<InitializeResult>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'compuser',
        version: '0.1.0',
      },
    })

    await this.sendNotification('notifications/initialized', {})
    this.initialized = true
  }

  private async sendRequest<TResult>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    const id = this.allocateRequestId()
    const payload = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
    }

    const response = await this.post(payload)
    const message = await this.parseJsonRpcResponse<TResult>(response)

    if ('error' in message) {
      throw new Error(
        `MCP 请求失败: ${method} (${message.error.code}) ${message.error.message}`,
      )
    }

    return message.result
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const payload = {
      jsonrpc: '2.0' as const,
      method,
      params,
    }

    await this.post(payload)
  }

  private async post(payload: object): Promise<Response> {
    const response = await this.fetchImpl(this.endpointUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    })

    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) {
      this.sessionId = sessionId
    }

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(
        `Windows-MCP HTTP 错误: ${response.status} ${response.statusText} ${errorBody}`,
      )
    }

    return response
  }

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: MCP_STREAMABLE_HTTP_ACCEPT,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    }
  }

  private async parseJsonRpcResponse<TResult>(
    response: Response,
  ): Promise<JsonRpcResponse<TResult>> {
    const contentType = response.headers.get('content-type') ?? ''

    if (contentType.includes('text/event-stream')) {
      const sseBody = await response.text()
      return this.parseSseResponse<TResult>(sseBody)
    }

    return (await response.json()) as JsonRpcResponse<TResult>
  }

  private parseSseResponse<TResult>(body: string): JsonRpcResponse<TResult> {
    const events = body
      .split(/\r?\n\r?\n/)
      .map(chunk => chunk.trim())
      .filter(Boolean)

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const chunk = events[index]
      const dataLines = chunk
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean)

      if (dataLines.length === 0) {
        continue
      }

      const data = dataLines.join('\n')
      try {
        return JSON.parse(data) as JsonRpcResponse<TResult>
      } catch {
        continue
      }
    }

    throw new Error('Windows-MCP 返回了无法解析的 SSE 响应。')
  }

  private unwrapToolResult(result: CallToolResult): unknown {
    if (result.structuredContent !== undefined) {
      return result.structuredContent
    }

    if (!Array.isArray(result.content)) {
      return result
    }

    const textBlocks = result.content
      .map(block => this.extractTextBlock(block))
      .filter((value): value is string => value !== undefined)

    if (textBlocks.length === 1) {
      return textBlocks[0]
    }

    if (textBlocks.length > 1) {
      return textBlocks
    }

    return result
  }

  private extractTextBlock(block: unknown): string | undefined {
    if (typeof block !== 'object' || block === null) {
      return typeof block === 'string' ? block : undefined
    }

    const candidate = block as Record<string, unknown>
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      return candidate.text
    }

    return undefined
  }

  private extractToolError(result: CallToolResult): string {
    if (!Array.isArray(result.content)) {
      return 'Windows-MCP 工具调用失败。'
    }

    const text = result.content
      .map(block => this.extractTextBlock(block))
      .filter((value): value is string => value !== undefined)
      .join('\n')
      .trim()

    return text || 'Windows-MCP 工具调用失败。'
  }

  private allocateRequestId(): JsonRpcId {
    const id = this.nextRequestId
    this.nextRequestId += 1
    return id
  }
}
