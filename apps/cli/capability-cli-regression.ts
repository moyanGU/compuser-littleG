import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCapabilityExecutor } from './capability-executor.js'
import type {
  WindowsMcpService,
  WindowsMcpServiceStatus,
} from '../../packages/adapters/windows-mcp/WindowsMcpService.js'

type ChildExecution = {
  exitCode: number
  stdout: string
  stderr: string
}

type CapabilityCliJson = {
  ok?: boolean
  summary?: string
  error?: string
  failureClass?: string
  failureReason?: string
  capability?: string
  route?: string
  verification?: {
    strategy?: string
    passed?: boolean
    details?: string
  }
  chainState?: {
    chainStatus?: string
  }
  operations?: Array<{
    type?: string
    target?: string
    ok?: boolean
    summary?: string
  }>
  sessionId?: string
  turnId?: string
  recoveryPoint?: string
  recoveryUsed?: boolean
  verificationEvidence?: string[]
  routingPolicy?: string[]
  data?: {
    capabilityId?: string
    route?: string
    verification?: {
      strategy?: string
      passed?: boolean
      details?: string
    }
    chainState?: {
      chainStatus?: string
    }
    operations?: Array<{
      type?: string
      target?: string
      ok?: boolean
      summary?: string
    }>
    sessionId?: string
    turnId?: string
    recoveryPoint?: string
    recoveryUsed?: boolean
    output?: unknown
  }
  output?: unknown
}

type JsonRpcRequest = {
  jsonrpc?: string
  id?: number | null
  method?: string
  params?: Record<string, unknown>
}

type FakeWindowsMcpState = Record<string, unknown>

const ALLOWLIST = [
  'skill.desktop.observe',
  'command.app.open_or_focus',
  'command.desktop.capture_and_locate',
  'command.clipboard.read_write',
  'command.browser.inspect_dom',
  'skill.browser.click_element_by_name',
  'skill.browser.type_element_by_name',
  'skill.cross_app.transfer_text',
  'skill.file.send_to_chat_window',
  'skill.cross_app.open_observe_act_verify',
] as const

async function main(): Promise<void> {
  await verifyListCapabilities()
  await verifyListWindows()
  await verifyRunCapabilitySuccess()
  await verifyOpenOrFocusReadsPointerContent()
  await verifyParameterError()
  await verifyPowerShellObjectLiteralInput()
  await verifyBrowserClickElementByName()
  await verifyBrowserTypeElementByName()
  await verifyLaunchWindowsMcpFlag()
  await verifyCapabilityNotFound()
  await verifyWindowsMcpUnavailable()
  await verifyVerificationFailure()
  await verifyExternalWindowsServiceIsNotDisposed()
  console.log('Capability CLI regression passed')
}

async function verifyListCapabilities(): Promise<void> {
  const result = await runCapabilityCli([
    'list-capabilities',
    '--json',
  ])

  assert(
    result.exitCode === 0,
    `list-capabilities should exit 0, received ${result.exitCode}. stderr=${result.stderr}`,
  )
  const payload = parseJsonOutput(result.stdout)
  const items = readCapabilityList(payload)
  assert(items.length > 0, 'list-capabilities should return at least one capability')

  for (const capability of ALLOWLIST) {
    assert(
      items.some(item => item.name === capability),
      `list-capabilities should include ${capability}`,
    )
  }

  assert(
    items.every(item => !item.name.startsWith('windows.')),
    'list-capabilities should not expose raw windows.* tools',
  )
  assert(
    items.every(
      item =>
        typeof item.description === 'string' &&
        item.description.length > 0 &&
        typeof item.riskLevel === 'string' &&
        typeof item.inputSchema === 'object' &&
        item.inputSchema !== null,
    ),
    'list-capabilities should include name/description/riskLevel/inputSchema for every item',
  )
}

async function verifyRunCapabilitySuccess(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      App: {
        ok: true,
        summary: 'launch ok',
        focusedWindow: 'Notepad',
        windows: ['Notepad'],
        anchors: ['Notepad'],
        confidence: 1,
      },
      Snapshot: [
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
      ],
    },
    async endpoint => {
      const result = await runCapabilityCli([
        'run-capability',
        '--name',
        'command.app.open_or_focus',
        '--input-json',
        '{"appName":"Notepad"}',
        '--windows-mcp-endpoint',
        endpoint,
        '--json',
      ])

      assert(
        result.exitCode === 0,
        `run-capability success should exit 0, received ${result.exitCode}. stderr=${result.stderr}`,
      )
  const payload = parseCapabilityResult(result.stdout)
  assert(payload.ok === true, 'successful capability run should set ok=true')
      assert(
        typeof payload.summary === 'string' && payload.summary.length > 0,
        'successful capability run should include summary',
      )
      assert(
        payload.capability === 'command.app.open_or_focus',
        'successful capability run should include capability name',
      )
      assert(readRoute(payload) === 'tool', 'successful capability run should include route=tool')
      assert(
        readVerification(payload)?.passed === true,
        'successful capability run should include verification.passed=true',
      )
      assert(
        typeof readVerification(payload)?.strategy === 'string' &&
          (readVerification(payload)?.strategy?.length ?? 0) > 0,
        'successful capability run should include verification.strategy',
      )
      assert(
        readChainState(payload)?.chainStatus === 'completed',
        'successful capability run should include chainState.chainStatus=completed',
      )
      assert(
        Array.isArray(readOperations(payload)) &&
          readOperations(payload).length > 0,
        'successful capability run should include operations',
      )
      assert(
        readOperations(payload).some(
          operation =>
            operation.target === 'windows.focus_window' ||
            operation.target === 'windows.app',
        ),
        'successful capability run should surface nested operation target',
      )
      assert(
        typeof readSessionId(payload) === 'string' &&
          typeof readTurnId(payload) === 'string',
        'successful capability run should include sessionId and turnId',
      )
      assert(
        payload.failureClass === undefined,
        'successful capability run should not include failureClass',
      )
    },
  )
}

async function verifyOpenOrFocusReadsPointerContent(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      App: {
        ok: true,
        summary: 'launch ok',
        focusedWindow: 'Notepad',
        windows: ['Notepad'],
        anchors: ['Notepad'],
        confidence: 1,
      },
      Snapshot: [
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
      ],
    },
    async endpoint => {
      const result = await runCapabilityCli([
        'run-capability',
        '--name',
        'command.app.open_or_focus',
        '--input-json',
        '{appName:Notepad}',
        '--windows-mcp-endpoint',
        endpoint,
        '--json',
      ])

      assert(
        result.exitCode === 0,
        `open_or_focus should read pointer content and exit 0, received ${result.exitCode}. stderr=${result.stderr}`,
      )
      const payload = parseCapabilityResult(result.stdout)
      assert(payload.ok === true, 'open_or_focus should succeed when pointer content is readable')
      assert(
        Array.isArray(payload.operations) && payload.operations.length > 0,
        'open_or_focus should emit operations after reading pointer content',
      )
    },
  )
}

async function verifyParameterError(): Promise<void> {
  const result = await runCapabilityCli([
    'run-capability',
    '--name',
    'command.app.open_or_focus',
    '--input-json',
    '{bad-json',
    '--json',
  ])

  assert(
    result.exitCode === 3,
    `invalid input json should exit 3, received ${result.exitCode}`,
  )
  const payload = parseCapabilityResult(result.stdout)
  assert(payload.ok === false, 'invalid input json should produce ok=false')
  assert(
    containsText(payload.summary, 'json') || containsText(payload.error, 'json'),
    'invalid input json should mention json parse failure',
  )
}

async function verifyPowerShellObjectLiteralInput(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      App: {
        ok: true,
        summary: 'launch ok',
        focusedWindow: 'Notepad',
        windows: ['Notepad'],
        anchors: ['Notepad'],
        confidence: 1,
      },
      Snapshot: [
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Notepad',
          windows: ['Notepad'],
          anchors: ['Notepad'],
        }),
      ],
    },
    async endpoint => {
      const result = await runCapabilityCli([
        'run-capability',
        '--name',
        'command.app.open_or_focus',
        '--input-json',
        '{appName:Notepad}',
        '--windows-mcp-endpoint',
        endpoint,
        '--json',
      ])

      assert(
        result.exitCode === 0,
        `powerShell object literal input should exit 0, received ${result.exitCode}. stderr=${result.stderr}`,
      )
      const payload = parseCapabilityResult(result.stdout)
      assert(payload.ok === true, 'powerShell object literal input should parse successfully')
      assert(
        payload.capability === 'command.app.open_or_focus',
        'powerShell object literal input should retain the capability name',
      )
    },
  )
}

async function verifyLaunchWindowsMcpFlag(): Promise<void> {
  const result = await runCapabilityCli([
    'run-capability',
    '--name',
    'command.app.open_or_focus',
    '--input-json',
    '{appName:Notepad}',
    '--windows-mcp-endpoint',
    'http://127.0.0.1:65530/mcp',
    '--launch-windows-mcp',
    '--json',
  ])

  assert(
    result.exitCode === 4 || result.exitCode === 2 || result.exitCode === 0,
    `launch flag should not be rejected by parsing, received ${result.exitCode}. stderr=${result.stderr}`,
  )
}

async function verifyCapabilityNotFound(): Promise<void> {
  const result = await runCapabilityCli([
    'run-capability',
    '--name',
    'command.demo.not_found',
    '--input-json',
    '{}',
    '--json',
  ])

  assert(
    result.exitCode === 3,
    `unknown capability should exit 3, received ${result.exitCode}`,
  )
  const payload = parseCapabilityResult(result.stdout)
  assert(payload.ok === false, 'unknown capability should produce ok=false')
  assert(
    payload.failureClass === undefined &&
      (containsText(payload.summary, 'invalid capability cli request') ||
        containsText(payload.error, 'not found') ||
        containsText(payload.error, 'unknown') ||
        containsText(payload.error, 'not exposed')),
    'unknown capability should be classified as a request-layer failure',
  )
}

async function verifyWindowsMcpUnavailable(): Promise<void> {
  const result = await runCapabilityCli([
    'run-capability',
    '--name',
    'command.app.open_or_focus',
    '--input-json',
    '{"appName":"Notepad"}',
    '--windows-mcp-endpoint',
    'http://127.0.0.1:65530/mcp',
    '--json',
  ])

  assert(
    result.exitCode === 4,
    `unreachable Windows-MCP should exit 4, received ${result.exitCode}`,
  )
  const payload = parseCapabilityResult(result.stdout)
  assert(payload.ok === false, 'unreachable Windows-MCP should produce ok=false')
  assert(
    payload.failureClass === 'missing_dependency' ||
      payload.failureClass === 'transient' ||
      readVerification(payload)?.passed === false ||
      containsText(payload.summary, 'windows-mcp is not ready') ||
      containsText(payload.error, 'transport_error'),
    'unreachable Windows-MCP should classify the failure explicitly',
  )
}

async function verifyBrowserClickElementByName(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      App: {
        ok: true,
        summary: 'launch ok',
        focusedWindow: 'Microsoft Edge',
        windows: ['Microsoft Edge'],
        anchors: ['MTM-用药助手'],
        confidence: 1,
      },
      Snapshot: {
        summary: 'browser snapshot',
        focusedWindow: 'Microsoft Edge',
        windows: ['Microsoft Edge'],
        anchors: ['MTM-用药助手'],
        confidence: 1,
        dom: {
          title: 'MTM-用药助手',
          activeElement: 'MTM-用药助手',
          selectedText: 'MTM-用药助手',
          nodes: 12,
        },
        interactiveElements: [
          {
            name: 'MTM-用药助手',
            window: 'Microsoft Edge',
            controlType: 'Link',
            label: 101,
            coords: '(341,163)',
            x: 341,
            y: 163,
          },
        ],
      },
      Click: {
        ok: true,
        summary: 'click ok',
      },
    },
    async endpoint => {
      const result = await runCapabilityCli([
        'run-capability',
        '--name',
        'skill.browser.click_element_by_name',
        '--input-json',
        '{"name":"MTM-用药助手","windowTitle":"Microsoft Edge"}',
        '--windows-mcp-endpoint',
        endpoint,
        '--permission-mode',
        'auto',
        '--json',
      ])

      assert(
        result.exitCode === 0,
        `browser click should exit 0, received ${result.exitCode}. stdout=${result.stdout} stderr=${result.stderr}`,
      )
      const payload = parseCapabilityResult(result.stdout)
      assert(payload.ok === true, 'browser click should succeed')
      assert(
        payload.capability === 'skill.browser.click_element_by_name',
        'browser click should return the capability name',
      )
      assert(readRoute(payload) === 'tool', 'browser click should use tool route')
      assert(
        readVerification(payload)?.passed === true,
        'browser click should include passed verification',
      )
      assert(
        readOperations(payload).some(operation =>
          operation.target === 'windows.click_element_by_name',
        ),
        'browser click should call the click element helper',
      )
      assert(
        !readOperations(payload).some(operation =>
          operation.target === 'command.browser.inspect_dom',
        ),
        'browser click should no longer depend on browser inspect dom',
      )
    },
  )
}

async function verifyListWindows(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      Snapshot: [
        createSnapshotPayload({
          focusedWindow: 'WeChat',
          windows: ['WeChat', 'Notepad'],
          anchors: ['WeChat'],
        }),
      ],
    },
    async endpoint => {
      const result = await runCapabilityCli([
        'list-windows',
        '--windows-mcp-endpoint',
        endpoint,
        '--json',
      ])

      assert(
        result.exitCode === 0,
        `list-windows should exit 0, received ${result.exitCode}. stderr=${result.stderr}`,
      )

      const payload = parseJsonOutput(result.stdout) as {
        ok?: boolean
        windows?: unknown
        focusedWindow?: unknown
      }
      assert(payload.ok === true, 'list-windows should return ok=true')
      assert(
        Array.isArray(payload.windows) &&
          payload.windows.includes('WeChat') &&
          payload.windows.includes('Notepad'),
        'list-windows should surface observed windows',
      )
      assert(
        payload.focusedWindow === 'WeChat',
        'list-windows should surface the focused window',
      )
    },
  )
}

async function verifyBrowserTypeElementByName(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      App: {
        ok: true,
        summary: 'browser available',
        focusedWindow: 'Login - MTM Helper - Microsoft Edge',
        windows: ['Login - MTM Helper - Microsoft Edge'],
        anchors: ['Login - MTM Helper - Microsoft Edge'],
        confidence: 1,
      },
      Snapshot: [
        createSnapshotPayload({
          focusedWindow: 'Login - MTM Helper - Microsoft Edge',
          windows: ['Login - MTM Helper - Microsoft Edge'],
          anchors: ['username', 'password', 'login'],
          interactiveElements: [
            {
              label: 21,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'username',
              coords: '(952,602)',
              x: 952,
              y: 602,
            },
            {
              label: 22,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'password',
              coords: '(952,687)',
              x: 952,
              y: 687,
            },
          ],
        }),
        createSnapshotPayload({
          focusedWindow: 'Login - MTM Helper - Microsoft Edge',
          windows: ['Login - MTM Helper - Microsoft Edge'],
          anchors: ['username', 'password', 'login'],
          interactiveElements: [
            {
              label: 21,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'username',
              coords: '(952,602)',
              x: 952,
              y: 602,
            },
            {
              label: 22,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'password',
              coords: '(952,687)',
              x: 952,
              y: 687,
            },
          ],
        }),
        createSnapshotPayload({
          focusedWindow: 'Login - MTM Helper - Microsoft Edge',
          windows: ['Login - MTM Helper - Microsoft Edge'],
          anchors: ['username', 'password', 'login'],
          interactiveElements: [
            {
              label: 21,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'username',
              coords: '(952,602)',
              x: 952,
              y: 602,
            },
            {
              label: 22,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'password',
              coords: '(952,687)',
              x: 952,
              y: 687,
            },
          ],
        }),
        createSnapshotPayload({
          focusedWindow: 'Login - MTM Helper - Microsoft Edge',
          windows: ['Login - MTM Helper - Microsoft Edge'],
          anchors: ['username', 'password', 'login'],
          interactiveElements: [
            {
              label: 21,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'username',
              coords: '(952,602)',
              x: 952,
              y: 602,
            },
            {
              label: 22,
              window: 'Login - MTM Helper - Microsoft Edge',
              controlType: 'Edit',
              name: 'password',
              coords: '(952,687)',
              x: 952,
              y: 687,
            },
          ],
        }),
      ],
      Type: {
        ok: true,
        summary: 'typed ok',
      },
    },
    async endpoint => {
        const result = await runCapabilityCli([
          'run-capability',
          '--name',
          'skill.browser.type_element_by_name',
          '--input-json',
          '{"name":"username","text":"demo_patient","windowTitle":"Microsoft Edge","clear":true}',
          '--windows-mcp-endpoint',
          endpoint,
          '--permission-mode',
          'auto',
        '--json',
      ])

      assert(
        result.exitCode === 0,
        `browser type by name should exit 0, received ${result.exitCode}. stderr=${result.stderr}`,
      )
      const payload = parseCapabilityResult(result.stdout)
      assert(payload.ok === true, 'browser type by name should succeed')
      assert(
        payload.capability === 'skill.browser.type_element_by_name',
        'browser type by name should include capability name',
      )
      assert(
        readVerification(payload)?.passed === true,
        'browser type by name should verify successfully',
      )
      assert(
        readOperations(payload).some(
          operation => operation.target === 'windows.type_element_by_name',
        ),
        'browser type by name should call windows.type_element_by_name',
      )
    },
  )
}

async function verifyVerificationFailure(): Promise<void> {
  await withFakeWindowsMcpServer(
    {
      App: {
        ok: true,
        summary: 'launch ok',
        focusedWindow: 'Codex',
        windows: ['Codex'],
        anchors: ['Codex'],
        confidence: 1,
      },
      Snapshot: [
        createSnapshotPayload({
          focusedWindow: 'Codex',
          windows: ['Codex'],
          anchors: ['Codex'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Codex',
          windows: ['Codex'],
          anchors: ['Codex'],
        }),
        createSnapshotPayload({
          focusedWindow: 'Codex',
          windows: ['Codex'],
          anchors: ['Codex'],
        }),
      ],
    },
    async endpoint => {
      const result = await runCapabilityCli([
        'run-capability',
        '--name',
        'command.app.open_or_focus',
        '--input-json',
        '{"appName":"Notepad"}',
        '--windows-mcp-endpoint',
        endpoint,
        '--json',
      ])

      assert(
        result.exitCode === 2,
        `verification failure should exit 2, received ${result.exitCode}. stderr=${result.stderr}`,
      )
      const payload = parseCapabilityResult(result.stdout)
      assert(payload.ok === false, 'verification failure should produce ok=false')
      assert(
        readVerification(payload)?.passed === false,
        'verification failure should set verification.passed=false',
      )
      assert(
        readChainState(payload)?.chainStatus === 'verified_failed' ||
          readChainState(payload)?.chainStatus === 'execution_failed',
        'verification failure should surface failed chain status',
      )
    },
  )
}

async function verifyExternalWindowsServiceIsNotDisposed(): Promise<void> {
  let disposed = false
  const fakeService: Pick<
    WindowsMcpService,
    'ensureReady' | 'dispose' | 'getStatus'
  > = {
    getStatus() {
      return {
        endpointUrl: 'http://127.0.0.1:8000/mcp',
      } as WindowsMcpServiceStatus
    },
    async ensureReady(): Promise<WindowsMcpServiceStatus> {
      return {
        state: 'ready',
        endpointUrl: 'http://127.0.0.1:8000/mcp',
        transport: 'streamable-http',
        host: '127.0.0.1',
        port: 8000,
        detail: 'ready',
        checkedAt: new Date().toISOString(),
        configPath: 'fake',
        launchedByService: false,
        reusedExistingEndpoint: true,
      }
    },
    async dispose() {
      disposed = true
    },
  }

  const executor = createCapabilityExecutor({
    windowsMcpService: fakeService as WindowsMcpService,
  })

  try {
    await executor.dispose()
    assert(
      disposed === false,
      'executor.dispose should not dispose an injected Windows-MCP service',
    )
  } finally {
    await executor.dispose()
  }
}

async function withFakeWindowsMcpServer(
  state: FakeWindowsMcpState,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handleFakeWindowsMcpRequest(state, request, response)
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })

  const address = server.address()
  assert(
    address !== null && typeof address === 'object',
    'fake Windows-MCP server should expose a bound address',
  )
  const endpoint = `http://127.0.0.1:${address.port}/mcp`

  try {
    await run(endpoint)
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolvePromise()
      })
    })
  }
}

async function handleFakeWindowsMcpRequest(
  state: FakeWindowsMcpState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    response.statusCode = 405
    response.end('method not allowed')
    return
  }

  const body = await readRequestBody(request)
  const payload = JSON.parse(body) as JsonRpcRequest

  if (payload.method === 'initialize') {
    response.setHeader('content-type', 'application/json')
    response.setHeader('mcp-session-id', 'fake-session')
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id ?? 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: {
            name: 'fake-windows-mcp',
            version: '0.1.0',
          },
        },
      }),
    )
    return
  }

  if (payload.method === 'notifications/initialized') {
    response.statusCode = 202
    response.end()
    return
  }

  if (payload.method !== 'tools/call') {
    response.statusCode = 400
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id ?? null,
        error: {
          code: -32601,
          message: `Unsupported method: ${String(payload.method)}`,
        },
      }),
    )
    return
  }

  const toolName = String(payload.params?.name ?? '')
  const resolved = resolveFakeToolResponse(state, toolName)
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id ?? 1,
      result: {
        structuredContent: resolved,
      },
    }),
  )
}

function resolveFakeToolResponse(
  state: FakeWindowsMcpState,
  toolName: string,
): unknown {
  const candidate = state[toolName]
  if (Array.isArray(candidate)) {
    const next = candidate.shift()
    return next ?? { ok: true, summary: `${toolName} ok` }
  }
  if (candidate !== undefined) {
    return candidate
  }
  return { ok: true, summary: `${toolName} ok` }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      resolvePromise(body)
    })
    request.on('error', reject)
  })
}

async function runCapabilityCli(args: string[]): Promise<ChildExecution> {
  const regressionFilePath = fileURLToPath(import.meta.url)
  const compiledAppCliEntry = resolve(dirname(regressionFilePath), 'capability-cli.js')
  const distAppCliEntry = resolve(
    dirname(regressionFilePath),
    '..',
    '..',
    'dist',
    'apps',
    'cli',
    'capability-cli.js',
  )
  const entry = regressionFilePath.includes(`${resolve('dist')}${'\\'}apps${'\\'}cli`)
    ? compiledAppCliEntry
    : distAppCliEntry

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim()
  assert(trimmed.length > 0, 'CLI stdout should not be empty')
  try {
    return JSON.parse(trimmed) as unknown
  } catch (error) {
    throw new Error(
      `CLI stdout should be valid JSON. stdout=${trimmed} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function parseCapabilityResult(stdout: string): CapabilityCliJson {
  return parseJsonOutput(stdout) as CapabilityCliJson
}

function readCapabilityList(payload: unknown): Array<{
  name: string
  description?: string
  riskLevel?: string
  inputSchema?: unknown
}> {
  if (Array.isArray(payload)) {
    return payload as Array<{
      name: string
      description?: string
      riskLevel?: string
      inputSchema?: unknown
    }>
  }

  if (typeof payload !== 'object' || payload === null) {
    return []
  }

  const list =
    (payload as { data?: { capabilities?: unknown } }).data?.capabilities ??
    (payload as { capabilities?: unknown }).capabilities ??
    (payload as { items?: unknown }).items ??
    (payload as { matches?: unknown }).matches

  return Array.isArray(list)
    ? (list as Array<{
        name: string
        description?: string
        riskLevel?: string
        inputSchema?: unknown
      }>)
    : []
}

function createSnapshotPayload(input: {
  focusedWindow: string
  windows: string[]
  anchors: string[]
  confidence?: number
  interactiveElements?: Array<{
    label?: number
    window?: string
    controlType?: string
    name: string
    coords?: string
    metadata?: string
    x?: number
    y?: number
  }>
}): {
  summary: string
  focusedWindow: string
  windows: string[]
  anchors: string[]
  confidence: number
  interactiveElements?: Array<{
    label?: number
    window?: string
    controlType?: string
    name: string
    coords?: string
    metadata?: string
    x?: number
    y?: number
  }>
} {
  return {
    summary: `snapshot for ${input.focusedWindow}`,
    focusedWindow: input.focusedWindow,
    windows: input.windows,
    anchors: input.anchors,
    confidence: input.confidence ?? 1,
    ...(input.interactiveElements ? { interactiveElements: input.interactiveElements } : {}),
  }
}

function readVerification(
  payload: CapabilityCliJson,
):
  | {
      strategy?: string
      passed?: boolean
      details?: string
    }
  | undefined {
  return payload.verification ?? payload.data?.verification
}

function readChainState(
  payload: CapabilityCliJson,
):
  | {
      chainStatus?: string
    }
  | undefined {
  return payload.chainState ?? payload.data?.chainState
}

function readOperations(
  payload: CapabilityCliJson,
): Array<{
  type?: string
  target?: string
  ok?: boolean
  summary?: string
}> {
  return payload.operations ?? payload.data?.operations ?? []
}

function readRoute(payload: CapabilityCliJson): string | undefined {
  return payload.route ?? payload.data?.route
}

function readSessionId(payload: CapabilityCliJson): string | undefined {
  return payload.sessionId ?? payload.data?.sessionId
}

function readTurnId(payload: CapabilityCliJson): string | undefined {
  return payload.turnId ?? payload.data?.turnId
}

function containsText(value: string | undefined, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(expected.toLowerCase())
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
