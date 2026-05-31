import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import {
  parseCliModelProvider,
  type CliModelProvider,
} from '../cli/cliApp.js'
import { PANEL_DEFAULT_PORT } from './defaults.js'

export interface WebPanelServerOptions {
  port: number
  windowsMcpEndpoint?: string
  permissionMode: PermissionMode
  defaultModelProvider: CliModelProvider
  modelBaseUrl?: string
  modelApiKey?: string
  modelName?: string
  modelTemperature?: number
  modelMaxTokens?: number
  modelTimeoutMs?: number
  modelStream?: boolean
  modelMaxRetries?: number
  modelRetryDelayMs?: number
  modelCompatibilityMode?: 'strict' | 'openai' | 'ollama' | 'generic'
}

export function parseWebPanelArgs(argv: string[]): WebPanelServerOptions {
  const options: WebPanelServerOptions = {
    port: PANEL_DEFAULT_PORT,
    windowsMcpEndpoint: process.env.COMPUSER_WINDOWS_MCP_ENDPOINT,
    permissionMode:
      parsePermissionMode(process.env.COMPUSER_PERMISSION_MODE) ?? 'default',
    defaultModelProvider: parseCliModelProvider(
      process.env.COMPUSER_MODEL_PROVIDER,
      'openai-compatible',
    ),
    modelBaseUrl: process.env.COMPUSER_MODEL_BASE_URL,
    modelApiKey: process.env.COMPUSER_MODEL_API_KEY,
    modelName: process.env.COMPUSER_MODEL_NAME,
    modelTemperature: parseOptionalNumber(
      process.env.COMPUSER_MODEL_TEMPERATURE,
    ),
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
      case '--port':
        options.port = Number(argv[index + 1] ?? PANEL_DEFAULT_PORT)
        index += 1
        break
      case '--windows-mcp-endpoint':
        options.windowsMcpEndpoint = argv[index + 1]
        index += 1
        break
      case '--permission-mode':
        options.permissionMode =
          parsePermissionMode(argv[index + 1]) ?? options.permissionMode
        index += 1
        break
      case '--model-provider':
        options.defaultModelProvider = parseCliModelProvider(
          argv[index + 1],
          options.defaultModelProvider,
        )
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
        options.modelCompatibilityMode =
          parseCompatibilityMode(argv[index + 1]) ??
          options.modelCompatibilityMode
        index += 1
        break
      default:
        break
    }
  }

  return options
}

function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (
    value === 'default' ||
    value === 'auto' ||
    value === 'confirm-high-risk' ||
    value === 'read-only'
  ) {
    return value
  }

  return undefined
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
): 'strict' | 'openai' | 'ollama' | 'generic' | undefined {
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
