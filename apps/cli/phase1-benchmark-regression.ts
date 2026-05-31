import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import { ContextAssembler } from '../../packages/harness/context/ContextAssembler.js'
import { InMemoryMemoryStore } from '../../packages/harness/memory/MemoryStore.js'
import {
  createPermissionRequest,
  RiskAwarePermissionPolicy,
  RuleBasedPermissionReviewer,
} from '../../packages/security/PermissionPolicy.js'
import { createResultPointerTools } from '../../packages/tools/ResultPointerTools.js'
import {
  InMemoryToolRegistry,
  type AnyToolDefinition,
  type ToolCall,
} from '../../packages/tools/Tool.js'
import { createWorkspaceTools } from '../../packages/tools/WorkspaceTools.js'
import {
  AllowAllPermissionChecker,
  PolicyPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import type { CliBackendAdapter } from '../../packages/adapters/cli/CliBackendAdapter.js'
import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import type { WindowsMcpBridge } from '../../packages/adapters/windows-mcp/WindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'compuser-phase1-'))

  try {
    await seedWorkspace(workspaceRoot)

    await runWorkspaceRetrievalChain(workspaceRoot)
    await runDesktopObserveChain(workspaceRoot)
    await runCrossAppTransferChain(workspaceRoot)
    await runFallbackChain(workspaceRoot)
    await runLargeResultPointerChain(workspaceRoot)
    await runPermissionChain()
    await runPermissionReviewerChain()
    await runPermissionSessionGrantChain()
    await runPermissionAutoModeBypassesReviewerChain()

    console.log('Phase 1 benchmark regression passed: 9/9')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function runWorkspaceRetrievalChain(workspaceRoot: string): Promise<void> {
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWorkspaceTools({ workspaceRoot })) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  const cliAdapter: CliBackendAdapter = {
    async runPowerShell(script) {
      if (script.includes('Get-ChildItem')) {
        return {
          ok: true,
          commandLine: 'powershell',
          exitCode: 0,
          stdout: JSON.stringify({
                            root: workspaceRoot,
                            entries: [
              { path: resolve(workspaceRoot, 'demo.ts'), type: 'file', size: 64 },
                            ],
          }),
          stderr: '',
          timedOut: false,
          summary: 'tree ok',
        }
      }

      const raw = await readFile(resolve(workspaceRoot, 'demo.ts'), 'utf8')
      return {
        ok: true,
        commandLine: 'powershell',
        exitCode: 0,
        stdout: JSON.stringify({
          path: resolve(workspaceRoot, 'demo.ts'),
          startLine: 1,
          endLine: raw.split(/\r?\n/).length,
          lines: raw.split(/\r?\n/),
        }),
        stderr: '',
        timedOut: false,
        summary: 'read ok',
      }
    },
  }
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
    cliAdapter,
  })) {
    registry.register(tool)
  }

  const treeResult = await runtime.execute(
    {
      toolName: 'command.workspace.inspect_tree',
      input: { path: workspaceRoot, depth: 3, limit: 20 },
    },
    createToolContext(workspaceRoot, 'workspace-tree'),
  )

  assert(treeResult.ok, 'workspace tree command should succeed')

  const searchResult = await runtime.execute(
    {
      toolName: 'workspace.grep',
      input: {
        query: 'QueryEngine',
        path: workspaceRoot,
        includePattern: 'demo.ts',
        limit: 10,
      },
    },
    createToolContext(workspaceRoot, 'workspace-search'),
  )

  assert(searchResult.ok, 'workspace grep should succeed')
  const matches = (searchResult.data as { matches?: Array<unknown> }).matches ?? []
  assert(matches.length > 0, 'workspace grep should find the seeded QueryEngine text')

  const readResult = await runtime.execute(
    {
      toolName: 'command.workspace.read_text',
      input: {
        path: resolve(workspaceRoot, 'demo.ts'),
        offset: 1,
        limit: 10,
      },
    },
    createToolContext(workspaceRoot, 'workspace-read'),
  )

  assert(readResult.ok, 'workspace read command should succeed')
}

async function runDesktopObserveChain(workspaceRoot: string): Promise<void> {
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  const adapter = new BridgeWindowsMcpAdapter(
    new BenchmarkWindowsBridge({
      Screenshot: {
        summary: 'screenshot ok',
        windows: ['Notepad'],
      },
      Snapshot: {
        summary: 'snapshot ok',
        windows: ['Notepad'],
        focusedWindow: 'Notepad',
      },
      App: {
        ok: true,
        summary: 'focused notepad',
      },
    }),
  )
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }
  const observeResult = await runtime.execute(
    {
      toolName: 'skill.desktop.observe',
      input: {},
    },
    createToolContext(workspaceRoot, 'desktop-observe'),
  )
  assert(observeResult.ok, 'desktop observe capability should succeed')

  const focusResult = await runtime.execute(
    {
      toolName: 'windows.focus_window',
      input: { windowTitle: 'Notepad' },
    },
    createToolContext(workspaceRoot, 'desktop-focus'),
  )
  assert(focusResult.ok, 'focus window should succeed')
}

async function runCrossAppTransferChain(workspaceRoot: string): Promise<void> {
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  const adapter = new BridgeWindowsMcpAdapter(
    new BenchmarkWindowsBridge({
      App: { ok: true, summary: 'focused app' },
      Snapshot: {
        summary: 'snapshot ok',
        windows: ['Notepad'],
        focusedWindow: 'Notepad',
        interactiveElements: [
          {
            label: 1,
            window: 'Notepad',
            controlType: 'Edit',
            name: 'Edit',
            coords: '[120,120,380,160]',
          },
        ],
      },
      Clipboard: [
        {
          ok: true,
          summary: 'clipboard set',
          raw: {
            text: 'hello from compuser',
          },
        },
        {
          ok: true,
          summary: 'clipboard get',
          raw: {
            text: 'hello from compuser',
          },
        },
      ],
      Shortcut: { ok: true, summary: 'shortcut ok' },
      Type: { ok: true, summary: 'typed text' },
    }),
  )

  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.transfer_text',
      input: {
        text: 'hello from compuser',
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(workspaceRoot, 'cross-app-transfer'),
  )

  assert(result.ok, 'cross-app transfer capability should succeed')
  const verification = ((result.data as { verification?: { passed?: boolean } }).verification)
  assert(verification?.passed === true, 'cross-app transfer should verify success')
}

async function runFallbackChain(workspaceRoot: string): Promise<void> {
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  const cliAdapter: CliBackendAdapter = {
    async runPowerShell(script) {
      if (script.includes('Select-String')) {
        return {
          ok: false,
          commandLine: 'powershell',
          exitCode: 1,
          stdout: '',
          stderr: 'forced backend failure',
          timedOut: false,
          summary: 'forced backend failure',
        }
      }

      return {
        ok: true,
        commandLine: 'powershell',
        exitCode: 0,
        stdout: '{"root":"demo","entries":[]}',
        stderr: '',
        timedOut: false,
        summary: 'ok',
      }
    },
  }

  const registry = new InMemoryToolRegistry()
  registry.register(createFallbackStubTool('workspace.grep', async () => ({
    ok: true,
    summary: 'workspace grep fallback ok',
  })))

  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
    cliAdapter,
  })) {
    registry.register(tool)
  }

  const primary = await runtime.execute(
    {
      toolName: 'command.workspace.search_text',
      input: { query: 'QueryEngine', path: workspaceRoot },
    },
    createToolContext(workspaceRoot, 'fallback-primary'),
  )

  assert(!primary.ok, 'primary backend-first capability should fail in fallback benchmark')

  const fallback = await runtime.execute(
    {
      toolName: 'workspace.grep',
      input: { query: 'QueryEngine', path: workspaceRoot, includePattern: 'demo.ts' },
    },
    createToolContext(workspaceRoot, 'fallback-secondary'),
  )

  assert(fallback.ok, 'fallback tool should succeed after backend failure')
}

async function runLargeResultPointerChain(workspaceRoot: string): Promise<void> {
  const registry = new InMemoryToolRegistry()
  for (const tool of createResultPointerTools(workspaceRoot)) {
    registry.register(tool)
  }

  const largeTool: AnyToolDefinition = {
    name: 'large.inline',
    availability: 'core',
    description: 'Return a large inline payload for pointer-storage regression.',
    searchHints: ['large', 'result', 'pointer'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    maxResultChars: 100,
    inputSchema: {
      description: 'large inline input',
    },
    async execute() {
      return {
        ok: true,
        summary: 'generated large result',
        data: {
          content: 'A'.repeat(800),
        },
      }
    },
  }
  registry.register(largeTool)

  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  const result = await runtime.execute(
    {
      toolName: 'large.inline',
      input: {},
    },
    createToolContext(workspaceRoot, 'large-result'),
  )

  assert(result.ok, 'large result tool should succeed')
  assert(typeof result.pointer === 'string', 'large result should be externalized to a pointer')

  const readBack = await runtime.execute(
    {
      toolName: 'artifacts.read_result',
      input: {
        pointer: result.pointer,
        maxChars: 120,
        offset: 0,
      },
    },
    createToolContext(workspaceRoot, 'large-result-readback'),
  )

  assert(readBack.ok, 'artifact readback should succeed')
  const content = ((readBack.data as { content?: string }).content) ?? ''
  assert(content.length > 0, 'artifact readback should return content')
}

async function runPermissionChain(): Promise<void> {
  const policy = new RiskAwarePermissionPolicy('default')
  const denied = await policy.evaluate(
    createPermissionRequest('windows.shortcut', { shortcut: 'alt+f4' }, 'high'),
  )
  assert(denied.decision === 'deny', 'high-risk shortcut should be denied in default mode')

  const allowed = await policy.evaluate(
    createPermissionRequest(
      'windows.shell',
      { command: 'Get-ChildItem' },
      'high',
    ),
  )
  assert(allowed.decision === 'allow', 'read-only shell command should be allowed after classification')
  assert(
    allowed.classification.readonlyShell === true,
    'read-only shell command should be classified as readonly',
  )

  const controlledLaunch = await policy.evaluate(
    createPermissionRequest(
      'windows.shell',
      { command: 'Start-Process notepad.exe' },
      'high',
    ),
  )
  assert(
    controlledLaunch.decision === 'allow',
    'controlled app launch shell command should be allowed after classification',
  )
  assert(
    controlledLaunch.classification.riskLevel === 'medium',
    'controlled app launch shell command should downgrade to medium risk',
  )
}

async function runPermissionSessionGrantChain(): Promise<void> {
  const registry = new InMemoryToolRegistry()
  registry.register({
    name: 'windows.shortcut',
    availability: 'core',
    description: 'permission grant benchmark shortcut tool',
    searchHints: ['windows', 'shortcut'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    permissionProfile: {
      grantScopes: ['once', 'tool', 'risk'],
    },
    inputSchema: {
      description: 'shortcut input',
      properties: {
        shortcut: { type: 'string' },
      },
      required: ['shortcut'],
    },
    async execute() {
      return {
        ok: true,
        summary: 'shortcut ok',
      }
    },
  })

  let promptCount = 0
  const checker = new PolicyPermissionChecker(
    registry,
    new RiskAwarePermissionPolicy('confirm-high-risk'),
    {
      async confirm() {
        promptCount += 1
        return {
          approved: true,
          grantScope: 'tool',
        }
      },
    },
  )

  const first = await checker.canUseTool('windows.shortcut', { shortcut: 'alt+f4' })
  const second = await checker.canUseTool('windows.shortcut', { shortcut: 'alt+f4' })

  assert(first.allowed, 'first high-risk shortcut request should be approved by prompt')
  assert(second.allowed, 'second high-risk shortcut request should reuse session grant')
  assert(promptCount === 1, 'tool session grant should avoid a second confirmation in the same session')
}

async function runPermissionReviewerChain(): Promise<void> {
  const reviewer = new RuleBasedPermissionReviewer()

  const reviewed = await reviewer.review(
    createPermissionRequest(
      'windows.shortcut',
      { shortcut: 'alt+f4' },
      'high',
    ),
  )

  assert(reviewed.reviewSource === 'rule-reviewer', 'reviewer should mark rule-reviewer source')
  assert(reviewed.reviewStage === 'review', 'reviewer should mark review stage')
  assert(reviewed.decision === 'ask', 'reviewer should escalate destructive shortcut to ask')
}

async function runPermissionAutoModeBypassesReviewerChain(): Promise<void> {
  const registry = new InMemoryToolRegistry()
  registry.register({
    name: 'windows.shell',
    availability: 'core',
    description: 'shell tool benchmark stub',
    searchHints: ['shell', 'powershell', 'benchmark'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'shell input',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    async execute() {
      return {
        ok: true,
        summary: 'shell ok',
      }
    },
  })

  const checker = new PolicyPermissionChecker(
    registry,
    new RiskAwarePermissionPolicy('auto'),
  )

  const decision = await checker.canUseTool('windows.shell', {
    command: "Start-Process msedge.exe 'file:///demo.html'",
  })

  assert(
    decision.allowed,
    'auto mode should not block high-risk shell when policy mode is auto',
  )
  assert(
    decision.evaluation?.decision === 'allow',
    'auto mode should preserve allow decision after reviewer stage',
  )
}

async function seedWorkspace(workspaceRoot: string): Promise<void> {
  await writeFile(
    resolve(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'phase1-benchmark', private: true }, null, 2),
    'utf8',
  )
  await writeFile(
    resolve(workspaceRoot, 'README.md'),
    '# Phase 1 benchmark\n',
    'utf8',
  )
  await writeFile(
    resolve(workspaceRoot, 'demo.ts'),
    ['export function runQueryEngine() {', "  return 'QueryEngine benchmark';", '}'].join('\n'),
    'utf8',
  )
}

function createToolContext(workspaceRoot: string, turnId: string) {
  return {
    cwd: workspaceRoot,
    sessionId: 'phase1-benchmark',
    turnId,
  }
}

function createFallbackStubTool(
  name: string,
  execute: AnyToolDefinition['execute'],
): AnyToolDefinition {
  return {
    name,
    availability: 'core',
    description: `${name} benchmark fallback stub`,
    searchHints: [name, 'fallback', 'benchmark'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: `${name} input`,
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        includePattern: { type: 'string' },
      },
    },
    execute,
  }
}

class BenchmarkWindowsBridge implements WindowsMcpBridge {
  private readonly clipboardResponses: unknown[]

  constructor(private readonly fixtures: Record<string, unknown>) {
    this.clipboardResponses = Array.isArray(fixtures.Clipboard)
      ? [...fixtures.Clipboard]
      : []
  }

  async call<TResponse = unknown>(request: {
    toolName: string
    args: Record<string, unknown>
  }): Promise<TResponse> {
    if (request.toolName === 'Clipboard' && this.clipboardResponses.length > 0) {
      return this.clipboardResponses.shift() as TResponse
    }

    return (this.fixtures[request.toolName] ??
      { ok: true, summary: `${request.toolName} ok` }) as TResponse
  }
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
