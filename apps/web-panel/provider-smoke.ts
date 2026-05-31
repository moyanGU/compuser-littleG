import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { PANEL_DEFAULT_SESSION_ID } from './defaults.js'

const panelPort = 4321
const providerPort = 4322
const windowsMcpPort = 4323

async function main(): Promise<void> {
  await withFakeWindowsMcpServer(async () => {
    await withFakeProviderServer(
      {
        mode: 'tool-then-success',
      },
      async providerState => {
        await withPanelServer(
          {
            port: panelPort,
            windowsMcpEndpoint: `http://127.0.0.1:${windowsMcpPort}/mcp`,
            modelBaseUrl: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
            modelName: 'provider-smoke-model',
          },
          async port => {
            await verifySessionTaskUsesRealProvider(port, providerState)
            await verifyTemplateLaunchUsesRealProvider(port, providerState)
          },
        )
      },
    )
  })

  await withFakeWindowsMcpServer(async () => {
    await withFakeProviderServer(
      {
        mode: 'http-error',
      },
      async () => {
        await withPanelServer(
          {
            port: panelPort,
            windowsMcpEndpoint: `http://127.0.0.1:${windowsMcpPort}/mcp`,
            modelBaseUrl: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
            modelName: 'provider-smoke-model',
          },
          async port => {
            await verifyStructuredProviderFailure(port)
          },
        )
      },
    )
  })

  await withFakeWindowsMcpServer(async () => {
    await withPanelServer(
      {
        port: panelPort,
        windowsMcpEndpoint: `http://127.0.0.1:${windowsMcpPort}/mcp`,
        modelBaseUrl: 'http://127.0.0.1:45999/v1/chat/completions',
        modelName: 'provider-smoke-model',
      },
      async port => {
        await verifyTransportProviderFailure(port)
      },
    )
  })

  console.log('web-panel-provider-smoke ok')
}

async function withPanelServer(
  options: {
    port: number
    windowsMcpEndpoint: string
    modelBaseUrl: string
    modelName: string
  },
  run: (port: number) => Promise<void>,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      'dist/apps/web-panel/server.js',
      '--port',
      String(options.port),
      '--windows-mcp-endpoint',
      options.windowsMcpEndpoint,
      '--model-provider',
      'openai-compatible',
      '--model-base-url',
      options.modelBaseUrl,
      '--model-name',
      options.modelName,
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  try {
    await waitForServer(child, options.port)
    await run(options.port)
  } finally {
    child.kill()
  }
}

async function withFakeProviderServer(
  options: {
    mode: 'success' | 'tool-then-success' | 'http-error'
  },
  run: (state: { requestCount: number; lastBody?: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  const state: { requestCount: number; lastBody?: Record<string, unknown> } = {
    requestCount: 0,
  }
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/v1/chat/completions'
    ) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    state.requestCount += 1
    const rawBody = await readRequestBody(request)
    state.lastBody = JSON.parse(rawBody) as Record<string, unknown>

    if (options.mode === 'http-error') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            message: 'bad provider request',
          },
        }),
      )
      return
    }

    if (options.mode === 'tool-then-success' && state.requestCount === 1) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Call one tool before answering.',
                tool_calls: [
                  {
                    id: 'call_windows_snapshot_1',
                    type: 'function',
                    function: {
                      name: 'tool_d2luZG93cy5zbmFwc2hvdA',
                      arguments: '{}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      )
      return
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'provider smoke final answer',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    )
  })

  await listenServer(server, providerPort)
  try {
    await run(state)
  } finally {
    await closeServer(server)
  }
}

async function withFakeWindowsMcpServer(run: () => Promise<void>): Promise<void> {
  const server = createFakeWindowsMcpServer()
  await listenServer(server, windowsMcpPort)
  try {
    await run()
  } finally {
    await closeServer(server)
  }
}

async function verifySessionTaskUsesRealProvider(
  port: number,
  providerState: { requestCount: number; lastBody?: Record<string, unknown> },
): Promise<void> {
  const beforeCount = providerState.requestCount
  const response = await postJson(port, '/session/task', {
    sessionId: 'provider-smoke-session',
    task: 'Inspect the workspace tree and summarize the current route.',
  })
  assert(response.status === 202, 'session task should be accepted')

  const state = await waitForSessionResult(port, 'provider-smoke-session')
  assert(state.view === 'result', 'session task should finish in result view')
  assert(
    providerState.requestCount > beforeCount,
    'session task should trigger a real provider request',
  )
  assert(
    providerState.lastBody?.model === 'provider-smoke-model',
    'session task should forward the configured provider model name',
  )
  const tools = providerState.lastBody?.tools
  assert(Array.isArray(tools), 'session task should forward tool definitions to the provider')
  assert(
    tools.some(tool => {
      const functionName =
        typeof tool === 'object' &&
        tool !== null &&
        typeof (tool as { function?: { name?: unknown } }).function?.name === 'string'
          ? (tool as { function: { name: string } }).function.name
          : undefined
      return typeof functionName === 'string' && functionName.startsWith('tool_')
    }),
    'session task should sanitize tool names for OpenAI-compatible gateways',
  )
}

async function verifyTemplateLaunchUsesRealProvider(
  port: number,
  providerState: { requestCount: number; lastBody?: Record<string, unknown> },
): Promise<void> {
  const beforeCount = providerState.requestCount
  const response = await postJson(
    port,
    '/product/templates/browser-editor-chat-reply-template/launch',
    {
      sessionId: 'provider-template-session',
    },
  )
  assert(
    response.status === 202,
    'template launch should be accepted when environment is ready',
  )

  if (response.body.requiresConfirmation === true) {
    const decisionResponse = await postJson(
      port,
      '/session/provider-template-session/template-launch-decision',
      {
        decision: 'approve',
      },
    )
    assert(
      decisionResponse.status === 202,
      'template confirmation should be accepted before provider execution',
    )
  }

  const state = await waitForSessionResult(port, 'provider-template-session')
  assert(state.view === 'result', 'template launch should finish in result view')
  assert(
    providerState.requestCount > beforeCount,
    'template launch should trigger a real provider request',
  )
  assert(
    providerState.lastBody?.model === 'provider-smoke-model',
    'template launch should forward the configured provider model name',
  )
}

async function verifyStructuredProviderFailure(port: number): Promise<void> {
  const response = await postJson(port, '/session/task', {
    sessionId: 'provider-http-error-session',
    task: 'Provider http error should stay visible.',
  })
  assert(response.status === 202, 'structured provider failure should still be accepted')

  const state = await waitForSessionResult(port, 'provider-http-error-session')
  assert(
    state.currentStage === 'execution_failed',
    'structured provider failure should surface execution_failed stage',
  )
  assert(
    state.stopReason === 'provider_error',
    'structured provider failure should classify as provider_error',
  )
  assert(
    typeof state.finalText === 'string' &&
      state.finalText.includes('provider_error code=http_error'),
    'structured provider failure should expose explicit provider error text',
  )
}

async function verifyTransportProviderFailure(port: number): Promise<void> {
  const response = await postJson(port, '/session/task', {
    sessionId: 'provider-transport-error-session',
    task: 'Provider transport error should stay visible.',
  })
  assert(response.status === 202, 'transport provider failure should still be accepted')

  const state = await waitForSessionResult(port, 'provider-transport-error-session')
  assert(
    state.currentStage === 'execution_failed',
    'transport provider failure should surface execution_failed stage',
  )
  assert(
    state.stopReason === 'transport_error',
    'transport provider failure should classify as transport_error',
  )
  assert(
    typeof state.finalText === 'string' &&
      state.finalText.includes('transport_error code=network_error'),
    'transport provider failure should expose explicit transport error text',
  )
}

async function waitForSessionResult(
  port: number,
  sessionId: string,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}/state`,
    )
    if (response.ok) {
      const state = (await response.json()) as Record<string, any>
      if (state.view === 'result' && state.isRunning === false) {
        return state
      }
    }
    await delay(200)
  }

  throw new Error(`session did not reach result view: ${sessionId}`)
}

async function postJson(
  port: number,
  pathname: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
}

function createFakeWindowsMcpServer(): Server {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: {
            name: 'provider-smoke-fake-windows-mcp',
            version: '0.1.0',
          },
        },
      }),
    )
  })
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function listenServer(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function waitForServer(
  child: ReturnType<typeof spawn>,
  port: number,
): Promise<void> {
  let stderr = ''
  if (child.stderr) {
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`web-panel server exited early: ${stderr}`)
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/session/${PANEL_DEFAULT_SESSION_ID}/state`,
      )
      if (response.ok) {
        return
      }
    } catch {
      // keep polling
    }

    await delay(200)
  }

  throw new Error(`web-panel server did not become ready. ${stderr}`)
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
