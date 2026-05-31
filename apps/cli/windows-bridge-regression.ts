import { StreamableHttpWindowsMcpBridge } from '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
import { createWindowsMcpBridge } from './cliApp.js'

async function main(): Promise<void> {
  await verifyStructuredContentResponse()
  await verifyTextContentResponse()
  await verifySseResponse()
  await verifyDefaultBridgeUsesHttpTransport()
  await verifySnapshotNormalizationAddsAnchorsAndConfidence()
  await verifyTextSnapshotPayloadNormalization()
  await verifyFocusNotFoundNormalizesFailure()
  await verifyFocusWindowUsesInteractiveFallback()
  await verifyTextSnapshotSkipsNoWindowsFound()
  console.log('Windows bridge regression passed: 8/8')
}

async function verifyStructuredContentResponse(): Promise<void> {
  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        structuredContent: {
          summary: 'snapshot ok',
          windows: ['Notepad'],
        },
      }),
    ]),
  )

  const result = await bridge.call({
    toolName: 'Snapshot',
    args: {},
  }) as { summary?: string }

  assert(result.summary === 'snapshot ok', 'structuredContent should be unwrapped')
}

async function verifyTextContentResponse(): Promise<void> {
  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: 'clipboard ok',
          },
        ],
      }),
    ]),
  )

  const result = await bridge.call({
    toolName: 'Clipboard',
    args: {
      mode: 'get',
    },
  })

  assert(result === 'clipboard ok', 'text content should be unwrapped')
}

async function verifySseResponse(): Promise<void> {
  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      sseJsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      sseJsonRpcResponse({
        content: [
          {
            type: 'text',
            text: 'powershell ok',
          },
        ],
      }),
    ]),
  )

  const result = await bridge.call({
    toolName: 'PowerShell',
    args: {
      command: 'Get-ChildItem',
    },
  })

  assert(result === 'powershell ok', 'SSE JSON-RPC response should be parsed')
}

async function verifyDefaultBridgeUsesHttpTransport(): Promise<void> {
  const bridge = createWindowsMcpBridge()

  assert(
    bridge instanceof StreamableHttpWindowsMcpBridge,
    'default Windows-MCP bridge should use streamable HTTP transport',
  )
}

async function verifySnapshotNormalizationAddsAnchorsAndConfidence(): Promise<void> {
  const { BridgeWindowsMcpAdapter } = await import(
    '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
  )
  const { StreamableHttpWindowsMcpBridge } = await import(
    '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
  )

  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        structuredContent: {
          summary: 'dom snapshot ok',
          windows: ['Browser'],
          focusedWindow: 'Browser',
          dom: {
            title: 'Example Page',
            url: 'https://example.com',
            activeElement: 'textarea',
            nodes: 4,
          },
        },
      }),
    ]),
  )

  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const result = await adapter.snapshot({ useDom: true })

  assert(result.observationMode === 'dom', 'snapshot should preserve DOM mode')
  assert((result.anchors?.length ?? 0) >= 2, 'snapshot should expose anchors')
  assert(
    typeof result.confidence === 'number' && result.confidence >= 0.45,
    'snapshot should calculate observation confidence',
  )
  assert(
    typeof result.domSummary === 'string' && result.domSummary.includes('url='),
    'snapshot should expose DOM summary',
  )
}

async function verifyTextSnapshotPayloadNormalization(): Promise<void> {
  const { BridgeWindowsMcpAdapter } = await import(
    '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
  )
  const { StreamableHttpWindowsMcpBridge } = await import(
    '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
  )

  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              `
    Focused Window:
    Name      Depth  Status
------  -------  --------
Codex         0  Normal

    Opened Windows:
    Name                    Depth  Status
----------------------  -------  --------
Codex                        0  Normal
Notepad                      1  Normal

    List of Interactive Elements:
    # id|window|control_type|name|coords|metadata
              `.trim(),
            ]),
          },
        ],
      }),
    ]),
  )

  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const result = await adapter.snapshot()

  assert(result.focusedWindow === 'Codex', 'text snapshot should parse focused window')
  assert(
    Array.isArray(result.windows) && result.windows.includes('Notepad'),
    'text snapshot should parse opened windows',
  )
  assert(
    (result.anchors?.length ?? 0) > 0,
    'text snapshot should expose anchors from parsed windows',
  )
}

async function verifyFocusNotFoundNormalizesFailure(): Promise<void> {
  const { BridgeWindowsMcpAdapter } = await import(
    '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
  )
  const { StreamableHttpWindowsMcpBridge } = await import(
    '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
  )

  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        structuredContent: {
          summary: 'preflight snapshot',
          windows: ['Codex'],
          focusedWindow: 'Codex',
        },
      }),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: 'Application Notepad not found.',
          },
        ],
      }),
      jsonRpcResponse({
        structuredContent: {
          summary: 'verification snapshot after primary candidate',
          windows: ['Codex'],
          focusedWindow: 'Codex',
        },
      }),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: 'Application notepad not found.',
          },
        ],
      }),
      jsonRpcResponse({
        structuredContent: {
          summary: 'verification snapshot after alias candidate',
          windows: ['Codex'],
          focusedWindow: 'Codex',
        },
      }),
    ]),
  )

  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const result = await adapter.focusWindow('Notepad')

  assert(result.ok === false, 'focus not found should normalize as failure')
  assert(
    result.failureClass === 'deterministic',
    'focus not found should normalize deterministic failure class',
  )
  assert(
    result.verification?.passed === false,
    'focus not found should retain failed verification details',
  )
}

async function verifyFocusWindowUsesInteractiveFallback(): Promise<void> {
  const { BridgeWindowsMcpAdapter } = await import(
    '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
  )
  const { StreamableHttpWindowsMcpBridge } = await import(
    '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
  )

  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        structuredContent: {
          summary: 'preflight snapshot',
          windows: ['Codex', 'Notepad'],
          focusedWindow: 'Codex',
          interactiveElements: [
            {
              label: 7,
              name: 'Notepad',
              window: 'Taskbar',
              controlType: 'Button',
            },
          ],
        },
      }),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: 'Application Notepad not found.',
          },
        ],
      }),
      jsonRpcResponse({
        structuredContent: {
          summary: 'verification snapshot after failed switch',
          windows: ['Codex', 'Notepad'],
          focusedWindow: 'Codex',
          interactiveElements: [
            {
              label: 7,
              name: 'Notepad',
              window: 'Taskbar',
              controlType: 'Button',
            },
          ],
        },
      }),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: 'clicked fallback target',
          },
        ],
      }),
      jsonRpcResponse({
        structuredContent: {
          summary: 'verification snapshot after fallback click',
          windows: ['Codex', 'Notepad'],
          focusedWindow: 'Notepad',
        },
      }),
    ]),
  )

  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const result = await adapter.focusWindow('Notepad')

  assert(result.ok === true, 'interactive fallback should recover focus success')
  assert(
    result.verification?.passed === true,
    'interactive fallback should still verify focused target',
  )
}

async function verifyTextSnapshotSkipsNoWindowsFound(): Promise<void> {
  const { BridgeWindowsMcpAdapter } = await import(
    '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
  )
  const { StreamableHttpWindowsMcpBridge } = await import(
    '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
  )

  const bridge = new StreamableHttpWindowsMcpBridge(
    'http://127.0.0.1:8000/mcp',
    createFetchStub([
      jsonRpcResponse({
        protocolVersion: '2025-03-26',
      }),
      emptySuccessResponse(),
      jsonRpcResponse({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              `
    Focused Window:
    Name      Depth  Status
------  -------  --------
Codex         0  Normal

    Opened Windows:
    Name                    Depth  Status
----------------------  -------  --------
No windows found

    List of Interactive Elements:
    # id|window|control_type|name|coords|metadata
              `.trim(),
            ]),
          },
        ],
      }),
    ]),
  )

  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const result = await adapter.snapshot()

  assert(
    Array.isArray(result.windows) && result.windows.length === 0,
    'text snapshot should not keep "No windows found" as a real window',
  )
}

function createFetchStub(responses: Response[]): typeof fetch {
  let index = 0

  return async () => {
    const response = responses[index]
    index += 1
    if (!response) {
      throw new Error('Unexpected extra fetch call')
    }
    return response
  }
}

function jsonRpcResponse(result: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
      },
    },
  )
}

function emptySuccessResponse(): Response {
  return new Response('', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'mcp-session-id': 'session-1',
    },
  })
}

function sseJsonRpcResponse(result: unknown): Response {
  return new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result,
    })}\n\n`,
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'mcp-session-id': 'session-1',
      },
    },
  )
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
