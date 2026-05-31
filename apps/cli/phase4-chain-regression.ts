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
  await verifyBrowserEditorChatReplyTemplate()
  await verifyBrowserEditorChatReplyTemplateFailure()
  await verifyBrowserDocDesktopDeliverTemplate()
  await verifyBrowserDocDesktopDeliverTemplateFailure()
  await verifyFileBrowserFormSubmitTemplate()
  await verifyFileBrowserFormSubmitTemplateFailure()
  await verifyMultiWindowCompareSummarizeDeliverTemplate()
  await verifyMultiWindowCompareSummarizeDeliverTemplateFailure()
  await verifyBrowserExtractTransformPostTemplate()
  await verifyBrowserExtractTransformPostTemplateFailure()
  console.log('Phase 4 chain regression passed: 10/10')
}

async function verifyBrowserEditorChatReplyTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.editor_chat_stage_and_deliver_verify',
      ['editorAppName', 'chatAppName'],
      async input => ({
        ok: true,
        summary: `verified reply delivery for ${String(input.chatAppName)}`,
        data: {
          verification: { passed: true },
          output: {
            extractedText: 'Draft reply from browser',
            editorTargetWindowTitle: 'Notepad',
            chatTargetWindowTitle: 'Codex',
            selectedWindowTitle: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
            verified: true,
          },
          chainState: {
            currentTarget: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
            chainStatus: 'completed',
          },
          verificationEvidence: ['verified:Codex'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_reply_template',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser editor chat reply template should succeed')
  assertOperationPresent(
    result.data,
    'skill.browser.editor_chat_stage_and_deliver_verify',
    'browser editor chat reply template should call the verified browser->editor->chat chain',
  )
  assertEvidencePresent(
    result.data,
    'template=browser-editor-chat-reply',
    'browser editor chat reply template should add the template evidence marker',
  )
  assertChainState(
    result.data,
    'Codex',
    'browser-editor-chat-delivery',
    'completed',
    'browser editor chat reply template should preserve completed chain state',
  )
  assertVerificationPassed(
    result.data,
    true,
    'browser editor chat reply template should report verified success',
  )
  assertRoutingPolicyDefault(
    result.data,
    'browser editor chat reply template should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, undefined, 'browser editor chat reply template should not set recovery point on success')
}

async function verifyBrowserEditorChatReplyTemplateFailure(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.editor_chat_stage_and_deliver_verify',
      ['editorAppName', 'chatAppName'],
      async input => ({
        ok: false,
        summary: `reply delivery failed for ${String(input.chatAppName)}`,
        error: 'PHASE4_REPLY_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: { passed: false },
          output: {
            chatTargetWindowTitle: 'Codex',
            selectedWindowTitle: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
          },
          chainState: {
            currentTarget: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
            chainStatus: 'execution_failed',
          },
          failureReason: 'execution_failed',
          recoveryAction: 'recover:restage',
          recoveryPoint: 'focus:Codex',
          verificationEvidence: ['verified:Codex'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_reply_template',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'browser editor chat reply template should fail when the base chain fails')
  assertOperationPresent(
    result.data,
    'skill.browser.editor_chat_stage_and_deliver_verify',
    'browser editor chat reply template failure should still show the nested chain',
  )
  assertEvidencePresent(
    result.data,
    'template=browser-editor-chat-reply',
    'browser editor chat reply template failure should preserve the template evidence marker',
  )
  assertChainState(
    result.data,
    'Codex',
    'browser-editor-chat-delivery',
    'execution_failed',
    'browser editor chat reply template failure should preserve execution_failed chain state',
  )
  assertVerificationPassed(
    result.data,
    false,
    'browser editor chat reply template failure should report verification failure',
  )
  assertFailureReason(
    result.data,
    'execution_failed',
    'browser editor chat reply template failure should preserve failureReason',
  )
  assertRecoveryAction(
    result.data,
    'recover:restage',
    'browser editor chat reply template failure should preserve recoveryAction',
  )
  assertRoutingPolicyDefault(
    result.data,
    'browser editor chat reply template failure should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, 'focus:Codex', 'browser editor chat reply template failure should preserve recovery point')
}

async function verifyBrowserDocDesktopDeliverTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.editor_stage_and_deliver',
      ['editorAppName', 'finalAppName'],
      async input => ({
        ok: true,
        summary: `verified desktop document delivery for ${String(input.finalAppName)}`,
        data: {
          verification: { passed: true },
          output: {
            extractedText: 'Browser-derived document',
            editorTargetWindowTitle: 'Notepad',
            finalTargetWindowTitle: 'WeChat',
            selectedWindowTitle: 'WeChat',
            currentArtifact: 'browser-editor-final-delivery',
            delivered: true,
          },
          chainState: {
            currentTarget: 'WeChat',
            currentArtifact: 'browser-editor-final-delivery',
            chainStatus: 'completed',
          },
          verificationEvidence: ['finalTarget=WeChat'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.doc_desktop_deliver_template',
      input: {
        editorAppName: 'Notepad',
        finalAppName: 'WeChat',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser doc desktop deliver template should succeed')
  assertOperationPresent(
    result.data,
    'skill.browser.editor_stage_and_deliver',
    'browser doc desktop deliver template should call the browser->editor->desktop chain',
  )
  assertEvidencePresent(
    result.data,
    'template=browser-doc-desktop-deliver',
    'browser doc desktop deliver template should add the template evidence marker',
  )
  assertChainState(
    result.data,
    'WeChat',
    'browser-editor-final-delivery',
    'completed',
    'browser doc desktop deliver template should preserve completed chain state',
  )
  assertVerificationPassed(
    result.data,
    true,
    'browser doc desktop deliver template should report verified success',
  )
  assertRoutingPolicyDefault(
    result.data,
    'browser doc desktop deliver template should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, undefined, 'browser doc desktop deliver template should not set recovery point on success')
}

async function verifyBrowserDocDesktopDeliverTemplateFailure(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.editor_stage_and_deliver',
      ['editorAppName', 'finalAppName'],
      async input => ({
        ok: false,
        summary: `desktop document delivery failed for ${String(input.finalAppName)}`,
        error: 'PHASE4_DOC_DELIVER_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: { passed: false },
          output: {
            finalTargetWindowTitle: 'WeChat',
            selectedWindowTitle: 'WeChat',
            currentArtifact: 'browser-editor-final-delivery',
          },
          chainState: {
            currentTarget: 'WeChat',
            currentArtifact: 'browser-editor-final-delivery',
            chainStatus: 'execution_failed',
          },
          failureReason: 'execution_failed',
          recoveryAction: 'recover:restage',
          recoveryPoint: 'focus:WeChat',
          verificationEvidence: ['finalTarget=WeChat'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.doc_desktop_deliver_template',
      input: {
        editorAppName: 'Notepad',
        finalAppName: 'WeChat',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'browser doc desktop deliver template should fail when the base chain fails')
  assertOperationPresent(
    result.data,
    'skill.browser.editor_stage_and_deliver',
    'browser doc desktop deliver template failure should still show the nested chain',
  )
  assertEvidencePresent(
    result.data,
    'template=browser-doc-desktop-deliver',
    'browser doc desktop deliver template failure should preserve the template evidence marker',
  )
  assertChainState(
    result.data,
    'WeChat',
    'browser-editor-final-delivery',
    'execution_failed',
    'browser doc desktop deliver template failure should preserve execution_failed chain state',
  )
  assertVerificationPassed(
    result.data,
    false,
    'browser doc desktop deliver template failure should report verification failure',
  )
  assertFailureReason(
    result.data,
    'execution_failed',
    'browser doc desktop deliver template failure should preserve failureReason',
  )
  assertRecoveryAction(
    result.data,
    'recover:restage',
    'browser doc desktop deliver template failure should preserve recoveryAction',
  )
  assertRoutingPolicyDefault(
    result.data,
    'browser doc desktop deliver template failure should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, 'focus:WeChat', 'browser doc desktop deliver template failure should preserve recovery point')
}

async function verifyFileBrowserFormSubmitTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.file_read_transform_transfer',
      ['path', 'targetWindowTitle'],
      async input => ({
        ok: true,
        summary: `verified browser form submit for ${String(input.path)}`,
        data: {
          verification: { passed: true },
          output: {
            sourcePath: String(input.path),
            transformedText: 'FORM BODY',
            targetWindowTitle: 'Microsoft Edge',
            transferred: true,
          },
          chainState: {
            currentTarget: 'Microsoft Edge',
            currentArtifact: String(input.path),
            chainStatus: 'completed',
          },
          verificationEvidence: ['transform=uppercase'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_form_submit_template',
      input: {
        path: 'draft.txt',
        browserWindowTitle: 'Microsoft Edge',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file browser form submit template should succeed')
  assertOperationPresent(
    result.data,
    'skill.file_read_transform_transfer',
    'file browser form submit template should call the file read/transform/transfer chain',
  )
  assertEvidencePresent(
    result.data,
    'template=file-browser-form-submit',
    'file browser form submit template should add the template evidence marker',
  )
  assertChainState(
    result.data,
    'Microsoft Edge',
    'draft.txt',
    'completed',
    'file browser form submit template should preserve completed chain state',
  )
  assertVerificationPassed(
    result.data,
    true,
    'file browser form submit template should report verified success',
  )
  assertRoutingPolicyDefault(
    result.data,
    'file browser form submit template should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, undefined, 'file browser form submit template should not set recovery point on success')
}

async function verifyFileBrowserFormSubmitTemplateFailure(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.file_read_transform_transfer',
      ['path', 'targetWindowTitle'],
      async input => ({
        ok: false,
        summary: `browser form submit failed for ${String(input.path)}`,
        error: 'PHASE4_FORM_SUBMIT_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: { passed: false },
          output: {
            sourcePath: String(input.path),
            targetWindowTitle: 'Microsoft Edge',
          },
          chainState: {
            currentTarget: 'Microsoft Edge',
            currentArtifact: String(input.path),
            chainStatus: 'execution_failed',
          },
          failureReason: 'execution_failed',
          recoveryAction: 'recover:restage',
          recoveryPoint: 'focus:Microsoft Edge',
          verificationEvidence: ['transform=uppercase'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_form_submit_template',
      input: {
        path: 'draft.txt',
        browserWindowTitle: 'Microsoft Edge',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'file browser form submit template should fail when the base chain fails')
  assertOperationPresent(
    result.data,
    'skill.file_read_transform_transfer',
    'file browser form submit template failure should still show the nested chain',
  )
  assertEvidencePresent(
    result.data,
    'template=file-browser-form-submit',
    'file browser form submit template failure should preserve the template evidence marker',
  )
  assertChainState(
    result.data,
    'Microsoft Edge',
    'draft.txt',
    'execution_failed',
    'file browser form submit template failure should preserve execution_failed chain state',
  )
  assertVerificationPassed(
    result.data,
    false,
    'file browser form submit template failure should report verification failure',
  )
  assertFailureReason(
    result.data,
    'execution_failed',
    'file browser form submit template failure should preserve failureReason',
  )
  assertRecoveryAction(
    result.data,
    'recover:restage',
    'file browser form submit template failure should preserve recoveryAction',
  )
  assertRoutingPolicyDefault(
    result.data,
    'file browser form submit template failure should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, 'focus:Microsoft Edge', 'file browser form submit template failure should preserve recovery point')
}

async function verifyMultiWindowCompareSummarizeDeliverTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.multi_window.observe_route_deliver_verify',
      ['primaryWindowTitle', 'secondaryWindowTitle', 'routeQuery', 'targetAppName'],
      async input => ({
        ok: true,
        summary: `verified compare summarize deliver for ${String(input.targetAppName)}`,
        data: {
          verification: { passed: true },
          output: {
            selectedWindowTitle: 'Notepad',
            routeReason: 'secondary evidence better matched note',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            verified: true,
          },
          chainState: {
            currentTarget: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            chainStatus: 'completed',
          },
          verificationEvidence: ['routeReason=secondary evidence better matched note'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.compare_summarize_deliver_template',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'multi window compare summarize deliver template should succeed')
  assertOperationPresent(
    result.data,
    'skill.multi_window.observe_route_deliver_verify',
    'multi window compare summarize deliver template should call the verified multi-window chain',
  )
  assertEvidencePresent(
    result.data,
    'template=multi-window-compare-summarize-deliver',
    'multi window compare summarize deliver template should add the template evidence marker',
  )
  assertChainState(
    result.data,
    'Notepad',
    'multi-window-observe-route-deliver-verify',
    'completed',
    'multi window compare summarize deliver template should preserve completed chain state',
  )
  assertVerificationPassed(
    result.data,
    true,
    'multi window compare summarize deliver template should report verified success',
  )
  assertRoutingPolicyDefault(
    result.data,
    'multi window compare summarize deliver template should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, undefined, 'multi window compare summarize deliver template should not set recovery point on success')
}

async function verifyMultiWindowCompareSummarizeDeliverTemplateFailure(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.multi_window.observe_route_deliver_verify',
      ['primaryWindowTitle', 'secondaryWindowTitle', 'routeQuery', 'targetAppName'],
      async input => ({
        ok: false,
        summary: `compare summarize deliver failed for ${String(input.targetAppName)}`,
        error: 'PHASE4_MULTI_WINDOW_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: { passed: false },
          output: {
            selectedWindowTitle: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
          },
          chainState: {
            currentTarget: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            chainStatus: 'execution_failed',
          },
          failureReason: 'execution_failed',
          recoveryAction: 'recover:restage',
          recoveryPoint: 'focus:Notepad',
          verificationEvidence: ['routeReason=secondary evidence better matched note'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.compare_summarize_deliver_template',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'multi window compare summarize deliver template should fail when the base chain fails')
  assertOperationPresent(
    result.data,
    'skill.multi_window.observe_route_deliver_verify',
    'multi window compare summarize deliver template failure should still show the nested chain',
  )
  assertEvidencePresent(
    result.data,
    'template=multi-window-compare-summarize-deliver',
    'multi window compare summarize deliver template failure should preserve the template evidence marker',
  )
  assertChainState(
    result.data,
    'Notepad',
    'multi-window-observe-route-deliver-verify',
    'execution_failed',
    'multi window compare summarize deliver template failure should preserve execution_failed chain state',
  )
  assertVerificationPassed(
    result.data,
    false,
    'multi window compare summarize deliver template failure should report verification failure',
  )
  assertFailureReason(
    result.data,
    'execution_failed',
    'multi window compare summarize deliver template failure should preserve failureReason',
  )
  assertRecoveryAction(
    result.data,
    'recover:restage',
    'multi window compare summarize deliver template failure should preserve recoveryAction',
  )
  assertRoutingPolicyDefault(
    result.data,
    'multi window compare summarize deliver template failure should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, 'focus:Notepad', 'multi window compare summarize deliver template failure should preserve recovery point')
}

async function verifyBrowserExtractTransformPostTemplate(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.extract_then_transfer',
      ['targetWindowTitle'],
      async input => ({
        ok: true,
        summary: `verified extract/post for ${String(input.targetWindowTitle)}`,
        data: {
          verification: { passed: true },
          output: {
            extractedText: 'Post body from browser',
            targetWindowTitle: 'Notepad',
            transferred: true,
          },
          chainState: {
            currentTarget: 'Notepad',
            currentArtifact: 'browser-dom-extract',
            chainStatus: 'completed',
          },
          verificationEvidence: ['mode=dom'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.extract_transform_post_template',
      input: {
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser extract transform post template should succeed')
  assertOperationPresent(
    result.data,
    'skill.browser.extract_then_transfer',
    'browser extract transform post template should call the browser extract chain',
  )
  assertEvidencePresent(
    result.data,
    'template=browser-extract-transform-post',
    'browser extract transform post template should add the template evidence marker',
  )
  assertChainState(
    result.data,
    'Notepad',
    'browser-dom-extract',
    'completed',
    'browser extract transform post template should preserve completed chain state',
  )
  assertVerificationPassed(
    result.data,
    true,
    'browser extract transform post template should report verified success',
  )
  assertRoutingPolicyDefault(
    result.data,
    'browser extract transform post template should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, undefined, 'browser extract transform post template should not set recovery point on success')
}

async function verifyBrowserExtractTransformPostTemplateFailure(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(
      'skill.browser.extract_then_transfer',
      ['targetWindowTitle'],
      async input => ({
        ok: false,
        summary: `extract/post failed for ${String(input.targetWindowTitle)}`,
        error: 'PHASE4_EXTRACT_POST_FAILED',
        failureClass: 'deterministic',
        data: {
          verification: { passed: false },
          output: {
            targetWindowTitle: 'Notepad',
          },
          chainState: {
            currentTarget: 'browser',
            currentArtifact: 'browser-dom-extract',
            chainStatus: 'verified_failed',
          },
          observation: {
            confidence: 0.42,
            sufficient: false,
            mode: 'dom',
            domAnchor: 'article',
            textAnchor: 'Need reply',
          },
          failureReason: 'observation_insufficient',
          recoveryAction: 'recover:reobserve',
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: ['mode=dom'],
        },
      }),
    ),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.extract_transform_post_template',
      input: {
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'browser extract transform post template should fail when the base chain fails')
  assertOperationPresent(
    result.data,
    'skill.browser.extract_then_transfer',
    'browser extract transform post template failure should still show the nested chain',
  )
  assertEvidencePresent(
    result.data,
    'template=browser-extract-transform-post',
    'browser extract transform post template failure should preserve the template evidence marker',
  )
  assertChainState(
    result.data,
    'browser',
    'browser-dom-extract',
    'verified_failed',
    'browser extract transform post template failure should preserve propagated verified_failed chain state',
  )
  assertVerificationPassed(
    result.data,
    false,
    'browser extract transform post template failure should report verification failure',
  )
  assertFailureReason(
    result.data,
    'observation_insufficient',
    'browser extract transform post template failure should preserve observation failureReason',
  )
  assertRecoveryAction(
    result.data,
    'recover:reobserve',
    'browser extract transform post template failure should preserve recoveryAction',
  )
  assertObservation(
    result.data,
    {
      sufficient: false,
      mode: 'dom',
    },
    'browser extract transform post template failure should preserve observation contract',
  )
  assertRoutingPolicyDefault(
    result.data,
    'browser extract transform post template failure should expose the frozen routing policy',
  )
  assertRecoveryPoint(result.data, 'command.browser.inspect_dom', 'browser extract transform post template failure should preserve recovery point')
}

function createRuntimeWithCapabilityTools(stubs: AnyStubTool[]): ToolRuntime {
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
    searchHints: [name, 'regression', 'phase4', 'stub'],
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
    sessionId: 'phase4-chain-regression',
    turnId: 'turn-1',
  }
}

function assertOperationPresent(
  data: unknown,
  target: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const operations = (data as { operations?: unknown }).operations
  if (!Array.isArray(operations)) {
    throw new Error(errorMessage)
  }

  const found = operations.some(
    operation =>
      typeof operation === 'object' &&
      operation !== null &&
      (operation as { target?: unknown }).target === target,
  )
  if (!found) {
    throw new Error(errorMessage)
  }
}

function assertEvidencePresent(
  data: unknown,
  marker: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  if (!Array.isArray(evidence)) {
    throw new Error(errorMessage)
  }

  const found = evidence.some(
    item => typeof item === 'string' && item.includes(marker),
  )
  if (!found) {
    throw new Error(errorMessage)
  }
}

function assertChainState(
  data: unknown,
  expectedTarget: string,
  expectedArtifact: string,
  expectedStatus: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const chainState = (data as { chainState?: unknown }).chainState
  if (typeof chainState !== 'object' || chainState === null) {
    throw new Error(errorMessage)
  }

  if (
    (chainState as { currentTarget?: unknown }).currentTarget !== expectedTarget ||
    (chainState as { currentArtifact?: unknown }).currentArtifact !== expectedArtifact ||
    (chainState as { chainStatus?: unknown }).chainStatus !== expectedStatus
  ) {
    throw new Error(errorMessage)
  }
}

function assertRecoveryPoint(
  data: unknown,
  expectedRecoveryPoint: string | undefined,
  errorMessage: string,
): void {
  if (expectedRecoveryPoint === undefined) {
    if (typeof data === 'object' && data !== null && 'recoveryPoint' in data) {
      const value = (data as { recoveryPoint?: unknown }).recoveryPoint
      if (value !== undefined) {
        throw new Error(errorMessage)
      }
    }
    return
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  if ((data as { recoveryPoint?: unknown }).recoveryPoint !== expectedRecoveryPoint) {
    throw new Error(errorMessage)
  }
}

function assertVerificationPassed(
  data: unknown,
  expected: boolean,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    throw new Error(errorMessage)
  }

  if ((verification as { passed?: unknown }).passed !== expected) {
    throw new Error(errorMessage)
  }
}

function assertFailureReason(
  data: unknown,
  expected: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  if ((data as { failureReason?: unknown }).failureReason !== expected) {
    throw new Error(errorMessage)
  }
}

function assertRecoveryAction(
  data: unknown,
  expected: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  if ((data as { recoveryAction?: unknown }).recoveryAction !== expected) {
    throw new Error(errorMessage)
  }
}

function assertRoutingPolicyDefault(
  data: unknown,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const routingPolicy = (data as { routingPolicy?: unknown }).routingPolicy
  if (
    !Array.isArray(routingPolicy) ||
    routingPolicy.join('|') !==
      [
        'backend-first',
        'browser-dom-first',
        'desktop-observe-fallback',
        'gui-last',
      ].join('|')
  ) {
    throw new Error(errorMessage)
  }
}

function assertObservation(
  data: unknown,
  expected: {
    sufficient?: boolean
    mode?: string
  },
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const observation = (data as { observation?: unknown }).observation
  if (typeof observation !== 'object' || observation === null) {
    throw new Error(errorMessage)
  }

  if (
    ('sufficient' in expected &&
      (observation as { sufficient?: unknown }).sufficient !== expected.sufficient) ||
    ('mode' in expected &&
      (observation as { mode?: unknown }).mode !== expected.mode)
  ) {
    throw new Error(errorMessage)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
