import { parseWebPanelArgs } from './serverOptions.js'

async function main(): Promise<void> {
  await testDefaultModelProviderFallsBackToOpenAiCompatible()
  await testExplicitModelProviderOverrideStillWorks()
  console.log('server-options-regression ok')
}

async function testDefaultModelProviderFallsBackToOpenAiCompatible(): Promise<void> {
  const originalProvider = process.env.COMPUSER_MODEL_PROVIDER
  const originalBaseUrl = process.env.COMPUSER_MODEL_BASE_URL
  const originalModelName = process.env.COMPUSER_MODEL_NAME

  try {
    delete process.env.COMPUSER_MODEL_PROVIDER
    delete process.env.COMPUSER_MODEL_BASE_URL
    delete process.env.COMPUSER_MODEL_NAME

    const options = parseWebPanelArgs([])
    assert(
      options.defaultModelProvider === 'openai-compatible',
      'server options should default to openai-compatible when provider is unset',
    )
  } finally {
    restoreEnv('COMPUSER_MODEL_PROVIDER', originalProvider)
    restoreEnv('COMPUSER_MODEL_BASE_URL', originalBaseUrl)
    restoreEnv('COMPUSER_MODEL_NAME', originalModelName)
  }
}

async function testExplicitModelProviderOverrideStillWorks(): Promise<void> {
  const originalProvider = process.env.COMPUSER_MODEL_PROVIDER

  try {
    process.env.COMPUSER_MODEL_PROVIDER = 'demo'
    const options = parseWebPanelArgs([])
    assert(
      options.defaultModelProvider === 'demo',
      'server options should still honor explicit provider override',
    )
  } finally {
    restoreEnv('COMPUSER_MODEL_PROVIDER', originalProvider)
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = value
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
