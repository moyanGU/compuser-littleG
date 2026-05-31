import { DemoModelClient } from '../../packages/core/ModelClient.js'
import { QueryEngine } from '../../packages/core/QueryEngine.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
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
  await verifyVerifiedFailureRecoversFromAnchor()
  await verifyBlockedGuiRouteFallsBackToSafeBackendTool()
  await verifyFocusDriftRecoveryPrefersRefocus()
  await verifyObservationInsufficientReroutesToObservationTool()
  console.log('Recovery regression passed: 4/4')
}

async function verifyVerifiedFailureRecoversFromAnchor(): Promise<void> {
  const scenario = await runScenario('Capture browser content and send it to Notepad.', [
    createStubTool('skill.browser_to_editor.capture_verify', ['appName'], async () => ({
      ok: false,
      summary:
        'verification failed; recovery=focus:Notepad; anchor=window:Notepad',
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
        verificationEvidence: ['window anchor disappeared'],
      },
    })),
    createStubTool('command.desktop.capture_and_locate', ['query'], async input => ({
      ok: true,
      summary: `recovered observation for ${String(input.query)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['skill.browser_to_editor.capture_verify', 'command.app.open_or_focus'],
    'verified failure with a focus recovery point should refocus first',
  )
  assertFactEquals(
    scenario.allFacts,
    'routing.last_recovery_point',
    'focus:Notepad',
    'verified failure should persist recovery point',
  )
}

async function verifyBlockedGuiRouteFallsBackToSafeBackendTool(): Promise<void> {
  const scenario = await runScenario('Search the workspace for QueryEngine.', [
    createStubTool('command.workspace.search_text', ['query'], async input => ({
      ok: false,
      summary: `blocked gui-style route for ${String(input.query)}`,
      error: 'TOOL_PERMISSION_DENIED',
      data: {
        failureClass: 'permission',
      },
    })),
    createStubTool('windows.snapshot', [], async () => ({
      ok: true,
      summary: 'safe snapshot fallback',
      data: {
        verification: {
          passed: true,
        },
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['command.workspace.search_text', 'windows.snapshot'],
    'blocked route should reroute to a safer non-GUI fallback',
  )
}

async function verifyFocusDriftRecoveryPrefersRefocus(): Promise<void> {
  const scenario = await runScenario('Open Notepad and keep working there.', [
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async () => ({
      ok: false,
      summary:
        'focus drift detected; recovery=focus:Notepad; anchor=window:Notepad',
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
      },
    })),
    createStubTool('command.app.open_or_focus', ['appName'], async input => ({
      ok: true,
      summary: `focused ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['skill.cross_app.open_observe_act_verify', 'command.app.open_or_focus'],
    'focus drift should prefer refocus recovery',
  )
}

async function verifyObservationInsufficientReroutesToObservationTool(): Promise<void> {
  const scenario = await runScenario('Inspect the current browser page.', [
    createStubTool('command.browser.inspect_dom', [], async () => ({
      ok: false,
      summary:
        'observation insufficient; recovery=observe:browser; anchor=tab:browser',
      data: {
        verification: {
          passed: false,
        },
        chainState: {
          currentTarget: 'Browser',
          lastVerifiedAnchor: 'tab:browser',
          chainStatus: 'verified_failed',
        },
        recoveryPoint: 'observe:browser',
      },
    })),
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: true,
      summary: 'desktop observation recovered',
      data: {
        verification: {
          passed: true,
        },
      },
    })),
  ])

  assertToolSequence(
    scenario.assistantToolNames,
    ['command.browser.inspect_dom', 'command.desktop.capture_and_locate'],
    'observation-insufficient should reroute to a more structured observation path',
  )
}

async function runScenario(
  prompt: string,
  tools: AnyStubTool[],
): Promise<{
  assistantToolNames: string[]
  allFacts: Map<string, string>
}> {
  const registry = new InMemoryToolRegistry()
  const memoryStore = new InMemoryMemoryStore()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }
  for (const tool of tools) {
    registry.register(tool)
  }

  const engine = new QueryEngine({
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: 'recovery-regression',
    baseSystemPrompt: 'You are the compuser recovery regression harness.',
    modelClient: new DemoModelClient(),
    registry,
    runtime,
    contextAssembler: new ContextAssembler(),
    memoryStore,
    capabilityCatalog,
    maxTurns: 4,
  })

  const result = await engine.submitUserMessage(prompt)
  const facts = await memoryStore.listFacts()

  return {
    assistantToolNames: result.messages
      .filter(message => message.role === 'assistant' && message.toolCalls?.length)
      .flatMap(message => message.toolCalls?.map(call => call.toolName) ?? []),
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
    description: `${name} recovery regression stub`,
    searchHints: [name, 'recovery', 'stub'],
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
