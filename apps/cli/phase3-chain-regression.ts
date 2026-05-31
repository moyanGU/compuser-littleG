import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import {
  InMemoryToolRegistry,
  type ToolDefinition,
} from '../../packages/tools/Tool.js'
import {
  AllowAllPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'

async function main(): Promise<void> {
  await verifyBrowserEditorChatTemplate()
  await verifyBrowserEditorChatTemplateFailsWhenBaseChainFails()
  await verifyFileBrowserDesktopTemplate()
  await verifyFileBrowserDesktopTemplateFailsWhenBaseChainFails()
  await verifyMultiWindowRouteDeliverTemplate()
  await verifyMultiWindowRouteDeliverTemplateFailsWhenBaseChainFails()
  console.log('Phase 3 chain regression passed: 6/6')
}

async function verifyBrowserEditorChatTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.editor_chat_stage_and_deliver_verify',
      ['editorAppName', 'chatAppName'],
      async input => ({
        ok: true,
        summary: `verified chat delivery for ${String(input.chatAppName)}`,
        data: {
          verification: {
            passed: true,
          },
          output: {
            extractedText: 'Need reply in chat',
            editorTargetWindowTitle: 'Notepad',
            chatTargetWindowTitle: 'Codex',
            selectedWindowTitle: 'Codex',
            staged: true,
            delivered: true,
            verified: true,
            currentStage: 'verified',
            currentArtifact: 'browser-editor-chat-delivery',
          },
          chainState: {
            currentTarget: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
            lastVerifiedAnchor: 'verified:Codex',
            chainStatus: 'completed',
          },
          verificationEvidence: ['verified:Codex'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_template',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser editor chat template should succeed')
  assert(
    readVerification(result.data)?.passed === true,
    'browser editor chat template should verify success',
  )
  const output = readOutput(result.data) as {
    extractedText?: string
    selectedWindowTitle?: string
    currentArtifact?: string
    verified?: boolean
  }
  assert(
    output.extractedText === 'Need reply in chat' &&
      output.selectedWindowTitle === 'Codex' &&
      output.currentArtifact === 'browser-editor-chat-delivery' &&
      output.verified === true,
    'browser editor chat template should preserve the verified chat delivery output',
  )
  assert(
    readOperations(result.data).includes(
      'skill.browser.editor_chat_stage_and_deliver_verify',
    ),
    'browser editor chat template should call the base verified chat chain',
  )
  assert(
    readEvidence(result.data).includes('template=browser-editor-chat') &&
      readEvidence(result.data).includes('verified:Codex'),
    'browser editor chat template should append template evidence and preserve base evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.currentArtifact === 'browser-editor-chat-delivery' &&
      chainState.chainStatus === 'completed',
    'browser editor chat template should preserve completed chain state',
  )
}

async function verifyBrowserEditorChatTemplateFailsWhenBaseChainFails(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.editor_chat_stage_and_deliver_verify',
      ['editorAppName', 'chatAppName'],
      async input => ({
        ok: false,
        summary: `chat delivery failed for ${String(input.chatAppName)}`,
        error: 'CHAT_TEMPLATE_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: {
            passed: false,
          },
          output: {
            editorTargetWindowTitle: 'Notepad',
            chatTargetWindowTitle: 'Codex',
            selectedWindowTitle: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
          },
          chainState: {
            currentTarget: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
            chainStatus: 'execution_failed',
          },
          recoveryPoint: 'focus:Codex',
          verificationEvidence: ['chatTarget=Codex'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_template',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'browser editor chat template should fail when the base chain fails')
  assert(
    readVerification(result.data)?.passed === false,
    'browser editor chat template failure should fail verification',
  )
  assert(
    readEvidence(result.data).includes('template=browser-editor-chat'),
    'browser editor chat template failure should preserve the template evidence marker',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.currentArtifact === 'browser-editor-chat-delivery' &&
      chainState.chainStatus === 'execution_failed',
    'browser editor chat template failure should preserve execution_failed chain state',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: unknown }).recoveryPoint
  assert(
    recoveryPoint === 'focus:Codex',
    'browser editor chat template failure should preserve the recovery point',
  )
}

async function verifyFileBrowserDesktopTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.file.browser_route_deliver_verify',
      ['path', 'primaryWindowTitle', 'secondaryWindowTitle'],
      async input => ({
        ok: true,
        summary: `verified desktop delivery for ${String(input.path)}`,
        data: {
          verification: {
            passed: true,
          },
          output: {
            sourcePath: String(input.path),
            transformedText: 'ROUTE THIS TO WECHAT',
            browserContextText: 'reply to WeChat customer',
            selectedWindowTitle: 'WeChat',
            routeReason: 'routeQuery=wechat better match',
            delivered: true,
            verified: true,
            currentStage: 'verified',
            currentArtifact: String(input.path),
          },
          chainState: {
            currentTarget: 'WeChat',
            currentArtifact: String(input.path),
            lastVerifiedAnchor: 'verified:WeChat',
            chainStatus: 'completed',
          },
          verificationEvidence: ['routeReason=routeQuery=wechat better match'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_desktop_template',
      input: {
        path: 'followup.txt',
        primaryWindowTitle: 'Codex',
        secondaryWindowTitle: 'WeChat',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file browser desktop template should succeed')
  assert(
    readVerification(result.data)?.passed === true,
    'file browser desktop template should verify success',
  )
  const output = readOutput(result.data) as {
    sourcePath?: string
    transformedText?: string
    selectedWindowTitle?: string
    currentArtifact?: string
  }
  assert(
    output.sourcePath === 'followup.txt' &&
      output.transformedText === 'ROUTE THIS TO WECHAT' &&
      output.selectedWindowTitle === 'WeChat' &&
      output.currentArtifact === 'followup.txt',
    'file browser desktop template should preserve the verified desktop delivery output',
  )
  assert(
    readOperations(result.data).includes('skill.file.browser_route_deliver_verify'),
    'file browser desktop template should call the base verified desktop chain',
  )
  assert(
    readEvidence(result.data).includes('template=file-browser-desktop') &&
      readEvidence(result.data).some(item => item.includes('routeReason=')),
    'file browser desktop template should append template evidence and preserve route evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'WeChat' &&
      chainState.currentArtifact === 'followup.txt' &&
      chainState.chainStatus === 'completed',
    'file browser desktop template should preserve completed chain state',
  )
}

async function verifyFileBrowserDesktopTemplateFailsWhenBaseChainFails(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.file.browser_route_deliver_verify',
      ['path', 'primaryWindowTitle', 'secondaryWindowTitle'],
      async input => ({
        ok: false,
        summary: `desktop delivery failed for ${String(input.path)}`,
        error: 'FILE_DESKTOP_TEMPLATE_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: {
            passed: false,
          },
          output: {
            sourcePath: String(input.path),
            selectedWindowTitle: 'WeChat',
            currentArtifact: String(input.path),
          },
          chainState: {
            currentTarget: 'WeChat',
            currentArtifact: String(input.path),
            chainStatus: 'execution_failed',
          },
          recoveryPoint: 'skill.file.browser_route_deliver_verify',
          verificationEvidence: ['verified:WeChat'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_desktop_template',
      input: {
        path: 'followup.txt',
        primaryWindowTitle: 'Codex',
        secondaryWindowTitle: 'WeChat',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'file browser desktop template should fail when the base chain fails')
  assert(
    readVerification(result.data)?.passed === false,
    'file browser desktop template failure should fail verification',
  )
  assert(
    readEvidence(result.data).includes('template=file-browser-desktop'),
    'file browser desktop template failure should preserve the template evidence marker',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'WeChat' &&
      chainState.currentArtifact === 'followup.txt' &&
      chainState.chainStatus === 'execution_failed',
    'file browser desktop template failure should preserve execution_failed chain state',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: unknown }).recoveryPoint
  assert(
    recoveryPoint === 'skill.file.browser_route_deliver_verify',
    'file browser desktop template failure should preserve the recovery point',
  )
}

async function verifyMultiWindowRouteDeliverTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.multi_window.observe_route_deliver_verify',
      ['primaryWindowTitle', 'secondaryWindowTitle', 'routeQuery', 'targetAppName'],
      async input => ({
        ok: true,
        summary: `verified multi-window delivery for ${String(input.targetAppName)}`,
        data: {
          verification: {
            passed: true,
          },
          output: {
            selectedWindowTitle: 'Notepad',
            routeReason: 'secondary evidence better matched note',
            currentStage: 'verified',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            executed: true,
            verified: true,
          },
          chainState: {
            currentTarget: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            lastVerifiedAnchor: 'verified:Notepad',
            chainStatus: 'completed',
          },
          verificationEvidence: ['routeReason=secondary evidence better matched note'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.observe_route_deliver_template',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
        targetWindowTitle: 'Notepad',
        actionText: 'phase3 template smoke',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'multi-window route deliver template should succeed')
  assert(
    readVerification(result.data)?.passed === true,
    'multi-window route deliver template should verify success',
  )
  const output = readOutput(result.data) as {
    selectedWindowTitle?: string
    routeReason?: string
    currentArtifact?: string
    verified?: boolean
  }
  assert(
    output.selectedWindowTitle === 'Notepad' &&
      output.routeReason === 'secondary evidence better matched note' &&
      output.currentArtifact === 'multi-window-observe-route-deliver-verify' &&
      output.verified === true,
    'multi-window route deliver template should preserve the verified multi-window output',
  )
  assert(
    readOperations(result.data).includes(
      'skill.multi_window.observe_route_deliver_verify',
    ),
    'multi-window route deliver template should call the base verified multi-window chain',
  )
  assert(
    readEvidence(result.data).includes('template=multi-window-route-deliver') &&
      readEvidence(result.data).some(item => item.includes('routeReason=')),
    'multi-window route deliver template should append template evidence and preserve route evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.currentArtifact === 'multi-window-observe-route-deliver-verify' &&
      chainState.chainStatus === 'completed',
    'multi-window route deliver template should preserve completed chain state',
  )
}

async function verifyMultiWindowRouteDeliverTemplateFailsWhenBaseChainFails(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.multi_window.observe_route_deliver_verify',
      ['primaryWindowTitle', 'secondaryWindowTitle', 'routeQuery', 'targetAppName'],
      async input => ({
        ok: false,
        summary: `multi-window delivery failed for ${String(input.targetAppName)}`,
        error: 'MULTI_WINDOW_TEMPLATE_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: {
            passed: false,
          },
          output: {
            selectedWindowTitle: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
          },
          chainState: {
            currentTarget: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            chainStatus: 'execution_failed',
          },
          recoveryPoint: 'focus:Notepad',
          verificationEvidence: ['selectedWindow=Notepad'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.observe_route_deliver_template',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(
    !result.ok,
    'multi-window route deliver template should fail when the base chain fails',
  )
  assert(
    readVerification(result.data)?.passed === false,
    'multi-window route deliver template failure should fail verification',
  )
  assert(
    readEvidence(result.data).includes('template=multi-window-route-deliver'),
    'multi-window route deliver template failure should preserve the template evidence marker',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.currentArtifact === 'multi-window-observe-route-deliver-verify' &&
      chainState.chainStatus === 'execution_failed',
    'multi-window route deliver template failure should preserve execution_failed chain state',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: unknown }).recoveryPoint
  assert(
    recoveryPoint === 'focus:Notepad',
    'multi-window route deliver template failure should preserve the recovery point',
  )
}

function createRuntimeWithCapabilityTools(
  stubs: AnyStubTool[],
): ToolRuntime {
  const registry = new InMemoryToolRegistry()
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }
  for (const stub of stubs) {
    registry.register(stub)
  }

  return runtime
}

type AnyStubTool = ToolDefinition<Record<string, unknown>, unknown>

function createStubTool(
  name: string,
  requiredKeys: string[],
  execute: ToolDefinition<Record<string, unknown>, unknown>['execute'],
): AnyStubTool {
  return {
    name,
    availability: 'core',
    description: `${name} regression stub`,
    searchHints: [name, 'regression', 'stub'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: `${name} input`,
      properties: Object.fromEntries(
        requiredKeys.map(key => [key, { type: 'string' }]),
      ),
      required: requiredKeys,
    },
    execute,
  }
}

function createToolContext() {
  return {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: 'phase3-chain-regression',
    turnId: 'turn-1',
  }
}

function readVerification(data: unknown):
  | {
      passed?: boolean
      strategy?: string
      details?: string
    }
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return (data as { verification?: unknown }).verification as
    | {
        passed?: boolean
        strategy?: string
        details?: string
      }
    | undefined
}

function readOutput(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return (data as { output?: unknown }).output
}

function readChainState(data: unknown):
  | {
      currentTarget?: string
      currentArtifact?: string
      chainStatus?: string
    }
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return (data as { chainState?: unknown }).chainState as
    | {
        currentTarget?: string
        currentArtifact?: string
        chainStatus?: string
      }
    | undefined
}

function readEvidence(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  return Array.isArray(evidence)
    ? evidence.filter((value): value is string => typeof value === 'string')
    : []
}

function readOperations(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const operations = (data as { operations?: unknown }).operations
  return Array.isArray(operations)
    ? operations
        .map(operation =>
          typeof operation === 'object' &&
          operation !== null &&
          typeof (operation as { target?: unknown }).target === 'string'
            ? ((operation as { target?: string }).target as string)
            : undefined,
        )
        .filter((value): value is string => Boolean(value))
    : []
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
