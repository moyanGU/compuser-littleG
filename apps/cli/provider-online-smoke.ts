import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  OpenAICompatibleModelClient,
  OpenAICompatibleRequestError,
  type ModelResponse,
  type OpenAICompatibleCompatibilityMode,
  type OpenAICompatibleModelClientOptions,
} from '../../packages/core/ModelClient.js'
import type { AssembledContext } from '../../packages/harness/context/ContextAssembler.js'
import type { QueryMessage } from '../../packages/core/QueryEngine.js'

type OnlineSmokeFixture = {
  name: string
  prompt: string
  compatibilityMode?: OpenAICompatibleCompatibilityMode
  expected:
    | {
        type: 'final'
        messageIncludes: string
      }
    | {
        type: 'tool_calls'
        toolNames: string[]
      }
}

type OnlineSmokeOptions = {
  fixtureName?: string
  modelBaseUrl?: string
  modelApiKey?: string
  modelName?: string
  modelTemperature?: number
  modelMaxTokens?: number
  modelTimeoutMs?: number
  modelStream?: boolean
  modelMaxRetries?: number
  modelRetryDelayMs?: number
  modelCompatibilityMode?: OpenAICompatibleCompatibilityMode
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const fixtures = await loadFixtures(options.fixtureName)
  const baseModelOptions = createBaseModelOptions(options)
  await assertProviderSmokePreconditions(baseModelOptions.baseUrl)

  let passed = 0
  for (const fixture of fixtures) {
    const client = new OpenAICompatibleModelClient({
      ...baseModelOptions,
      compatibilityMode:
        fixture.compatibilityMode ?? baseModelOptions.compatibilityMode,
    })

    try {
      const result = await client.generate({
        context: createOnlineSmokeContext(),
        messages: [
          {
            role: 'user',
            content: fixture.prompt,
          },
        ],
      })

      assertOnlineSmokeResult(result, fixture)
      passed += 1
      console.log(`[pass] ${fixture.name}`)
    } catch (error) {
      console.error(`[fail] ${fixture.name}`)
      if (error instanceof OpenAICompatibleRequestError) {
        console.error(
          `[model-error] code=${error.code} retryable=${error.retryable} status=${error.status ?? 'n/a'}`,
        )
      }
      console.error(error)
      process.exitCode = 1
    }
  }

  await runCompactSmoke(baseModelOptions)
  await runSessionMemoryCompactSmoke(baseModelOptions)
  passed += 2
  console.log(`Online smoke fixtures passed: ${passed}/${fixtures.length + 2}`)
}

async function loadFixtures(
  fixtureName: string | undefined,
): Promise<OnlineSmokeFixture[]> {
  const fixtureDirectory = resolve(process.cwd(), 'fixtures', 'model-online-smoke')
  const fileNames = (await readdir(fixtureDirectory))
    .filter(fileName => fileName.endsWith('.json'))
    .sort()

  const fixtures: OnlineSmokeFixture[] = []
  for (const fileName of fileNames) {
    const filePath = resolve(fixtureDirectory, fileName)
    const content = await readFile(filePath, 'utf8')
    const fixture = JSON.parse(content) as OnlineSmokeFixture
    if (fixtureName && fixture.name !== fixtureName) {
      continue
    }
    fixtures.push(fixture)
  }

  if (fixtures.length === 0) {
    throw new Error(
      fixtureName
        ? `Fixture not found: ${fixtureName}`
        : 'No online smoke fixtures were found.',
    )
  }

  return fixtures
}

function createBaseModelOptions(
  options: OnlineSmokeOptions,
): OpenAICompatibleModelClientOptions {
  return {
    baseUrl: requireOption(
      options.modelBaseUrl,
      'missing_dependency missing modelBaseUrl / COMPUSER_MODEL_BASE_URL',
    ),
    apiKey: options.modelApiKey,
    model: requireOption(
      options.modelName,
      'missing_dependency missing modelName / COMPUSER_MODEL_NAME',
    ),
    temperature: options.modelTemperature,
    maxTokens: options.modelMaxTokens,
    timeoutMs: options.modelTimeoutMs,
    stream: options.modelStream,
    maxRetries: options.modelMaxRetries,
    retryDelayMs: options.modelRetryDelayMs,
    compatibilityMode: options.modelCompatibilityMode,
  }
}

function createOnlineSmokeContext(): AssembledContext {
  return {
    systemPrompt: 'You are the compuser online smoke harness.',
    toolCatalog: [
      {
        name: 'echo',
        description: 'Return the input text.',
        availability: 'core',
        searchHints: ['echo', 'text', 'test'],
        riskLevel: 'low',
        inputSchema: {
          description: 'echo input',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
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
      goal: 'provider online smoke',
      subgoal: 'issue live request',
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

async function runCompactSmoke(
  options: OpenAICompatibleModelClientOptions,
): Promise<void> {
  const client = new OpenAICompatibleModelClient(options)

  try {
    const result = await client.generateCompact({
      kind: 'full',
      messages: createCompactSmokeMessages(),
    })

    if (!result.summaryText.trim()) {
      throw new Error('compact summary was empty')
    }

    console.log('[pass] compact-call')
  } catch (error) {
    throw classifyProviderSmokeError(error)
  }
}

async function runSessionMemoryCompactSmoke(
  options: OpenAICompatibleModelClientOptions,
): Promise<void> {
  const client = new OpenAICompatibleModelClient(options)

  try {
    const result = await client.generateCompact({
      kind: 'session-memory',
      messages: createSessionMemoryCompactSmokeMessages(),
    })

    if (!result.summaryText.trim()) {
      throw new Error('session-memory compact summary was empty')
    }

    if (!Array.isArray(result.memoryFacts) || result.memoryFacts.length === 0) {
      throw new Error('session-memory compact returned no structured memory facts')
    }

    console.log('[pass] compact-session-memory-call')
  } catch (error) {
    throw classifyProviderSmokeError(error)
  }
}

async function assertProviderSmokePreconditions(baseUrl: string): Promise<void> {
  if (!baseUrl.trim()) {
    throw new Error('missing_dependency missing provider base URL')
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      await fetch(baseUrl, {
        method: 'GET',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    throw new Error(
      `transport_error provider endpoint unreachable: ${formatErrorMessage(error)}`,
    )
  }
}

function assertOnlineSmokeResult(
  result: ModelResponse,
  fixture: OnlineSmokeFixture,
): void {
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
}

function parseArgs(argv: string[]): OnlineSmokeOptions {
  const options: OnlineSmokeOptions = {
    fixtureName: process.env.COMPUSER_PROVIDER_ONLINE_FIXTURE,
    modelBaseUrl: process.env.COMPUSER_MODEL_BASE_URL,
    modelApiKey: process.env.COMPUSER_MODEL_API_KEY,
    modelName: process.env.COMPUSER_MODEL_NAME,
    modelTemperature: parseOptionalNumber(process.env.COMPUSER_MODEL_TEMPERATURE),
    modelMaxTokens: parseOptionalNumber(process.env.COMPUSER_MODEL_MAX_TOKENS),
    modelTimeoutMs: parseOptionalNumber(process.env.COMPUSER_MODEL_TIMEOUT_MS),
    modelStream: parseOptionalBoolean(process.env.COMPUSER_MODEL_STREAM),
    modelMaxRetries: parseOptionalNumber(process.env.COMPUSER_MODEL_MAX_RETRIES),
    modelRetryDelayMs: parseOptionalNumber(
      process.env.COMPUSER_MODEL_RETRY_DELAY_MS,
    ),
    modelCompatibilityMode: parseCompatibilityMode(
      process.env.COMPUSER_MODEL_COMPATIBILITY_MODE,
    ),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--fixture':
        options.fixtureName = argv[index + 1]
        index += 1
        break
      case '--model-base-url':
        options.modelBaseUrl = argv[index + 1]
        index += 1
        break
      case '--model-api-key':
        options.modelApiKey = argv[index + 1]
        index += 1
        break
      case '--model-name':
        options.modelName = argv[index + 1]
        index += 1
        break
      case '--model-temperature':
        options.modelTemperature = parseRequiredNumber(
          argv[index + 1],
          '--model-temperature',
        )
        index += 1
        break
      case '--model-max-tokens':
        options.modelMaxTokens = parseRequiredNumber(
          argv[index + 1],
          '--model-max-tokens',
        )
        index += 1
        break
      case '--model-timeout-ms':
        options.modelTimeoutMs = parseRequiredNumber(
          argv[index + 1],
          '--model-timeout-ms',
        )
        index += 1
        break
      case '--model-stream':
        options.modelStream = true
        break
      case '--model-max-retries':
        options.modelMaxRetries = parseRequiredNumber(
          argv[index + 1],
          '--model-max-retries',
        )
        index += 1
        break
      case '--model-retry-delay-ms':
        options.modelRetryDelayMs = parseRequiredNumber(
          argv[index + 1],
          '--model-retry-delay-ms',
        )
        index += 1
        break
      case '--model-compatibility-mode':
        options.modelCompatibilityMode = parseCompatibilityMode(argv[index + 1])
        index += 1
        break
      default:
        break
    }
  }

  return options
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }

  if (value === '1' || value.toLowerCase() === 'true') {
    return true
  }

  if (value === '0' || value.toLowerCase() === 'false') {
    return false
  }

  throw new Error(`Unable to parse boolean option: ${value}`)
}

function parseCompatibilityMode(
  value: string | undefined,
): OpenAICompatibleCompatibilityMode | undefined {
  if (
    value === 'strict' ||
    value === 'openai' ||
    value === 'ollama' ||
    value === 'generic'
  ) {
    return value
  }

  return undefined
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  if (Number.isNaN(parsed)) {
    throw new Error(`Unable to parse numeric option: ${value}`)
  }
  return parsed
}

function parseRequiredNumber(
  value: string | undefined,
  optionName: string,
): number {
  if (value === undefined) {
    throw new Error(`Missing required option: ${optionName}`)
  }

  return parseOptionalNumber(value) as number
}

function requireOption(value: string | undefined, errorMessage: string): string {
  if (!value) {
    throw new Error(errorMessage)
  }
  return value
}

function createCompactSmokeMessages(): QueryMessage[] {
  return [
    {
      role: 'user',
      content: 'Observe the current desktop, then summarize the current task chain.',
    },
    {
      role: 'assistant',
      content: 'I will inspect the desktop state first.',
    },
    {
      role: 'tool',
      toolName: 'windows.snapshot',
      content: JSON.stringify({
        toolName: 'windows.snapshot',
        ok: true,
        summary: 'snapshot ok',
        data: {
          focusedWindow: 'Notepad',
        },
      }),
    },
  ]
}

function createSessionMemoryCompactSmokeMessages(): QueryMessage[] {
  return [
    {
      role: 'user',
      content: 'Remember that the current target app is Notepad and prefer backend-first execution.',
    },
    {
      role: 'assistant',
      content: 'I will keep Notepad as the current target and prefer backend-first paths.',
    },
    {
      role: 'tool',
      toolName: 'command.desktop.capture_and_locate',
      content: JSON.stringify({
        toolName: 'command.desktop.capture_and_locate',
        ok: true,
        summary: 'located Notepad',
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: 'Notepad',
            lastVerifiedAnchor: 'window:Notepad',
            chainStatus: 'completed',
          },
        },
      }),
    },
  ]
}

function classifyProviderSmokeError(error: unknown): Error {
  if (error instanceof OpenAICompatibleRequestError) {
    return new Error(
      `provider_error code=${error.code} retryable=${error.retryable} status=${error.status ?? 'n/a'} message=${error.message}`,
    )
  }

  if (error instanceof Error) {
    if (
      error.message.startsWith('missing_dependency ') ||
      error.message.startsWith('transport_error ') ||
      error.message.startsWith('permission_blocked ') ||
      error.message.startsWith('verification_failed ')
    ) {
      return error
    }
    return new Error(`verification_failed ${error.message}`)
  }

  return new Error(`provider_error ${String(error)}`)
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

void main().catch(error => {
  if (error instanceof OpenAICompatibleRequestError) {
    console.error(
      `[model-error] code=${error.code} retryable=${error.retryable} status=${error.status ?? 'n/a'}`,
    )
  }
  console.error(classifyProviderSmokeError(error))
  process.exitCode = 1
})
