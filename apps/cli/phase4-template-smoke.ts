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

type ScenarioStatus =
  | 'pass'
  | 'skip'
  | 'verification_failed'
  | 'environment_unready'
  | 'transport_error'
  | 'provider_error'
  | 'routing_failed'
  | 'execution_failed'
  | 'permission_blocked'

type ScenarioRecord = {
  scenario: string
  status: ScenarioStatus
  detail: string
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const totals = {
    total_runs: 0,
    pass: 0,
    skip: 0,
    verification_failed: 0,
    environment_unready: 0,
    transport_error: 0,
    provider_error: 0,
    routing_failed: 0,
    execution_failed: 0,
    permission_blocked: 0,
  }

  for (let run = 1; run <= options.runs; run += 1) {
    const results = await runTemplateSmokeIteration(run)
    for (const result of results) {
      totals.total_runs += 1
      totals[result.status] += 1
      console.log(
        `[${result.status}] phase4-template-smoke run=${run} scenario=${result.scenario} ${result.detail}`,
      )
    }
  }

  console.log(
    `phase4-template-smoke summary total_runs=${totals.total_runs} pass=${totals.pass} skip=${totals.skip} verification_failed=${totals.verification_failed} environment_unready=${totals.environment_unready} transport_error=${totals.transport_error} provider_error=${totals.provider_error} routing_failed=${totals.routing_failed} execution_failed=${totals.execution_failed} permission_blocked=${totals.permission_blocked}`,
  )
}

function parseArgs(argv: string[]): { runs: number } {
  const rawRuns =
    argv.find((value, index) => argv[index - 1] === '--runs') ??
    process.env.COMPUSER_TEMPLATE_SMOKE_RUNS ??
    '3'
  const parsedRuns = Number.parseInt(rawRuns, 10)
  return {
    runs: Number.isFinite(parsedRuns) && parsedRuns > 0 ? parsedRuns : 3,
  }
}

async function runTemplateSmokeIteration(runNumber: number): Promise<ScenarioRecord[]> {
  const runtime = createRuntimeWithCapabilityTools(createPhase4TemplateSmokeStubs())
  const context = {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: `phase4-template-smoke-${runNumber}`,
    turnId: `turn-${runNumber}`,
  }

  const scenarios = [
    {
      scenario: 'browser-editor-chat-reply-template',
      toolName: 'skill.browser.editor_chat_reply_template',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
      expectedNestedChain: 'skill.browser.editor_chat_stage_and_deliver_verify',
      expectedMarker: 'template=browser-editor-chat-reply',
      expectedTarget: 'Codex',
      expectedArtifact: 'browser-editor-chat-delivery',
    },
    {
      scenario: 'browser-doc-desktop-deliver-template',
      toolName: 'skill.browser.doc_desktop_deliver_template',
      input: {
        editorAppName: 'Notepad',
        finalAppName: 'WeChat',
      },
      expectedNestedChain: 'skill.browser.editor_stage_and_deliver',
      expectedMarker: 'template=browser-doc-desktop-deliver',
      expectedTarget: 'WeChat',
      expectedArtifact: 'browser-editor-final-delivery',
    },
    {
      scenario: 'file-browser-form-submit-template',
      toolName: 'skill.file.browser_form_submit_template',
      input: {
        path: `phase4-template-followup-${runNumber}.txt`,
        browserWindowTitle: 'Microsoft Edge',
      },
      expectedNestedChain: 'skill.file_read_transform_transfer',
      expectedMarker: 'template=file-browser-form-submit',
      expectedTarget: 'Microsoft Edge',
      expectedArtifact: `phase4-template-followup-${runNumber}.txt`,
    },
    {
      scenario: 'multi-window-compare-summarize-deliver-template',
      toolName: 'skill.multi_window.compare_summarize_deliver_template',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
      },
      expectedNestedChain: 'skill.multi_window.observe_route_deliver_verify',
      expectedMarker: 'template=multi-window-compare-summarize-deliver',
      expectedTarget: 'Notepad',
      expectedArtifact: 'multi-window-observe-route-deliver-verify',
    },
    {
      scenario: 'browser-extract-transform-post-template',
      toolName: 'skill.browser.extract_transform_post_template',
      input: {
        targetWindowTitle: 'Notepad',
      },
      expectedNestedChain: 'skill.browser.extract_then_transfer',
      expectedMarker: 'template=browser-extract-transform-post',
      expectedTarget: 'Notepad',
      expectedArtifact: 'browser-dom-extract',
    },
  ]

  const results: ScenarioRecord[] = []
  for (const scenario of scenarios) {
    const result = await runtime.execute(
      {
        toolName: scenario.toolName,
        input: scenario.input,
      },
      context,
    )

    results.push(
      classifyTemplateScenario(
        scenario.scenario,
        result,
        scenario.expectedNestedChain,
        scenario.expectedMarker,
        scenario.expectedTarget,
        scenario.expectedArtifact,
      ),
    )
  }

  return results
}

function classifyTemplateScenario(
  scenario: string,
  result: { ok: boolean; summary: string; data?: unknown },
  expectedNestedChain: string,
  expectedMarker: string,
  expectedTarget: string,
  expectedArtifact: string,
): ScenarioRecord {
  try {
    assert(result.ok, `verification_failed ${scenario} execution failed`)
    assertVerificationPassed(result.data, `verification_failed ${scenario} verification failed`)
    assertOperationPresent(
      result.data,
      expectedNestedChain,
      `verification_failed ${scenario} nested chain missing`,
    )
    assertEvidencePresent(
      result.data,
      expectedMarker,
      `verification_failed ${scenario} template evidence missing`,
    )
    assertChainState(
      result.data,
      expectedTarget,
      expectedArtifact,
      'completed',
      `verification_failed ${scenario} chain state mismatch`,
    )
    assertRoutingPolicyDefault(
      result.data,
      `verification_failed ${scenario} routing policy mismatch`,
    )
    return { scenario, status: 'pass', detail: result.summary }
  } catch (error) {
    return {
      scenario,
      status: classifyStatusFromError(error, result.data),
      detail: formatErrorMessage(error),
    }
  }
}

function classifyStatusFromError(error: unknown, data?: unknown): ScenarioStatus {
  const failureReason =
    typeof data === 'object' && data !== null
      ? (data as { failureReason?: unknown }).failureReason
      : undefined
  if (failureReason === 'routing_failed') {
    return 'routing_failed'
  }
  if (failureReason === 'execution_failed') {
    return 'execution_failed'
  }
  if (failureReason === 'observation_insufficient') {
    return 'environment_unready'
  }

  const message = formatErrorMessage(error)
  if (message.startsWith('missing_dependency')) {
    return 'environment_unready'
  }
  if (message.startsWith('transport_error')) {
    return 'transport_error'
  }
  if (message.startsWith('provider_error')) {
    return 'provider_error'
  }
  if (message.startsWith('permission_blocked')) {
    return 'permission_blocked'
  }
  if (message.startsWith('routing_failed')) {
    return 'routing_failed'
  }
  if (message.startsWith('execution_failed')) {
    return 'execution_failed'
  }
  if (message.startsWith('environment_unready')) {
    return 'environment_unready'
  }

  return 'verification_failed'
}

function assertVerificationPassed(data: unknown, errorMessage: string): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    throw new Error(errorMessage)
  }

  if ((verification as { passed?: unknown }).passed !== true) {
    throw new Error(errorMessage)
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

  const found = evidence.some(item => typeof item === 'string' && item.includes(marker))
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

function assertRoutingPolicyDefault(data: unknown, errorMessage: string): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const routingPolicy = (data as { routingPolicy?: unknown }).routingPolicy
  if (
    !Array.isArray(routingPolicy) ||
    routingPolicy.join('|') !==
      ['backend-first', 'browser-dom-first', 'desktop-observe-fallback', 'gui-last'].join('|')
  ) {
    throw new Error(errorMessage)
  }
}

function createPhase4TemplateSmokeStubs(): AnyStubTool[] {
  return [
    createStubTool(
      'skill.browser.editor_chat_stage_and_deliver_verify',
      ['editorAppName', 'chatAppName'],
      async input => ({
        ok: true,
        summary: `verified chat delivery for ${String(input.chatAppName)}`,
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
    createStubTool(
      'skill.browser.editor_stage_and_deliver',
      ['editorAppName', 'finalAppName'],
      async input => ({
        ok: true,
        summary: `verified desktop delivery for ${String(input.finalAppName)}`,
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
  ]
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
      properties: Object.fromEntries(requiredKeys.map(key => [key, { type: 'string' }])),
      required: requiredKeys,
    },
    execute,
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
