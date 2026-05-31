import { fileURLToPath } from 'node:url'
import type { CapabilityToolData } from '../../packages/capabilities/Capability.js'
import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import {
  CAPABILITY_EXECUTOR_ALLOWLIST,
  createCapabilityExecutor,
} from './capability-executor.js'

const EXIT_CODE_SUCCESS = 0
const EXIT_CODE_INTERNAL_ERROR = 1
const EXIT_CODE_EXECUTION_FAILED = 2
const EXIT_CODE_INVALID_REQUEST = 3
const EXIT_CODE_WINDOWS_MCP_UNAVAILABLE = 4

type CliCommand =
  | {
      kind: 'list-capabilities'
      query?: string
      limit?: number
    }
    | {
        kind: 'list-windows'
        windowsMcpEndpoint?: string
        launchWindowsMcp?: boolean
        permissionMode?: PermissionMode
      }
    | {
        kind: 'run-capability'
        name: string
        input: Record<string, unknown>
        sessionId?: string
        turnId?: string
        cwd?: string
        windowsMcpEndpoint?: string
        launchWindowsMcp?: boolean
        permissionMode?: PermissionMode
      }

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2))
  const executor = createCapabilityExecutor(
    command.kind === 'run-capability' || command.kind === 'list-windows'
        ? {
            sessionId: command.kind === 'run-capability' ? command.sessionId : undefined,
            turnId: command.kind === 'run-capability' ? command.turnId : undefined,
            cwd: command.kind === 'run-capability' ? command.cwd : undefined,
            windowsMcpEndpoint: command.windowsMcpEndpoint,
            launchWindowsMcp: command.launchWindowsMcp,
            permissionMode: command.permissionMode,
          }
        : {},
  )

  try {
    if (command.kind === 'list-capabilities') {
      const items = executor.listCapabilities(command.query, command.limit)
      writeJson(
        {
          ok: true,
          summary: `Found ${items.length} capabilities.`,
          capabilities: items.map(item => ({
            name: item.toolName,
            description: item.description,
            availability: item.availability,
            riskLevel: item.riskLevel,
            inputSchema: item.inputSchema,
          })),
        },
        EXIT_CODE_SUCCESS,
      )
      return
    }

    if (command.kind === 'list-windows') {
      const result = await executor.executeCapability('skill.desktop.observe', {})
      const payload = normalizeResult(result, 'skill.desktop.observe')
      const windows = readObservedWindows(payload.output)
      writeJson(
        {
          ok: payload.ok,
          capability: 'skill.desktop.observe',
          summary: payload.summary,
          windows,
          focusedWindow: readObservedFocusedWindow(payload.output),
          verification: payload.verification,
          verificationEvidence: payload.verificationEvidence,
        },
        resolveRunExitCode(payload),
      )
      return
    }

    if (!CAPABILITY_EXECUTOR_ALLOWLIST.has(command.name)) {
      writeJson(
        {
          ok: false,
          capability: command.name,
          error: `Capability is not exposed by this CLI: ${command.name}`,
          summary: 'Invalid capability CLI request.',
          exitCode: EXIT_CODE_INVALID_REQUEST,
        },
        EXIT_CODE_INVALID_REQUEST,
      )
      return
    }

    const result = await executor.executeCapability(command.name, command.input)
    const payload = normalizeResult(result, command.name)
    writeJson(payload, resolveRunExitCode(payload))
  } finally {
    await executor.dispose()
  }
}

function normalizeResult(
  result: Awaited<
    ReturnType<ReturnType<typeof createCapabilityExecutor>['executeCapability']>
  >,
  capabilityName: string,
) {
  const data = readCapabilityToolData(result.data)
  const verification = data?.verification ?? {
    strategy: 'capability-cli',
    passed: false,
    details: result.error ?? result.summary,
  }
  const ok = result.ok && verification.passed

  return {
    ok,
    capability: capabilityName,
    summary: result.summary,
    error: result.error,
    failureClass: data?.failureClass ?? result.failureClass,
    failureReason: data?.failureReason,
    route: data?.route,
    verification,
    operations: data?.operations ?? [],
    chainState: data?.chainState,
    recoveryPoint: data?.recoveryPoint,
    recoveryAction: data?.recoveryAction,
    recoveryUsed: data?.recoveryUsed ?? false,
    verificationEvidence: data?.verificationEvidence ?? [],
    routingPolicy: data?.routingPolicy ?? [],
    sessionId: data?.sessionId,
    turnId: data?.turnId,
    output: data?.output ?? result.output,
  }
}

function readCapabilityToolData(
  value: unknown,
): CapabilityToolData<unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as { capabilityId?: unknown }
  return typeof candidate.capabilityId === 'string'
    ? (value as CapabilityToolData<unknown>)
    : undefined
}

function resolveRunExitCode(payload: {
  ok: boolean
  error?: string
  failureClass?: string
}): number {
  if (payload.ok) {
    return EXIT_CODE_SUCCESS
  }

  if (
    payload.error === 'CAPABILITY_NOT_FOUND' ||
    payload.error === 'CAPABILITY_NOT_EXPOSED'
  ) {
    return EXIT_CODE_INVALID_REQUEST
  }

  if (payload.failureClass === 'missing_dependency') {
    return EXIT_CODE_WINDOWS_MCP_UNAVAILABLE
  }

  return EXIT_CODE_EXECUTION_FAILED
}

function parseArgs(argv: string[]): CliCommand {
  const subcommand = argv[0]

  if (subcommand === 'list-capabilities') {
    let query: string | undefined
    let limit: number | undefined

    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index]
      switch (arg) {
        case '--query':
          query = requireOptionValue(argv[index + 1], '--query')
          index += 1
          break
        case '--limit':
          limit = parseOptionalNumber(
            requireOptionValue(argv[index + 1], '--limit'),
            '--limit',
          )
          index += 1
          break
        case '--json':
          break
        default:
          throw new CliUsageError(`Unknown option for list-capabilities: ${arg}`)
      }
    }

    return {
      kind: 'list-capabilities',
      query,
      limit,
    }
  }

  if (subcommand === 'run-capability') {
    let name: string | undefined
      let inputJson: string | undefined
      let sessionId: string | undefined
      let turnId: string | undefined
      let cwd: string | undefined
      let windowsMcpEndpoint: string | undefined
      let launchWindowsMcp = false
      let permissionMode: PermissionMode | undefined

    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index]
      switch (arg) {
        case '--name':
          name = requireOptionValue(argv[index + 1], '--name')
          index += 1
          break
        case '--input-json':
          inputJson = requireOptionValue(argv[index + 1], '--input-json')
          index += 1
          break
        case '--session-id':
          sessionId = requireOptionValue(argv[index + 1], '--session-id')
          index += 1
          break
        case '--turn-id':
          turnId = requireOptionValue(argv[index + 1], '--turn-id')
          index += 1
          break
        case '--cwd':
          cwd = requireOptionValue(argv[index + 1], '--cwd')
          index += 1
          break
        case '--windows-mcp-endpoint':
          windowsMcpEndpoint = requireOptionValue(
            argv[index + 1],
            '--windows-mcp-endpoint',
          )
          index += 1
          break
        case '--launch-windows-mcp':
          launchWindowsMcp = true
          break
        case '--permission-mode':
          permissionMode = parsePermissionMode(
            requireOptionValue(argv[index + 1], '--permission-mode'),
          )
          if (!permissionMode) {
            throw new CliUsageError(
              'permission mode must be one of: default, auto, confirm-high-risk, read-only',
            )
          }
          index += 1
          break
        case '--json':
          break
        default:
          throw new CliUsageError(`Unknown option for run-capability: ${arg}`)
      }
    }

    if (!name) {
      throw new CliUsageError('Missing required option: --name')
    }

    return {
      kind: 'run-capability',
      name,
      input: parseJsonObject(inputJson),
      sessionId,
      turnId,
      cwd,
      windowsMcpEndpoint,
      launchWindowsMcp,
      permissionMode,
    }
  }

  if (subcommand === 'list-windows') {
    let windowsMcpEndpoint: string | undefined
    let launchWindowsMcp = false
    let permissionMode: PermissionMode | undefined

    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index]
      switch (arg) {
        case '--windows-mcp-endpoint':
          windowsMcpEndpoint = requireOptionValue(
            argv[index + 1],
            '--windows-mcp-endpoint',
          )
          index += 1
          break
        case '--launch-windows-mcp':
          launchWindowsMcp = true
          break
        case '--permission-mode':
          permissionMode = parsePermissionMode(
            requireOptionValue(argv[index + 1], '--permission-mode'),
          )
          if (!permissionMode) {
            throw new CliUsageError(
              'permission mode must be one of: default, auto, confirm-high-risk, read-only',
            )
          }
          index += 1
          break
        case '--json':
          break
        default:
          throw new CliUsageError(`Unknown option for list-windows: ${arg}`)
      }
    }

    return {
      kind: 'list-windows',
      windowsMcpEndpoint,
      launchWindowsMcp,
      permissionMode,
    }
  }

  throw new CliUsageError(
    'Missing required command: list-capabilities, list-windows, or run-capability',
  )
}

function readObservedWindows(output: unknown): string[] {
  if (typeof output !== 'object' || output === null) {
    return []
  }

  const observation = (output as { observation?: unknown }).observation
  if (typeof observation !== 'object' || observation === null) {
    return []
  }

  const windows = (observation as { windows?: unknown }).windows
  return Array.isArray(windows)
    ? windows.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
}

function readObservedFocusedWindow(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) {
    return undefined
  }

  const observation = (output as { observation?: unknown }).observation
  if (typeof observation !== 'object' || observation === null) {
    return undefined
  }

  const focusedWindow = (observation as { focusedWindow?: unknown }).focusedWindow
  return typeof focusedWindow === 'string' && focusedWindow.trim()
    ? focusedWindow.trim()
    : undefined
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) {
    throw new CliUsageError('Missing required option: --input-json')
  }

  try {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CliUsageError('--input-json must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error
    }
    const recovered = tryParsePowerShellObjectLiteral(value)
    if (recovered) {
      return recovered
    }
    throw new CliUsageError('--input-json is not valid JSON')
  }
}

function tryParsePowerShellObjectLiteral(
  value: string,
): Record<string, unknown> | undefined {
  const trimmed = value.trim()
  if (
    !trimmed.startsWith('{') ||
    !trimmed.endsWith('}') ||
    trimmed.includes('"')
  ) {
    return undefined
  }

  const body = trimmed.slice(1, -1).trim()
  if (!body) {
    return {}
  }

  const entries = body.split(',').map(part => part.trim())
  const result: Record<string, unknown> = {}

  for (const entry of entries) {
    const separatorIndex = entry.indexOf(':')
    if (separatorIndex <= 0) {
      return undefined
    }

    const key = entry.slice(0, separatorIndex).trim()
    const rawValue = entry.slice(separatorIndex + 1).trim()
    if (!key) {
      return undefined
    }

    const normalizedKey = key.replace(/^['"]|['"]$/g, '')
    if (!normalizedKey) {
      return undefined
    }

    result[normalizedKey] = parsePowerShellLiteralValue(rawValue)
  }

  return result
}

function parsePowerShellLiteralValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed === 'true') {
    return true
  }

  if (trimmed === 'false') {
    return false
  }

  if (trimmed === 'null') {
    return null
  }

  const numericValue = Number(trimmed)
  if (trimmed !== '' && Number.isFinite(numericValue)) {
    return numericValue
  }

  return trimmed.replace(/^['"]|['"]$/g, '')
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
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

function parseOptionalNumber(value: string, optionName: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${optionName} must be a number`)
  }
  return Math.floor(parsed)
}

function requireOptionValue(
  value: string | undefined,
  optionName: string,
): string {
  if (!value || !value.trim()) {
    throw new CliUsageError(`${optionName} requires a value`)
  }

  return value
}

function writeJson(payload: unknown, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exitCode = exitCode
}

class CliUsageError extends Error {}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  void main().catch(error => {
    if (error instanceof CliUsageError) {
      writeJson(
        {
          ok: false,
          error: error.message,
          summary: 'Invalid capability CLI request.',
          exitCode: EXIT_CODE_INVALID_REQUEST,
        },
        EXIT_CODE_INVALID_REQUEST,
      )
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    const windowsUnavailable =
      message.startsWith('missing_dependency ') ||
      message.startsWith('transport_error ') ||
      message.startsWith('provider_error ')

    writeJson(
      {
        ok: false,
        error: message,
        summary: windowsUnavailable
          ? 'Windows-MCP is not ready.'
          : 'Capability CLI internal error.',
        exitCode: windowsUnavailable
          ? EXIT_CODE_WINDOWS_MCP_UNAVAILABLE
          : EXIT_CODE_INTERNAL_ERROR,
      },
      windowsUnavailable
        ? EXIT_CODE_WINDOWS_MCP_UNAVAILABLE
        : EXIT_CODE_INTERNAL_ERROR,
    )
  })
}
