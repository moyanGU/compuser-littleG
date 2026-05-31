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

type ScenarioDefinition = {
  scenario: string
  toolName: string
  nestedTool: string
  input: Record<string, unknown>
  expectedMarker: string
  expectedTarget: string
  expectedArtifact: string
  expectedVerificationDetails: string
  expectedEvidence: string[]
  expectedOutput: Record<string, unknown>
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
        `[${result.status}] phase5-template-smoke run=${run} scenario=${result.scenario} ${result.detail}`,
      )
    }
  }

  console.log(
    `phase5-template-smoke summary total_runs=${totals.total_runs} pass=${totals.pass} skip=${totals.skip} verification_failed=${totals.verification_failed} environment_unready=${totals.environment_unready} transport_error=${totals.transport_error} provider_error=${totals.provider_error} routing_failed=${totals.routing_failed} execution_failed=${totals.execution_failed} permission_blocked=${totals.permission_blocked}`,
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
  const runtime = createRuntimeWithCapabilityTools(createPhase5TemplateSmokeStubs())
  const context = {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: `phase5-template-smoke-${runNumber}`,
    turnId: `turn-${runNumber}`,
  }

  const scenarios: ScenarioDefinition[] = [
    {
      scenario: 'browser-editor-chat-reply-template',
      toolName: 'skill.browser.editor_chat_reply_template',
      nestedTool: 'skill.browser.editor_chat_stage_and_deliver_verify',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
      expectedMarker: 'template=browser-editor-chat-reply',
      expectedTarget: 'Codex',
      expectedArtifact: 'browser-editor-chat-delivery',
      expectedVerificationDetails:
        'Reply template completed by reusing the verified browser -> editor -> chat delivery chain.',
      expectedEvidence: ['verified:Codex'],
      expectedOutput: {
        selectedWindowTitle: 'Codex',
        currentTarget: 'Codex',
        currentArtifact: 'browser-editor-chat-delivery',
        status: 'completed',
      },
    },
    {
      scenario: 'browser-doc-desktop-deliver-template',
      toolName: 'skill.browser.doc_desktop_deliver_template',
      nestedTool: 'skill.browser.editor_stage_and_deliver',
      input: {
        editorAppName: 'Notepad',
        finalAppName: 'WeChat',
      },
      expectedMarker: 'template=browser-doc-desktop-deliver',
      expectedTarget: 'WeChat',
      expectedArtifact: 'browser-editor-final-delivery',
      expectedVerificationDetails:
        'Document delivery template completed by reusing the verified browser -> editor -> desktop chain.',
      expectedEvidence: ['finalTarget=WeChat'],
      expectedOutput: {
        selectedWindowTitle: 'WeChat',
        currentTarget: 'WeChat',
        currentArtifact: 'browser-editor-final-delivery',
        status: 'completed',
      },
    },
    {
      scenario: 'file-browser-form-submit-template',
      toolName: 'skill.file.browser_form_submit_template',
      nestedTool: 'skill.file_read_transform_transfer',
      input: {
        path: `phase5-template-followup-${runNumber}.txt`,
        browserWindowTitle: 'Microsoft Edge',
      },
      expectedMarker: 'template=file-browser-form-submit',
      expectedTarget: 'Microsoft Edge',
      expectedArtifact: `phase5-template-followup-${runNumber}.txt`,
      expectedVerificationDetails:
        'Browser form submit template completed by reusing the read/transform/transfer chain against the browser target.',
      expectedEvidence: ['transform=uppercase'],
      expectedOutput: {
        selectedWindowTitle: 'Microsoft Edge',
        currentTarget: 'Microsoft Edge',
        currentArtifact: `phase5-template-followup-${runNumber}.txt`,
        status: 'completed',
      },
    },
    {
      scenario: 'multi-window-compare-summarize-deliver-template',
      toolName: 'skill.multi_window.compare_summarize_deliver_template',
      nestedTool: 'skill.multi_window.observe_route_deliver_verify',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'note',
        targetAppName: 'Notepad',
      },
      expectedMarker: 'template=multi-window-compare-summarize-deliver',
      expectedTarget: 'Notepad',
      expectedArtifact: 'multi-window-observe-route-deliver-verify',
      expectedVerificationDetails:
        'Compare/summarize/deliver template completed by reusing the verified multi-window observe -> route -> deliver chain.',
      expectedEvidence: ['routeReason=secondary evidence better matched note'],
      expectedOutput: {
        selectedWindowTitle: 'Notepad',
        currentTarget: 'Notepad',
        currentArtifact: 'multi-window-observe-route-deliver-verify',
        status: 'completed',
      },
    },
    {
      scenario: 'browser-extract-transform-post-template',
      toolName: 'skill.browser.extract_transform_post_template',
      nestedTool: 'skill.browser.extract_then_transfer',
      input: {
        targetWindowTitle: 'Notepad',
      },
      expectedMarker: 'template=browser-extract-transform-post',
      expectedTarget: 'Notepad',
      expectedArtifact: 'browser-dom-extract',
      expectedVerificationDetails:
        'Extract/post template completed by reusing the browser extract -> transfer chain as the minimal verified Phase 4 path.',
      expectedEvidence: ['mode=dom'],
      expectedOutput: {
        selectedWindowTitle: 'Notepad',
        currentTarget: 'Notepad',
        currentArtifact: 'browser-dom-extract',
        status: 'completed',
      },
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

    results.push(classifyTemplateScenario(scenario, result))
  }

  return results
}

function classifyTemplateScenario(
  scenario: ScenarioDefinition,
  result: { ok: boolean; summary: string; data?: unknown },
): ScenarioRecord {
  try {
    assert(result.ok, `verification_failed ${scenario.scenario} execution failed`)
    assertVerification(result.data, true, scenario.expectedVerificationDetails, `verification_failed ${scenario.scenario} verification failed`)
    assertOperationPresent(result.data, scenario.nestedTool, `verification_failed ${scenario.scenario} nested chain missing`)
    assertEvidencePresent(result.data, scenario.expectedMarker, `verification_failed ${scenario.scenario} template evidence missing`)
    assertEvidenceMarkers(result.data, scenario.expectedEvidence, `verification_failed ${scenario.scenario} nested verification evidence missing`)
    assertChainState(result.data, scenario.expectedTarget, scenario.expectedArtifact, 'completed', `verification_failed ${scenario.scenario} chain state mismatch`)
    assertOutputContract(result.data, scenario.expectedOutput, `verification_failed ${scenario.scenario} strict output contract mismatch`)
    assertUnifiedStatusFields(result.data, 'completed', `verification_failed ${scenario.scenario} status field mismatch`)
    assertRoutingPolicyDefault(result.data, `verification_failed ${scenario.scenario} routing policy mismatch`)
    assertRecoveryPointAbsent(result.data, `verification_failed ${scenario.scenario} unexpected recovery point`)
    return { scenario: scenario.scenario, status: 'pass', detail: result.summary }
  } catch (error) {
    return {
      scenario: scenario.scenario,
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

function assertVerification(
  data: unknown,
  expectedPassed: boolean,
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
    (verification as { passed?: unknown }).passed !== expectedPassed ||
    (verification as { details?: unknown }).details !== expectedDetails
  ) {
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

function assertRecoveryPointAbsent(data: unknown, errorMessage: string): void {
  if (typeof data !== 'object' || data === null) {
    return
  }

  if ((data as { recoveryPoint?: unknown }).recoveryPoint !== undefined) {
    throw new Error(errorMessage)
  }
}

function createPhase5TemplateSmokeStubs(): AnyStubTool[] {
  return [
    createStubTool(
      'skill.browser.editor_chat_stage_and_deliver_verify',
      ['editorAppName', 'chatAppName'],
      async () => ({
        ok: true,
        summary: 'verified reply delivery for Codex',
        data: {
          verification: {
            passed: true,
            details:
              'Reply template completed by reusing the verified browser -> editor -> chat delivery chain.',
          },
          output: {
            extractedText: 'Draft reply from browser',
            editorTargetWindowTitle: 'Notepad',
            chatTargetWindowTitle: 'Codex',
            selectedWindowTitle: 'Codex',
            currentTarget: 'Codex',
            currentArtifact: 'browser-editor-chat-delivery',
            status: 'completed',
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
      async () => ({
        ok: true,
        summary: 'verified desktop delivery for WeChat',
        data: {
          verification: {
            passed: true,
            details:
              'Document delivery template completed by reusing the verified browser -> editor -> desktop chain.',
          },
          output: {
            extractedText: 'Browser-derived document',
            editorTargetWindowTitle: 'Notepad',
            finalTargetWindowTitle: 'WeChat',
            selectedWindowTitle: 'WeChat',
            currentTarget: 'WeChat',
            currentArtifact: 'browser-editor-final-delivery',
            status: 'completed',
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
          verification: {
            passed: true,
            details:
              'Browser form submit template completed by reusing the read/transform/transfer chain against the browser target.',
          },
          output: {
            sourcePath: String(input.path),
            transformedText: 'FORM BODY',
            targetWindowTitle: 'Microsoft Edge',
            selectedWindowTitle: 'Microsoft Edge',
            currentTarget: 'Microsoft Edge',
            currentArtifact: String(input.path),
            status: 'completed',
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
      async () => ({
        ok: true,
        summary: 'verified compare summarize deliver for Notepad',
        data: {
          verification: {
            passed: true,
            details:
              'Compare/summarize/deliver template completed by reusing the verified multi-window observe -> route -> deliver chain.',
          },
          output: {
            selectedWindowTitle: 'Notepad',
            routeReason: 'secondary evidence better matched note',
            currentTarget: 'Notepad',
            currentArtifact: 'multi-window-observe-route-deliver-verify',
            status: 'completed',
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
      async () => ({
        ok: true,
        summary: 'verified extract/post for Notepad',
        data: {
          verification: {
            passed: true,
            details:
              'Extract/post template completed by reusing the browser extract -> transfer chain as the minimal verified Phase 4 path.',
          },
          output: {
            extractedText: 'Post body from browser',
            targetWindowTitle: 'Notepad',
            selectedWindowTitle: 'Notepad',
            currentTarget: 'Notepad',
            currentArtifact: 'browser-dom-extract',
            status: 'completed',
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
    searchHints: [name, 'regression', 'phase5', 'stub'],
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
