import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  OpenAICompatibleRequestError,
  parseOpenAICompatiblePayload,
  OpenAICompatibleModelClient,
  type OpenAICompatibleChatCompletionResponse,
  type OpenAICompatibleCompatibilityMode,
  type OpenAICompatibleModelClientOptions,
} from '../../packages/core/ModelClient.js'
import type { AssembledContext } from '../../packages/harness/context/ContextAssembler.js'

type RegressionFixture = {
  name: string
  compatibilityMode: OpenAICompatibleCompatibilityMode
  payload: OpenAICompatibleChatCompletionResponse
  expected:
    | {
        type: 'final'
        messageIncludes: string
      }
    | {
        type: 'tool_calls'
        toolNames: string[]
      }
    | {
        type: 'error'
        errorCode: string
      }
}

async function main(): Promise<void> {
  const fixtures = await loadFixtures()
  let passed = 0

  for (const fixture of fixtures) {
    try {
      runFixture(fixture)
      passed += 1
      console.log(`[pass] ${fixture.name}`)
    } catch (error) {
      console.error(`[fail] ${fixture.name}`)
      console.error(error)
      process.exitCode = 1
    }
  }

  const compactPassed = await runCompactFixtures()
  passed += compactPassed
  console.log(`Regression fixtures passed: ${passed}/${fixtures.length + compactPassed}`)
}

async function loadFixtures(): Promise<RegressionFixture[]> {
  const fixtureDirectory = resolve(process.cwd(), 'fixtures', 'model-regression')
  const fileNames = (await readdir(fixtureDirectory))
    .filter(fileName => fileName.endsWith('.json'))
    .sort()

  const fixtures: RegressionFixture[] = []
  for (const fileName of fileNames) {
    const filePath = resolve(fixtureDirectory, fileName)
    const content = await readFile(filePath, 'utf8')
    fixtures.push(JSON.parse(content) as RegressionFixture)
  }

  return fixtures
}

function runFixture(fixture: RegressionFixture): void {
  try {
    const result = parseOpenAICompatiblePayload(
      fixture.payload,
      createRegressionContext(),
      fixture.compatibilityMode,
    )

    if (fixture.expected.type === 'error') {
      throw new Error(
        `Expected error code ${fixture.expected.errorCode} but parsing succeeded.`,
      )
    }

    if (fixture.expected.type === 'final') {
      if (result.type !== 'final') {
        throw new Error(`Expected final response but received ${result.type}.`)
      }

      if (!result.message.includes(fixture.expected.messageIncludes)) {
        throw new Error(
          `Expected final message to include "${fixture.expected.messageIncludes}" but got "${result.message}".`,
        )
      }

      return
    }

    if (result.type !== 'tool_calls') {
      throw new Error(`Expected tool_calls response but received ${result.type}.`)
    }

    const actualToolNames = result.toolCalls.map(toolCall => toolCall.toolName)
    const expectedToolNames = fixture.expected.toolNames
    if (
      actualToolNames.length !== expectedToolNames.length ||
      actualToolNames.some((toolName, index) => toolName !== expectedToolNames[index])
    ) {
      throw new Error(
        `Expected tool names ${expectedToolNames.join(', ')} but received ${actualToolNames.join(', ')}.`,
      )
    }
  } catch (error) {
    if (fixture.expected.type !== 'error') {
      throw error
    }

    if (!(error instanceof OpenAICompatibleRequestError)) {
      throw error
    }

    if (error.code !== fixture.expected.errorCode) {
      throw new Error(
        `Expected error code ${fixture.expected.errorCode} but received ${error.code}.`,
      )
    }
  }
}

function createRegressionContext(): AssembledContext {
  return {
    systemPrompt: 'You are the compuser provider regression harness.',
    toolCatalog: [
      {
        name: 'windows.screenshot',
        description: 'Capture a desktop screenshot.',
        availability: 'core',
        searchHints: ['screenshot', 'screen', 'desktop'],
        riskLevel: 'low',
        inputSchema: {
          description: 'screenshot input',
          properties: {},
          required: [],
        },
      },
      {
        name: 'windows.click',
        description: 'Click a screen coordinate.',
        availability: 'core',
        searchHints: ['mouse', 'click', 'coordinate'],
        riskLevel: 'high',
        inputSchema: {
          description: 'click input',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
          },
          required: ['x', 'y'],
        },
      },
    ],
    capabilityCatalog: [],
    routingPlan: {
      taskText: '',
      recommendedCapabilities: [],
      fallbackTools: [],
      policyHints: [],
      executionState: {
        attemptedTools: [],
        failedTools: [],
        blockedTools: [],
        exhaustedTools: [],
        recentAttempts: [],
      },
    },
    memoryFacts: [],
    activePlan: {
      goal: 'provider regression',
      subgoal: 'parse compatibility fixtures',
      status: 'collecting',
    },
    chainState: {},
    compactState: {
      tier: 'none',
      tokenBudget: {
        softLimit: 18_000,
        hardLimit: 24_000,
        headroom: 4_000,
        estimatedInputTokens: 256,
      },
    },
  }
}

async function runCompactFixtures(): Promise<number> {
  await verifyCompactSummaryFixture({
    name: 'compact-summary-ok',
    payload: {
      choices: [
        {
          message: {
            content: '<analysis>internal</analysis><summary>compact ok</summary>',
          },
        },
      ],
    },
    shouldPass: true,
  })

  await verifyCompactSummaryFixture({
    name: 'compact-summary-missing',
    payload: {
      choices: [
        {
          message: {
            content: '<analysis>internal</analysis>',
          },
        },
      ],
    },
    shouldPass: false,
    errorCode: 'parse_error',
  })

  await verifyCompactSessionMemoryFixture()
  return 3
}

async function verifyCompactSummaryFixture(input: {
  name: string
  payload: OpenAICompatibleChatCompletionResponse
  shouldPass: boolean
  errorCode?: string
}): Promise<void> {
  const client = new StubCompactModelClient(input.payload)

  try {
    const result = await client.generateCompact({
      kind: 'full',
      messages: [{ role: 'user', content: 'compact me' }],
    })

    if (!input.shouldPass) {
      throw new Error(`Expected ${input.name} to fail but it passed.`)
    }

    if (!result.summaryText.includes('compact ok')) {
      throw new Error(`Expected ${input.name} summary to include compact ok.`)
    }

    console.log(`[pass] ${input.name}`)
  } catch (error) {
    if (input.shouldPass) {
      throw error
    }

    if (!(error instanceof OpenAICompatibleRequestError)) {
      throw error
    }

    if (error.code !== input.errorCode) {
      throw new Error(
        `Expected compact error code ${input.errorCode} but received ${error.code}.`,
      )
    }

    console.log(`[pass] ${input.name}`)
  }
}

async function verifyCompactSessionMemoryFixture(): Promise<void> {
  const client = new StubCompactModelClient({
    choices: [
      {
        message: {
          content: JSON.stringify({
            taskCurrent: 'Inspect desktop',
            taskPlan: 'observe then verify',
            taskLastOutcome: 'snapshot ok',
            routingLastAttempt: 'skill.desktop.observe succeeded',
            routingExecutionState: 'verification=passed',
            projectStructure: 'Recent project paths: E:\\compuser\\compuser',
            projectRecentPaths: ['E:\\compuser\\compuser\\package.json'],
            preferenceResponseLanguage: 'Chinese',
            preferenceExecutionPath: 'backend-first',
            constraintActive: 'none',
            compactLastSummary: 'session compact ok',
          }),
        },
      },
    ],
  })

  const result = await client.generateCompact({
    kind: 'session-memory',
    messages: [{ role: 'user', content: 'compact me' }],
  })

  if (!result.memoryFacts?.some(fact => fact.key === 'task.current')) {
    throw new Error('Expected compact session-memory fixture to map structured facts.')
  }

  console.log('[pass] compact-session-memory-ok')
}

class StubCompactModelClient extends OpenAICompatibleModelClient {
  constructor(private readonly payload: OpenAICompatibleChatCompletionResponse) {
    super({
      baseUrl: 'http://stub.invalid',
      model: 'stub-model',
    } satisfies OpenAICompatibleModelClientOptions)
  }

  protected override async executeCompactRequest(): Promise<OpenAICompatibleChatCompletionResponse> {
    return this.payload
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
