import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { OpenAICompatibleRequestError } from '../../packages/core/ModelClient.js'
import type {
  PermissionMode,
  PermissionPrompt,
  PermissionRequest,
} from '../../packages/security/PermissionPolicy.js'
import {
  DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS,
  startPeriodicResultGc,
  type PeriodicResultGcController,
} from '../../packages/tools/runtime/ResultGcScheduler.js'
import { DEFAULT_RESULT_GC_POLICY } from '../../packages/tools/runtime/ToolResultStorage.js'
import {
  CLI_DEFAULT_SESSION_ID,
  CLI_WORKSPACE_ROOT,
  createCliApp,
  createCliModelOptions,
  parseCliModelProvider,
  type CliModelProvider,
  resolveWindowsMcpServiceStatus,
} from './cliApp.js'
import { getDefaultMemoryFilePath } from './workspaceRoot.js'

type DevOptions = {
  prompt: string
  windowsMcpEndpoint?: string
  launchWindowsMcp: boolean
  windowsMcpRepoPath?: string
  windowsMcpCommand?: string
  windowsMcpArgs?: string[]
  modelProvider: CliModelProvider
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
  permissionMode?: PermissionMode
  memoryFilePath?: string
  maxContextMessages?: number
  periodicResultGcEnabled: boolean
  periodicResultGcIntervalMs?: number
  resultGcStaleSessionAgeMs?: number
  resultGcMaxSessionDirs?: number
  resultGcMaxTotalBytes?: number
  resultGcPreserveRecentSessionCount?: number
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  let stopServer: (() => Promise<void>) | undefined
  let windowsMcpService: WindowsMcpService | undefined
  let periodicGc: PeriodicResultGcController | undefined

  try {
    let endpoint = options.windowsMcpEndpoint
    const configPath = resolve(
      CLI_WORKSPACE_ROOT,
      'memory',
      'windows-mcp-service.json',
    )

    if (options.launchWindowsMcp) {
      endpoint ??= DEFAULT_WINDOWS_MCP_ENDPOINT
      windowsMcpService = new WindowsMcpService({
        configPath,
        endpointUrl: endpoint,
        repoPath: options.windowsMcpRepoPath,
        command: options.windowsMcpCommand,
        args: options.windowsMcpArgs,
      })
      const status = await windowsMcpService.ensureReady({ launchIfNeeded: true })
      endpoint = status.endpointUrl
      stopServer = async () => {
        await windowsMcpService?.dispose()
      }
      console.log(`Windows-MCP ${status.state}: ${status.endpointUrl}`)
    } else if (endpoint) {
      windowsMcpService = new WindowsMcpService({
        configPath,
        endpointUrl: endpoint,
      })
      const status = await resolveWindowsMcpServiceStatus(windowsMcpService)
      if (status) {
        console.log(`Windows-MCP ${status.state}: ${status.endpointUrl}`)
      }
    }

    const app = createCliApp({
      windowsMcpEndpoint: endpoint,
      windowsMcpService,
      permissionMode: options.permissionMode,
      permissionPrompt: createPermissionPrompt(options.permissionMode),
      memoryFilePath: options.memoryFilePath,
      maxContextMessages: options.maxContextMessages,
      model: createCliModelOptions({
        provider: options.modelProvider,
        modelBaseUrl: options.modelBaseUrl,
        modelApiKey: options.modelApiKey,
        modelName: options.modelName,
        modelTemperature: options.modelTemperature,
        modelMaxTokens: options.modelMaxTokens,
        modelTimeoutMs: options.modelTimeoutMs,
        modelStream: options.modelStream,
        modelMaxRetries: options.modelMaxRetries,
        modelRetryDelayMs: options.modelRetryDelayMs,
        modelCompatibilityMode: options.modelCompatibilityMode,
      }),
    })

    if (options.periodicResultGcEnabled) {
      periodicGc = startPeriodicResultGc({
        baseDir: resolve(CLI_WORKSPACE_ROOT, 'artifacts', 'tool-results'),
        intervalMs:
          options.periodicResultGcIntervalMs ??
          DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS,
        policy: {
          staleSessionAgeMs:
            options.resultGcStaleSessionAgeMs ??
            DEFAULT_RESULT_GC_POLICY.staleSessionAgeMs,
          maxSessionDirs:
            options.resultGcMaxSessionDirs ??
            DEFAULT_RESULT_GC_POLICY.maxSessionDirs,
          maxTotalBytes:
            options.resultGcMaxTotalBytes ??
            DEFAULT_RESULT_GC_POLICY.maxTotalBytes,
          preserveRecentSessionCount:
            options.resultGcPreserveRecentSessionCount ??
            DEFAULT_RESULT_GC_POLICY.preserveRecentSessionCount,
          protectedSessionId: CLI_DEFAULT_SESSION_ID,
        },
        onSuccess(event) {
          if (event.plan.candidates.length === 0) {
            return
          }

          console.log(
            `[result-gc] trigger=${event.trigger} deleted=${event.plan.candidates.length} remaining=${event.plan.summary.totalSessionsAfter} bytes=${event.plan.summary.totalBytesAfter}`,
          )
        },
        onError(event) {
          console.error(
            `[result-gc] trigger=${event.trigger} error=${
              event.error instanceof Error ? event.error.message : String(event.error)
            }`,
          )
        },
      })
    }

    console.log(`Model provider: ${options.modelProvider}`)
    console.log(`Permission mode: ${options.permissionMode ?? 'default'}`)
    console.log(
      `Periodic result GC: ${options.periodicResultGcEnabled ? 'enabled' : 'disabled'}`,
    )
    const result = await app.submitUserMessage(options.prompt)
    console.log('--- final ---')
    console.log(result.finalText)
    console.log('--- messages ---')
    for (const message of result.messages) {
      console.log(`[${message.role}] ${message.content}`)
    }
  } finally {
    if (periodicGc) {
      await periodicGc.stop()
    }
    if (stopServer) {
      await stopServer()
    }
  }
}

export function parseArgs(argv: string[]): DevOptions {
  const options: DevOptions = {
    prompt: 'Summarize the current workspace state and suggest the safest next step.',
    launchWindowsMcp: false,
    modelProvider: parseCliModelProvider(
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
    permissionMode: parsePermissionMode(process.env.COMPUSER_PERMISSION_MODE),
    memoryFilePath:
      process.env.COMPUSER_MEMORY_FILE_PATH ??
      getDefaultMemoryFilePath(CLI_DEFAULT_SESSION_ID),
    maxContextMessages: parseOptionalNumber(
      process.env.COMPUSER_MAX_CONTEXT_MESSAGES,
    ),
    periodicResultGcEnabled: parseOptionalBoolean(
      process.env.COMPUSER_PERIODIC_RESULT_GC_ENABLED,
    ) ?? true,
    periodicResultGcIntervalMs: parseOptionalNumber(
      process.env.COMPUSER_PERIODIC_RESULT_GC_INTERVAL_MS,
    ),
    resultGcStaleSessionAgeMs: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_STALE_SESSION_AGE_MS,
    ),
    resultGcMaxSessionDirs: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_MAX_SESSION_DIRS,
    ),
    resultGcMaxTotalBytes: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_MAX_TOTAL_BYTES,
    ),
    resultGcPreserveRecentSessionCount: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_PRESERVE_RECENT_SESSION_COUNT,
    ),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--prompt':
        options.prompt = argv[index + 1] ?? options.prompt
        index += 1
        break
      case '--windows-mcp-endpoint':
        options.windowsMcpEndpoint = argv[index + 1]
        index += 1
        break
      case '--launch-windows-mcp':
        options.launchWindowsMcp = true
        break
      case '--windows-mcp-repo':
        options.windowsMcpRepoPath = argv[index + 1]
        index += 1
        break
      case '--windows-mcp-command':
        options.windowsMcpCommand = argv[index + 1]
        index += 1
        break
      case '--windows-mcp-args':
        options.windowsMcpArgs = (argv[index + 1] ?? '')
          .split(' ')
          .map(value => value.trim())
          .filter(Boolean)
        index += 1
        break
      case '--model-provider':
        options.modelProvider = parseCliModelProvider(
          argv[index + 1],
          options.modelProvider,
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
        options.modelCompatibilityMode = parseCompatibilityMode(argv[index + 1])
        index += 1
        break
      case '--permission-mode':
        options.permissionMode = parsePermissionMode(argv[index + 1])
        index += 1
        break
      case '--memory-file-path':
        options.memoryFilePath = argv[index + 1]
        index += 1
        break
      case '--max-context-messages':
        options.maxContextMessages = parseRequiredNumber(
          argv[index + 1],
          '--max-context-messages',
        )
        index += 1
        break
      case '--disable-periodic-result-gc':
        options.periodicResultGcEnabled = false
        break
      case '--periodic-result-gc-interval-ms':
        options.periodicResultGcIntervalMs = parseRequiredNumber(
          argv[index + 1],
          '--periodic-result-gc-interval-ms',
        )
        index += 1
        break
      case '--result-gc-stale-session-age-ms':
        options.resultGcStaleSessionAgeMs = parseRequiredNumber(
          argv[index + 1],
          '--result-gc-stale-session-age-ms',
        )
        index += 1
        break
      case '--result-gc-max-session-dirs':
        options.resultGcMaxSessionDirs = parseRequiredNumber(
          argv[index + 1],
          '--result-gc-max-session-dirs',
        )
        index += 1
        break
      case '--result-gc-max-total-bytes':
        options.resultGcMaxTotalBytes = parseRequiredNumber(
          argv[index + 1],
          '--result-gc-max-total-bytes',
        )
        index += 1
        break
      case '--result-gc-preserve-recent-session-count':
        options.resultGcPreserveRecentSessionCount = parseRequiredNumber(
          argv[index + 1],
          '--result-gc-preserve-recent-session-count',
        )
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

function parsePermissionMode(
  value: string | undefined,
): PermissionMode | undefined {
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

export function createPermissionPrompt(
  permissionMode: PermissionMode | undefined,
  askForPermission: ((promptText: string) => Promise<string>) | undefined = undefined,
): PermissionPrompt | undefined {
  if (permissionMode !== 'confirm-high-risk') {
    return undefined
  }

  const approvedTools = new Set<string>()
  const approvedRiskLevels = new Set<PermissionRequest['riskLevel']>()

  return {
    async confirm(request) {
      if (approvedTools.has(request.toolName)) {
        console.log(
          `[permission-confirm] tool already approved in this session: ${request.toolName}`,
        )
        return {
          approved: true,
          reason: `Tool already approved in this session: ${request.toolName}.`,
        }
      }

      if (approvedRiskLevels.has(request.riskLevel)) {
        console.log(
          `[permission-confirm] risk level already approved in this session: ${request.riskLevel}`,
        )
        return {
          approved: true,
          reason: `Risk level already approved in this session: ${request.riskLevel}.`,
        }
      }

      const rl = createInterface({ input, output })

      try {
        const promptText = [
          '',
          '[permission-confirm]',
          `tool=${request.toolName}`,
          `risk=${request.riskLevel}`,
          `declaredRisk=${request.declaredRiskLevel ?? request.riskLevel}`,
          `reason=${request.reasonText ?? request.reason}`,
          `riskReason=${request.riskReason ?? 'n/a'}`,
          `input=${JSON.stringify(request.input)}`,
          'Enter yes for one-time approval, tool to approve this tool for the session, risk to approve this risk level for the session, anything else to deny.',
        ].join('\n')

        const answer = askForPermission
          ? await askForPermission(promptText)
          : await rl.question(promptText)

        switch (answer.trim().toLowerCase()) {
          case 'yes':
            return {
              approved: true,
            }
          case 'tool':
            approvedTools.add(request.toolName)
            return {
              approved: true,
              reason: `Approved tool for this session: ${request.toolName}.`,
            }
          case 'risk':
            approvedRiskLevels.add(request.riskLevel)
            return {
              approved: true,
              reason: `Approved risk level for this session: ${request.riskLevel}.`,
            }
          default:
            return {
              approved: false,
              reason: `User denied tool execution: ${request.toolName}.`,
            }
        }
      } finally {
        rl.close()
      }
    },
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  void main().catch(error => {
    if (error instanceof OpenAICompatibleRequestError) {
      console.error(
        `[model-error] code=${error.code} retryable=${error.retryable} status=${error.status ?? 'n/a'}`,
      )
    }
    console.error(error)
    process.exitCode = 1
  })
}
