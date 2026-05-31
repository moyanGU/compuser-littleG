import assert from 'node:assert/strict'

import { QueryEngine } from '../dist/packages/core/QueryEngine.js'
import { DemoModelClient } from '../dist/packages/core/ModelClient.js'
import { ContextAssembler } from '../dist/packages/harness/context/ContextAssembler.js'
import { InMemoryMemoryStore } from '../dist/packages/harness/memory/MemoryStore.js'
import { InMemoryCapabilityCatalog } from '../dist/packages/capabilities/CapabilityCatalog.js'
import { InMemoryToolRegistry } from '../dist/packages/tools/Tool.js'
import { planToolExecutionBatches } from '../dist/packages/tools/runtime/ToolOrchestration.js'

const registry = new Map([
  ['parallel-a', { concurrencySafe: true, executionMode: 'sync' }],
  ['parallel-b', { concurrencySafe: true, executionMode: 'sync' }],
  ['serial', { concurrencySafe: false, executionMode: 'sync' }],
  ['async', { concurrencySafe: true, executionMode: 'async' }],
])

assert.deepStrictEqual(planToolExecutionBatches([], registry), [], 'empty plans stay empty')

assert.deepStrictEqual(
  planToolExecutionBatches(
    [
      { toolName: 'parallel-a' },
      { toolName: 'parallel-b' },
      { toolName: 'serial' },
      { toolName: 'parallel-a' },
    ],
    registry,
  ),
  [
    {
      mode: 'parallel',
      calls: [{ toolName: 'parallel-a' }, { toolName: 'parallel-b' }],
    },
    {
      mode: 'serial',
      calls: [{ toolName: 'serial' }],
    },
    {
      mode: 'parallel',
      calls: [{ toolName: 'parallel-a' }],
    },
  ],
  'adjacent sync concurrency-safe tools should batch together around serial breaks',
)

assert.deepStrictEqual(
  planToolExecutionBatches([{ toolName: 'async' }], registry),
  [
    {
      mode: 'serial',
      calls: [{ toolName: 'async' }],
    },
  ],
  'async tools should not be treated as parallel-safe batches',
)

assert.deepStrictEqual(
  planToolExecutionBatches([{ toolName: 'missing' }], registry),
  [
    {
      mode: 'serial',
      calls: [{ toolName: 'missing' }],
    },
  ],
  'unknown tools should default to serial execution',
)

await verifyQueryEngineUsesRuntimeExecuteMany()

async function verifyQueryEngineUsesRuntimeExecuteMany() {
  const toolRegistry = new InMemoryToolRegistry()
  const runtimeCalls = []
  const persistedSummaries = []
  const memoryStore = new InMemoryMemoryStore()
  const runtime = {
    async executeMany(calls, context) {
      runtimeCalls.push({
        toolNames: calls.map(call => call.toolName),
        turnId: context.turnId,
      })
      return calls.map(call => ({
        ok: true,
        summary: `executed ${call.toolName}`,
      }))
    },
    async execute() {
      throw new Error('QueryEngine should use executeMany for batched execution')
    },
    async notifyBeforeModelCall() {},
  }

  const engine = new QueryEngine({
    cwd: 'E:/compuser/compuser',
    sessionId: 'tool-orchestration-test',
    baseSystemPrompt: 'test prompt',
    modelClient: new DemoModelClient(),
    registry: toolRegistry,
    runtime,
    contextAssembler: new ContextAssembler(),
    memoryStore: {
      async appendFact(fact) {
        persistedSummaries.push(fact)
        return memoryStore.appendFact(fact)
      },
      listFacts() {
        return memoryStore.listFacts()
      },
    },
    capabilityCatalog: new InMemoryCapabilityCatalog([]),
    maxTurns: 1,
  })

  const results = await engine.executeTools([
    { callId: 'a', toolName: 'parallel-a', input: {} },
    { callId: 'b', toolName: 'parallel-b', input: {} },
  ])

  assert.equal(runtimeCalls.length, 1, 'QueryEngine should delegate a batch to runtime.executeMany')
  assert.deepStrictEqual(
    runtimeCalls[0].toolNames,
    ['parallel-a', 'parallel-b'],
    'QueryEngine should preserve batched tool order',
  )
  assert.deepStrictEqual(
    results.map(result => result.summary),
    ['executed parallel-a', 'executed parallel-b'],
    'QueryEngine should preserve runtime result order',
  )
  assert.equal(
    engine.getMessages().filter(message => message.role === 'tool').length,
    2,
    'QueryEngine should still emit one tool message per tool result',
  )
  assert(
    persistedSummaries.some(
      fact =>
        fact.key === 'task.last_outcome' &&
        String(fact.content).includes('parallel-b'),
    ),
    'QueryEngine should still persist routing/task facts for batched results',
  )
}
