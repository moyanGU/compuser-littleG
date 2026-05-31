import { DemoModelClient } from '../../packages/core/ModelClient.js'
import { QueryEngine } from '../../packages/core/QueryEngine.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { ContextAssembler } from '../../packages/harness/context/ContextAssembler.js'
import { InMemoryMemoryStore } from '../../packages/harness/memory/MemoryStore.js'
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
  await verifyDesktopRecoveryFallsBackSafely()
  await verifyDeterministicFailureFallsBackWithoutRetry()
  await verifyTransientFailureRetriesUntilExhausted()
  await verifyDeterministicFailureWithoutFallbackDoesNotRetry()
  await verifyChainStatePersistsVerifiedFailureAndRecoveryPoint()
  await verifyChainStatePersistsTargetAndArtifactOnSuccess()
  console.log('Routing state regression passed: 6/6')
}

async function verifyDesktopRecoveryFallsBackSafely(): Promise<void> {
  const scenario = await runScenario('Please inspect the current desktop.', [
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: false,
      summary: 'observe failed',
      error: 'forced failure',
      data: {
        verification: {
          passed: false,
        },
      },
    })),
    createStubTool('windows.snapshot', [], async () => ({
      ok: true,
      summary: 'snapshot ok',
      data: {
        pointer: 'snapshot.json',
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['skill.desktop.observe', 'windows.snapshot'],
    'desktop recovery should fallback to windows.snapshot',
  )
  assertFactIncludes(
    scenario.routingFacts,
    'routing.execution_state',
    'skill.desktop.observe',
  )
}

async function verifyDeterministicFailureFallsBackWithoutRetry(): Promise<void> {
  const scenario = await runScenario('Search for "QueryEngine".', [
    createStubTool('command.workspace.search_text', ['query'], async input => ({
      ok: false,
      summary: `search failed: ${String(input.query ?? '')}`,
      error: 'forced failure',
      data: {
        failureClass: 'deterministic',
      },
    })),
    createStubTool('windows.snapshot', [], async () => ({
      ok: true,
      summary: 'snapshot ok',
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['command.workspace.search_text', 'windows.snapshot'],
    'deterministic failure should fallback instead of retrying search_text',
  )
  assertFactIncludes(
    scenario.routingFacts,
    'routing.execution_state',
    'command.workspace.search_text',
  )
}

async function verifyTransientFailureRetriesUntilExhausted(): Promise<void> {
  const scenario = await runScenario('Search for "QueryEngine".', [
    createStubTool('command.workspace.search_text', ['query'], async input => ({
      ok: false,
      summary: `search failed: ${String(input.query ?? '')}`,
      error: 'CLI_COMMAND_TIMEOUT',
      data: {
        failureClass: 'transient',
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['command.workspace.search_text', 'command.workspace.search_text'],
    'transient failure should retry once when no safer fallback exists',
  )
  assertFactIncludes(
    scenario.routingFacts,
    'routing.execution_state',
    'command.workspace.search_text',
  )
}

async function verifyDeterministicFailureWithoutFallbackDoesNotRetry(): Promise<void> {
  const scenario = await runScenario('Search for "QueryEngine".', [
    createStubTool('command.workspace.search_text', ['query'], async input => ({
      ok: false,
      summary: `search failed: ${String(input.query ?? '')}`,
      error: 'forced failure',
      data: {
        failureClass: 'deterministic',
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['command.workspace.search_text'],
    'deterministic failure without fallback should not retry the same tool',
  )
}

async function verifyChainStatePersistsVerifiedFailureAndRecoveryPoint(): Promise<void> {
  const scenario = await runScenario('Please inspect the current desktop.', [
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: false,
      summary: 'observation anchor missing',
      data: {
        verification: {
          passed: false,
        },
        chainState: {
          currentTarget: 'Notepad',
          lastVerifiedAnchor: 'window:Notepad',
          chainStatus: 'verified_failed',
        },
        recoveryPoint: 'focus:Notepad',
        verificationEvidence: ['expected window anchor missing'],
      },
    })),
    createStubTool('windows.snapshot', [], async () => ({
      ok: true,
      summary: 'snapshot recovered',
      data: {
        verification: {
          passed: true,
        },
      },
    })),
  ])

  assertFactEquals(
    scenario.allFacts,
    'routing.chain_status',
    'completed',
    'fallback success should leave chain in completed state',
  )
  assertFactEquals(
    scenario.allFacts,
    'routing.last_verified_anchor',
    'window:Notepad',
    'verified failure should persist the last verified anchor',
  )
  assertFactEquals(
    scenario.allFacts,
    'routing.last_recovery_point',
    'focus:Notepad',
    'verified failure should persist the recovery point',
  )
  assertFactIncludes(
    scenario.allFacts,
    'task.current_target',
    'Notepad',
  )
}

async function verifyChainStatePersistsTargetAndArtifactOnSuccess(): Promise<void> {
  const scenario = await runScenario('Please inspect the current desktop.', [
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: true,
      summary: 'desktop observation ready',
      pointer: 'E:\\compuser\\artifacts\\desktop-observation.json',
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: 'Calculator',
          currentArtifact: 'artifact://desktop-observation',
          lastVerifiedAnchor: 'window:Calculator',
          chainStatus: 'completed',
        },
        verificationEvidence: ['window:Calculator visible'],
      },
    })),
  ])

  assertFactEquals(
    scenario.allFacts,
    'routing.chain_status',
    'completed',
    'successful capability should persist completed chain state',
  )
  assertFactEquals(
    scenario.allFacts,
    'task.current_target',
    'Calculator',
    'successful capability should persist current target',
  )
  assertFactEquals(
    scenario.allFacts,
    'task.current_artifact',
    'artifact://desktop-observation',
    'successful capability should persist current artifact',
  )
  assertFactEquals(
    scenario.allFacts,
    'routing.last_verified_anchor',
    'window:Calculator',
    'successful capability should persist last verified anchor',
  )
}

async function runScenario(
  prompt: string,
  tools: AnyStubTool[],
): Promise<{
  assistantToolNames: string[]
  routingFacts: Map<string, string>
  allFacts: Map<string, string>
}> {
  const registry = new InMemoryToolRegistry()
  for (const tool of tools) {
    registry.register(tool)
  }

  const memoryStore = new InMemoryMemoryStore()
  const engine = new QueryEngine({
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: 'routing-state-regression',
    baseSystemPrompt: 'You are the compuser routing-state regression harness.',
    modelClient: new DemoModelClient(),
    registry,
    runtime: new ToolRuntime(registry, new AllowAllPermissionChecker()),
    contextAssembler: new ContextAssembler(),
    memoryStore,
    capabilityCatalog: new InMemoryCapabilityCatalog(createBuiltinCapabilities()),
    maxTurns: 4,
  })

  const result = await engine.submitUserMessage(prompt)
  const facts = await memoryStore.listFacts()

  return {
    assistantToolNames: result.messages
      .filter(message => message.role === 'assistant' && message.toolCalls?.length)
      .flatMap(message => message.toolCalls?.map(call => call.toolName) ?? []),
    routingFacts: new Map(
      facts
        .filter(fact => fact.category === 'routing' && fact.key)
        .map(fact => [fact.key as string, fact.content]),
    ),
    allFacts: new Map(
      facts
        .filter(fact => fact.key)
        .map(fact => [fact.key as string, fact.content]),
    ),
  }
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

function assertToolSequence(
  actual: string[],
  expected: string[],
  description: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((toolName, index) => toolName !== expected[index])
  ) {
    throw new Error(
      `${description}: expected ${expected.join(' -> ')} but received ${actual.join(' -> ')}`,
    )
  }
}

function assertFactIncludes(
  facts: Map<string, string>,
  key: string,
  expectedFragment: string,
): void {
  const content = facts.get(key)
  if (!content?.includes(expectedFragment)) {
    throw new Error(
      `Expected routing fact ${key} to include "${expectedFragment}" but received "${content ?? 'undefined'}".`,
    )
  }
}

function assertFactEquals(
  facts: Map<string, string>,
  key: string,
  expected: string,
  description: string,
): void {
  const content = facts.get(key)
  if (content !== expected) {
    throw new Error(
      `${description}: expected ${key}=${expected} but received ${content ?? 'undefined'}`,
    )
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
