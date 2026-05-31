import { RuleBasedMicroCompactStrategy } from '../../packages/harness/compact/CompactStrategy.js'
import type { QueryMessage } from '../../packages/core/QueryEngine.js'

async function main(): Promise<void> {
  await verifyMicroCompactRetainsPointers()
  await verifySessionMemoryCompactTriggers()
  await verifyFullCompactTriggers()
  await verifySessionMemoryCompactCarriesStructuredFacts()
  await verifyCompactFailureDegradesWithoutThrowing()
  await verifyCompactCircuitBreakerPausesAutoCompact()
  console.log('Compact regression passed: 6/6')
}

async function verifyMicroCompactRetainsPointers(): Promise<void> {
  const strategy = new RuleBasedMicroCompactStrategy({
    keepRecentToolMessages: 1,
    maxInlineToolContentChars: 80,
    softLimit: 18_000,
    hardLimit: 24_000,
    headroom: 4_000,
  })

  const result = await strategy.compact([
    message('user', 'search something'),
    toolMessage('workspace.grep', {
      summary: 'long result',
      pointer: 'artifacts/tool-results/a.json',
      filler: 'x'.repeat(800),
    }),
    toolMessage('workspace.grep', {
      summary: 'recent result',
      pointer: 'artifacts/tool-results/b.json',
    }),
  ])

  assert(result.tier === 'micro', 'micro compact should trigger')
  const firstTool = JSON.parse(result.messages[1].content) as {
    pointer?: string
    compacted?: boolean
  }
  assert(firstTool.compacted === true, 'older tool message should be compacted')
  assert(
    firstTool.pointer === 'artifacts/tool-results/a.json',
    'pointer should be retained after micro compact',
  )
}

async function verifySessionMemoryCompactTriggers(): Promise<void> {
  const strategy = new RuleBasedMicroCompactStrategy({
    keepRecentToolMessages: 0,
    softLimit: 200,
    hardLimit: 1_200,
    headroom: 100,
  })

  const messages = Array.from({ length: 12 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `message-${index} ${'x'.repeat(120)}`),
  )

  const result = await strategy.compact(messages)
  assert(
    result.tier === 'session-memory',
    'session-memory compact should trigger when micro compact is insufficient but hard limit is not exceeded',
  )
}

async function verifyFullCompactTriggers(): Promise<void> {
  const strategy = new RuleBasedMicroCompactStrategy({
    keepRecentToolMessages: 0,
    softLimit: 150,
    hardLimit: 250,
    headroom: 100,
  })

  const messages = Array.from({ length: 14 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `message-${index} ${'y'.repeat(220)}`),
  )

  const result = await strategy.compact(messages)
  assert(result.tier === 'full', 'full compact should trigger after hard limit is exceeded')
}

async function verifySessionMemoryCompactCarriesStructuredFacts(): Promise<void> {
  const strategy = new RuleBasedMicroCompactStrategy({
    keepRecentToolMessages: 0,
    softLimit: 200,
    hardLimit: 1_200,
    minSessionMemoryMessages: 4,
    modelInvoker: {
      async sessionMemoryCompact() {
        return {
          summaryText: 'structured memory compact summary',
          memoryFacts: [
            {
              key: 'task.current',
              category: 'task',
              content: 'Inspect current desktop state.',
              mergeStrategy: 'replace',
            },
            {
              key: 'project.recent_paths',
              category: 'project',
              content: 'E:\\compuser\\compuser\\package.json',
              mergeStrategy: 'replace',
            },
          ],
        }
      },
      async fullCompact() {
        return {
          summaryText: '<summary>fallback</summary>',
        }
      },
    },
  })

  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `message-${index} ${'z'.repeat(120)}`),
  )

  const result = await strategy.compact(messages)
  assert(result.tier === 'session-memory', 'session-memory compact should still trigger')
  const summaryEnvelope = JSON.parse(result.messages[0].content) as {
    kind?: string
    memoryFacts?: Array<{ key?: string }>
  }
  assert(summaryEnvelope.kind === 'session-memory', 'session-memory message should be wrapped')
  assert(
    Array.isArray(summaryEnvelope.memoryFacts) &&
      summaryEnvelope.memoryFacts.some(fact => fact.key === 'task.current'),
    'session-memory compact should carry model-produced structured facts',
  )
}

async function verifyCompactFailureDegradesWithoutThrowing(): Promise<void> {
  const strategy = new RuleBasedMicroCompactStrategy({
    keepRecentToolMessages: 0,
    softLimit: 200,
    hardLimit: 1_200,
    minSessionMemoryMessages: 4,
    modelInvoker: {
      async sessionMemoryCompact() {
        throw new Error('forced session-memory failure')
      },
      async fullCompact() {
        throw new Error('forced full failure')
      },
    },
  })

  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `message-${index} ${'q'.repeat(120)}`),
  )

  const result = await strategy.compact(messages)
  assert(
    result.summary?.includes('session-memory compact failed'),
    'compact should degrade with failure summary instead of throwing',
  )
}

async function verifyCompactCircuitBreakerPausesAutoCompact(): Promise<void> {
  const strategy = new RuleBasedMicroCompactStrategy({
    keepRecentToolMessages: 0,
    softLimit: 200,
    hardLimit: 1_200,
    minSessionMemoryMessages: 4,
    maxConsecutiveCompactFailures: 2,
    modelInvoker: {
      async sessionMemoryCompact() {
        throw new Error('repeat compact failure')
      },
      async fullCompact() {
        throw new Error('repeat compact failure')
      },
    },
  })

  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `message-${index} ${'w'.repeat(120)}`),
  )

  await strategy.compact(messages)
  await strategy.compact(messages)
  const paused = await strategy.compact(messages)
  assert(
    paused.summary?.includes('Auto compact paused'),
    'compact should pause after configured consecutive failures',
  )
}

function message(
  role: QueryMessage['role'],
  content: string,
): QueryMessage {
  return {
    role,
    content,
  }
}

function toolMessage(
  toolName: string,
  data: Record<string, unknown>,
): QueryMessage {
  return {
    role: 'tool',
    toolName,
    content: JSON.stringify({
      toolName,
      ok: true,
      ...data,
    }),
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
