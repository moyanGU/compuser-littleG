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

type TemplateScenario = {
  label: string
  nestedTool: string
  toolName: string
  input: Record<string, unknown>
  expectedTarget: string
  expectedArtifact: string
  expectedMarker: string
  successSummary: string
  successOutput: Record<string, unknown>
  successEvidence: string[]
  successVerificationDetails: string
  failureSummary: string
  failureError: string
  failureOutput: Record<string, unknown>
  failureEvidence: string[]
  failureStatus: string
  failureReason: string
  failureRecoveryAction: string
  failureRecoveryPoint: string
  failureVerificationDetails: string
}

async function main(): Promise<void> {
  for (const scenario of createScenarios()) {
    await verifyScenarioSuccess(scenario)
    await verifyScenarioFailure(scenario)
  }

  console.log('Phase 5 chain regression passed: 10/10')
}

function createScenarios(): TemplateScenario[] {
  return [
    {
      label: 'browser editor chat reply template',
      nestedTool: 'skill.browser.editor_chat_stage_and_deliver_verify',
      toolName: 'skill.browser.editor_chat_reply_template',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
      expectedTarget: 'Codex',
      expectedArtifact: 'browser-editor-chat-delivery',
      expectedMarker: 'template=browser-editor-chat-reply',
      successSummary: 'verified reply delivery for Codex',
      successOutput: {
        extractedText: 'Draft reply from browser',
        editorTargetWindowTitle: 'Notepad',
        chatTargetWindowTitle: 'Codex',
        selectedWindowTitle: 'Codex',
        currentTarget: 'Codex',
        currentArtifact: 'browser-editor-chat-delivery',
        status: 'completed',
        verified: true,
      },
      successEvidence: ['verified:Codex'],
      successVerificationDetails:
        'Reply template completed by reusing the verified browser -> editor -> chat delivery chain.',
      failureSummary: 'reply delivery failed for Codex',
      failureError: 'PHASE5_REPLY_FAILED',
      failureOutput: {
        chatTargetWindowTitle: 'Codex',
        selectedWindowTitle: 'Codex',
        currentTarget: 'Codex',
        currentArtifact: 'browser-editor-chat-delivery',
        status: 'execution_failed',
      },
      failureEvidence: ['verified:Codex'],
      failureStatus: 'execution_failed',
      failureReason: 'execution_failed',
      failureRecoveryAction: 'recover:restage',
      failureRecoveryPoint: 'focus:Codex',
      failureVerificationDetails:
        'Base browser -> editor -> chat verified chain failed before the reply template could complete.',
    },
    {
      label: 'browser doc desktop deliver template',
      nestedTool: 'skill.browser.editor_stage_and_deliver',
      toolName: 'skill.browser.doc_desktop_deliver_template',
      input: {
        editorAppName: 'Notepad',
        finalAppName: 'WeChat',
      },
      expectedTarget: 'WeChat',
      expectedArtifact: 'browser-editor-final-delivery',
      expectedMarker: 'template=browser-doc-desktop-deliver',
      successSummary: 'verified desktop document delivery for WeChat',
      successOutput: {
        extractedText: 'Browser-derived document',
        editorTargetWindowTitle: 'Notepad',
        finalTargetWindowTitle: 'WeChat',
        selectedWindowTitle: 'WeChat',
        currentTarget: 'WeChat',
        currentArtifact: 'browser-editor-final-delivery',
        status: 'completed',
        delivered: true,
      },
      successEvidence: ['finalTarget=WeChat'],
      successVerificationDetails:
        'Document delivery template completed by reusing the verified browser -> editor -> desktop chain.',
      failureSummary: 'desktop document delivery failed for WeChat',
      failureError: 'PHASE5_DOC_DELIVER_FAILED',
      failureOutput: {
        finalTargetWindowTitle: 'WeChat',
        selectedWindowTitle: 'WeChat',
        currentTarget: 'WeChat',
        currentArtifact: 'browser-editor-final-delivery',
        status: 'execution_failed',
      },
      failureEvidence: ['finalTarget=WeChat'],
      failureStatus: 'execution_failed',
      failureReason: 'execution_failed',
      failureRecoveryAction: 'recover:restage',
      failureRecoveryPoint: 'focus:WeChat',
      failureVerificationDetails:
        'Base browser -> editor -> desktop chain failed before the document delivery template could complete.',
    },
    {
      label: 'file browser form submit template',
      nestedTool: 'skill.file_read_transform_transfer',
      toolName: 'skill.file.browser_form_submit_template',
      input: {
        path: 'draft.txt',
        browserWindowTitle: 'Microsoft Edge',
      },
      expectedTarget: 'Microsoft Edge',
      expectedArtifact: 'draft.txt',
      expectedMarker: 'template=file-browser-form-submit',
      successSummary: 'verified browser form submit for draft.txt',
      successOutput: {
        sourcePath: 'draft.txt',
        transformedText: 'FORM BODY',
        targetWindowTitle: 'Microsoft Edge',
        selectedWindowTitle: 'Microsoft Edge',
        currentTarget: 'Microsoft Edge',
        currentArtifact: 'draft.txt',
        status: 'completed',
        transferred: true,
      },
      successEvidence: ['transform=uppercase'],
      successVerificationDetails:
        'Browser form submit template completed by reusing the read/transform/transfer chain against the browser target.',
      failureSummary: 'browser form submit failed for draft.txt',
      failureError: 'PHASE5_FORM_SUBMIT_FAILED',
      failureOutput: {
        sourcePath: 'draft.txt',
        targetWindowTitle: 'Microsoft Edge',
        selectedWindowTitle: 'Microsoft Edge',
        currentTarget: 'Microsoft Edge',
        currentArtifact: 'draft.txt',
        status: 'execution_failed',
      },
      failureEvidence: ['transform=uppercase'],
      failureStatus: 'execution_failed',
      failureReason: 'execution_failed',
      failureRecoveryAction: 'recover:restage',
      failureRecoveryPoint: 'focus:Microsoft Edge',
      failureVerificationDetails:
        'Base file read/transform/transfer chain failed before the browser form submit template could complete.',
    },
    {
      label: 'multi window compare summarize deliver template',
      nestedTool: 'skill.multi_window.observe_route_deliver_verify',
      toolName: 'skill.multi_window.compare_summarize_deliver_template',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
      },
      expectedTarget: 'Notepad',
      expectedArtifact: 'multi-window-observe-route-deliver-verify',
      expectedMarker: 'template=multi-window-compare-summarize-deliver',
      successSummary: 'verified compare summarize deliver for Notepad',
      successOutput: {
        selectedWindowTitle: 'Notepad',
        routeReason: 'secondary evidence better matched note',
        currentTarget: 'Notepad',
        currentArtifact: 'multi-window-observe-route-deliver-verify',
        status: 'completed',
        verified: true,
      },
      successEvidence: ['routeReason=secondary evidence better matched note'],
      successVerificationDetails:
        'Compare/summarize/deliver template completed by reusing the verified multi-window observe -> route -> deliver chain.',
      failureSummary: 'compare summarize deliver failed for Notepad',
      failureError: 'PHASE5_MULTI_WINDOW_FAILED',
      failureOutput: {
        selectedWindowTitle: 'Notepad',
        currentTarget: 'Notepad',
        currentArtifact: 'multi-window-observe-route-deliver-verify',
        status: 'execution_failed',
      },
      failureEvidence: ['routeReason=secondary evidence better matched note'],
      failureStatus: 'execution_failed',
      failureReason: 'execution_failed',
      failureRecoveryAction: 'recover:restage',
      failureRecoveryPoint: 'focus:Notepad',
      failureVerificationDetails:
        'Base multi-window observe -> route -> deliver chain failed before the compare/summarize/deliver template could complete.',
    },
    {
      label: 'browser extract transform post template',
      nestedTool: 'skill.browser.extract_then_transfer',
      toolName: 'skill.browser.extract_transform_post_template',
      input: {
        targetWindowTitle: 'Notepad',
      },
      expectedTarget: 'Notepad',
      expectedArtifact: 'browser-dom-extract',
      expectedMarker: 'template=browser-extract-transform-post',
      successSummary: 'verified extract/post for Notepad',
      successOutput: {
        extractedText: 'Post body from browser',
        targetWindowTitle: 'Notepad',
        selectedWindowTitle: 'Notepad',
        currentTarget: 'Notepad',
        currentArtifact: 'browser-dom-extract',
        status: 'completed',
        transferred: true,
      },
      successEvidence: ['mode=dom'],
      successVerificationDetails:
        'Extract/post template completed by reusing the browser extract -> transfer chain as the minimal verified Phase 4 path.',
      failureSummary: 'extract/post failed for Notepad',
      failureError: 'PHASE5_EXTRACT_POST_FAILED',
      failureOutput: {
        targetWindowTitle: 'Notepad',
        selectedWindowTitle: 'Notepad',
        currentTarget: 'Notepad',
        currentArtifact: 'browser-dom-extract',
        status: 'environment_unready',
      },
      failureEvidence: ['mode=dom'],
      failureStatus: 'environment_unready',
      failureReason: 'observation_insufficient',
      failureRecoveryAction: 'recover:reobserve',
      failureRecoveryPoint: 'command.browser.inspect_dom',
      failureVerificationDetails:
        'Base browser extract -> transfer chain failed before the extract/post template could complete.',
    },
  ]
}

async function verifyScenarioSuccess(scenario: TemplateScenario): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(scenario, true),
  ])

  const result = await runtime.execute(
    {
      toolName: scenario.toolName,
      input: scenario.input,
    },
    createToolContext(),
  )

  assert(result.ok, `${scenario.label} should succeed`)
  assertOperationPresent(result.data, scenario.nestedTool, `${scenario.label} should call the nested chain`)
  assertEvidencePresent(result.data, scenario.expectedMarker, `${scenario.label} should add the template evidence marker`)
  assertEvidenceMarkers(result.data, scenario.successEvidence, `${scenario.label} should preserve nested verification evidence`)
  assertVerification(result.data, true, scenario.successVerificationDetails, `${scenario.label} should report verified success`)
  assertChainState(result.data, scenario.expectedTarget, scenario.expectedArtifact, 'completed', `${scenario.label} should preserve completed chain state`)
  assertOutputContract(result.data, scenario.successOutput, `${scenario.label} should preserve the strict success output contract`)
  assertUnifiedStatusFields(result.data, 'completed', `${scenario.label} should expose unified completed status fields`)
  assertRoutingPolicyDefault(result.data, `${scenario.label} should expose the frozen routing policy`)
  assertRecoveryPoint(result.data, undefined, `${scenario.label} should not set recovery point on success`)
}

async function verifyScenarioFailure(scenario: TemplateScenario): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool(scenario, false),
  ])

  const result = await runtime.execute(
    {
      toolName: scenario.toolName,
      input: scenario.input,
    },
    createToolContext(),
  )

  assert(!result.ok, `${scenario.label} should fail when the base chain fails`)
  assertOperationPresent(result.data, scenario.nestedTool, `${scenario.label} failure should still show the nested chain`)
  assertEvidencePresent(result.data, scenario.expectedMarker, `${scenario.label} failure should preserve the template evidence marker`)
  assertEvidenceMarkers(result.data, scenario.failureEvidence, `${scenario.label} failure should preserve nested verification evidence`)
  assertVerification(result.data, false, scenario.failureVerificationDetails, `${scenario.label} failure should report verification failure`)
  assertOutputContract(result.data, scenario.failureOutput, `${scenario.label} failure should preserve the strict failure output contract`)
  assertChainStateMatchesOutput(result.data, `${scenario.label} failure should preserve propagated chain state`)
  assertUnifiedStatusFields(result.data, scenario.failureStatus, `${scenario.label} failure should expose unified failure status fields`)
  assertFailureReason(result.data, scenario.failureReason, `${scenario.label} failure should preserve failureReason`)
  assertRecoveryAction(result.data, scenario.failureRecoveryAction, `${scenario.label} failure should preserve recoveryAction`)
  assertRoutingPolicyDefault(result.data, `${scenario.label} failure should expose the frozen routing policy`)
  assertRecoveryPoint(result.data, scenario.failureRecoveryPoint, `${scenario.label} failure should preserve recovery point`)
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
  scenario: TemplateScenario,
  succeed: boolean,
): AnyStubTool {
  return {
    name: scenario.nestedTool,
    availability: 'core',
    description: `${scenario.nestedTool} regression stub`,
    searchHints: [scenario.nestedTool, 'regression', 'phase5', 'stub'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: `${scenario.nestedTool} input`,
      properties: Object.fromEntries(
        Object.keys(scenario.input).map(key => [key, { type: 'string' }]),
      ),
      required: Object.keys(scenario.input),
    },
    async execute() {
      if (succeed) {
        return {
          ok: true,
          summary: scenario.successSummary,
          data: {
            verification: {
              passed: true,
              details: scenario.successVerificationDetails,
            },
            output: scenario.successOutput,
            chainState: {
              currentTarget: scenario.expectedTarget,
              currentArtifact: scenario.expectedArtifact,
              chainStatus: 'completed',
            },
            verificationEvidence: scenario.successEvidence,
          },
        }
      }

      const data: Record<string, unknown> = {
        verification: {
          passed: false,
          details: scenario.failureVerificationDetails,
        },
        output: scenario.failureOutput,
        chainState: {
          currentTarget: scenario.failureOutput.currentTarget,
          currentArtifact: scenario.expectedArtifact,
          chainStatus: scenario.failureStatus,
        },
        failureReason: scenario.failureReason,
        recoveryAction: scenario.failureRecoveryAction,
        recoveryPoint: scenario.failureRecoveryPoint,
        verificationEvidence: scenario.failureEvidence,
      }

      if (scenario.failureReason === 'observation_insufficient') {
        data.observation = {
          confidence: 0.42,
          sufficient: false,
          mode: 'dom',
          domAnchor: 'article',
          textAnchor: 'Need reply',
        }
      }

      return {
        ok: false,
        summary: scenario.failureSummary,
        error: scenario.failureError,
        failureClass: 'deterministic',
        data,
      }
    },
  }
}

function createToolContext() {
  return {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: 'phase5-chain-regression',
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
  const evidence = readEvidence(data)
  if (!evidence.some(item => item.includes(marker))) {
    throw new Error(errorMessage)
  }
}

function assertEvidenceMarkers(
  data: unknown,
  markers: string[],
  errorMessage: string,
): void {
  const evidence = readEvidence(data)
  for (const marker of markers) {
    if (!evidence.some(item => item.includes(marker))) {
      throw new Error(errorMessage)
    }
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

function assertOutputContract(
  data: unknown,
  expectedOutput: Record<string, unknown>,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) {
    throw new Error(errorMessage)
  }

  for (const [key, value] of Object.entries(expectedOutput)) {
    if ((output as Record<string, unknown>)[key] !== value) {
      throw new Error(errorMessage)
    }
  }
}

function assertUnifiedStatusFields(
  data: unknown,
  expectedStatus: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  const chainState = (data as { chainState?: unknown }).chainState
  if (
    typeof output !== 'object' ||
    output === null ||
    typeof chainState !== 'object' ||
    chainState === null
  ) {
    throw new Error(errorMessage)
  }

  if (
    (output as { status?: unknown }).status !== expectedStatus ||
    (chainState as { chainStatus?: unknown }).chainStatus !== expectedStatus
  ) {
    throw new Error(errorMessage)
  }
}

function assertChainStateMatchesOutput(
  data: unknown,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  const chainState = (data as { chainState?: unknown }).chainState
  if (
    typeof output !== 'object' ||
    output === null ||
    typeof chainState !== 'object' ||
    chainState === null
  ) {
    throw new Error(errorMessage)
  }

  if (
    (chainState as { currentTarget?: unknown }).currentTarget !==
      (output as { currentTarget?: unknown }).currentTarget ||
    (chainState as { currentArtifact?: unknown }).currentArtifact !==
      (output as { currentArtifact?: unknown }).currentArtifact ||
    (chainState as { chainStatus?: unknown }).chainStatus !==
      (output as { status?: unknown }).status
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

function assertVerification(
  data: unknown,
  expected: boolean,
  expectedDetails: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    throw new Error(errorMessage)
  }

  if (
    (verification as { passed?: unknown }).passed !== expected ||
    (verification as { details?: unknown }).details !== expectedDetails
  ) {
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

function readEvidence(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  return Array.isArray(evidence)
    ? evidence.filter((value): value is string => typeof value === 'string')
    : []
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
