import { createCliModelOptions } from './cliApp.js'
import { parseArgs } from './dev.js'

async function main(): Promise<void> {
  verifyDefaultProviderUsesOpenAICompatible()
  verifyExplicitDemoProviderStillWorks()
  verifyMissingRealProviderConfigFailsClearly()
  console.log('dev-regression ok')
}

function verifyDefaultProviderUsesOpenAICompatible(): void {
  withEnv(
    {
      COMPUSER_MODEL_PROVIDER: undefined,
      COMPUSER_MODEL_BASE_URL: undefined,
      COMPUSER_MODEL_API_KEY: undefined,
      COMPUSER_MODEL_NAME: undefined,
    },
    () => {
      const options = parseArgs([])
      assert(
        options.modelProvider === 'openai-compatible',
        `Expected default provider to be openai-compatible, received ${options.modelProvider}.`,
      )
    },
  )
}

function verifyExplicitDemoProviderStillWorks(): void {
  withEnv(
    {
      COMPUSER_MODEL_PROVIDER: 'demo',
      COMPUSER_MODEL_BASE_URL: undefined,
      COMPUSER_MODEL_API_KEY: undefined,
      COMPUSER_MODEL_NAME: undefined,
    },
    () => {
      const options = parseArgs([])
      assert(
        options.modelProvider === 'demo',
        `Expected explicit demo provider to remain demo, received ${options.modelProvider}.`,
      )
      const model = createCliModelOptions({
        provider: options.modelProvider,
      })
      assert(
        model.provider === 'demo',
        `Expected demo model options to remain demo, received ${model.provider}.`,
      )
    },
  )
}

function verifyMissingRealProviderConfigFailsClearly(): void {
  withEnv(
    {
      COMPUSER_MODEL_PROVIDER: undefined,
      COMPUSER_MODEL_BASE_URL: undefined,
      COMPUSER_MODEL_API_KEY: undefined,
      COMPUSER_MODEL_NAME: 'gpt-5.4-mini',
    },
    () => {
      const options = parseArgs([])
      let caught: unknown

      try {
        createCliModelOptions({
          provider: options.modelProvider,
          modelBaseUrl: options.modelBaseUrl,
          modelApiKey: options.modelApiKey,
          modelName: options.modelName,
        })
      } catch (error) {
        caught = error
      }

      assert(caught instanceof Error, 'Expected missing real provider config to throw.')
      assert(
        caught.message ===
          'missing_dependency missing modelBaseUrl / COMPUSER_MODEL_BASE_URL',
        `Expected missing_dependency error, received ${caught.message}.`,
      )
    },
  )
}

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void,
): void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }

  try {
    run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
        continue
      }
      process.env[key] = value
    }
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
