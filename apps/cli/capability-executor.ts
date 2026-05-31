import type {
  CapabilityCatalogItem,
  CapabilityChainState,
  CapabilityToolData,
} from '../../packages/capabilities/Capability.js'
import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import type { ToolContext } from '../../packages/tools/Tool.js'
import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import {
  CLI_WORKSPACE_ROOT,
} from './cliApp.js'
import {
  createCliCapabilityRuntimeEnvironment,
} from './capability-runtime.js'
import { ensureWindowsMcpReady } from './windowsMcpRuntime.js'

export const CAPABILITY_EXECUTOR_DEFAULT_SESSION_ID = 'external-capability-cli'

export const CAPABILITY_EXECUTOR_ALLOWLIST = new Set<string>([
  'skill.desktop.observe',
  'command.app.open_or_focus',
  'command.desktop.capture_and_locate',
  'command.clipboard.read_write',
  'command.browser.inspect_dom',
  'skill.browser.click_element_by_name',
  'skill.browser.type_element_by_name',
  'skill.cross_app.transfer_text',
  'skill.file.send_to_chat_window',
  'skill.cross_app.open_observe_act_verify',
])

export type ExposedCallableKind = 'capability'

export interface ExecutionDescriptor {
  name: string
  kind: ExposedCallableKind
  description: string
  availability: 'core' | 'discoverable'
  riskLevel: 'low' | 'medium' | 'high'
  inputSchema: {
    description: string
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface ExecutionRequest {
  name: string
  kind: ExposedCallableKind
  input: Record<string, unknown>
  sessionId: string
  turnId: string
  cwd: string
  signal?: AbortSignal
}

export interface ExecutionResult {
  ok: boolean
  summary: string
  error?: string
  failureClass?: string
  route?: 'cli' | 'api' | 'backend' | 'tool'
  verification?: {
    strategy: string
    passed: boolean
    details: string
  }
  operations?: Array<{
    type: 'tool' | 'cli'
    target: string
    ok: boolean
    summary: string
  }>
  chainState?: CapabilityChainState
  recoveryPoint?: string
  recoveryAction?: string
  recoveryUsed?: boolean
  verificationEvidence?: string[]
  output?: unknown
  pointer?: string
  sessionId: string
  turnId: string
  data?: unknown
}

export interface ExecutionFacade {
  list(query?: string, limit?: number): ExecutionDescriptor[]
  search(query: string, options?: { limit?: number }): ExecutionDescriptor[]
  execute(request: ExecutionRequest): Promise<ExecutionResult>
}

export type CapabilityExecutorOptions = {
  sessionId?: string
  turnId?: string
  cwd?: string
  windowsMcpEndpoint?: string
  windowsMcpService?: WindowsMcpService
  permissionMode?: PermissionMode
  launchWindowsMcp?: boolean
}

export type CapabilityExecutorResult = ExecutionResult

export type CapabilityExecutorHandle = ExecutionFacade & {
  sessionId: string
  turnId: string
  listCapabilities(query?: string, limit?: number): CapabilityCatalogItem[]
  executeCapability(
    capabilityName: string,
    input: Record<string, unknown>,
  ): Promise<CapabilityExecutorResult>
  dispose(): Promise<void>
}

export function createCapabilityExecutor(
  options: CapabilityExecutorOptions = {},
): CapabilityExecutorHandle {
  const sessionId =
    options.sessionId ?? CAPABILITY_EXECUTOR_DEFAULT_SESSION_ID
  const runtimeEnvironment = createCliCapabilityRuntimeEnvironment({
    windowsMcpEndpoint: options.windowsMcpEndpoint,
    windowsMcpService: options.windowsMcpService,
    permissionMode: options.permissionMode,
  })
  let turnCounter = 0
  let windowsHandle:
    | Awaited<ReturnType<typeof ensureWindowsMcpReady>>
    | undefined
  let ownsWindowsHandle = false

  const resolveTurnId = () => {
    turnCounter += 1
    return options.turnId ?? `turn-${String(turnCounter)}`
  }

  const toDescriptors = (items: CapabilityCatalogItem[]): ExecutionDescriptor[] =>
    items.map(item => ({
      name: item.toolName,
      kind: 'capability',
      description: item.description,
      availability: item.availability,
      riskLevel: item.riskLevel,
      inputSchema: item.inputSchema,
    }))

  const listCapabilities = (query?: string, limit?: number) => {
    const normalizedLimit =
      typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(1, Math.min(50, Math.floor(limit)))
        : undefined
    const normalizedQuery = typeof query === 'string' ? query.trim() : ''
    const items = normalizedQuery
      ? runtimeEnvironment.capabilityCatalog.search(
          normalizedQuery,
          normalizedLimit ?? 20,
        )
      : runtimeEnvironment.capabilityCatalog.list()

    return items
      .filter(item => CAPABILITY_EXECUTOR_ALLOWLIST.has(item.toolName))
      .slice(0, normalizedLimit ?? items.length)
  }

  const ensureReady = async () => {
    if (windowsHandle) {
      return windowsHandle
    }

    if (options.windowsMcpService) {
      const status = await options.windowsMcpService.ensureReady({
        launchIfNeeded: options.launchWindowsMcp === true,
      })
      if (status.state !== 'ready') {
        const prefix =
          status.state === 'degraded'
            ? 'missing_dependency'
            : status.state === 'disconnected'
              ? 'transport_error'
              : 'provider_error'
        throw new Error(`${prefix} Windows-MCP endpoint not ready: ${status.detail}`)
      }
      ownsWindowsHandle = false
      return undefined
    }

    windowsHandle = await ensureWindowsMcpReady({
      endpoint: options.windowsMcpEndpoint,
      launchIfNeeded: options.launchWindowsMcp === true,
    })
    ownsWindowsHandle = true
    return windowsHandle
  }

  const facade: CapabilityExecutorHandle = {
    sessionId,
    get turnId() {
      return options.turnId ?? `turn-${String(Math.max(turnCounter, 1))}`
    },
    list(query?: string, limit?: number) {
      return toDescriptors(listCapabilities(query, limit))
    },
    search(query: string, searchOptions?: { limit?: number }) {
      return toDescriptors(listCapabilities(query, searchOptions?.limit))
    },
    listCapabilities,
    async execute(request) {
      if (request.kind !== 'capability') {
        return {
          ok: false,
          summary: `Unsupported callable kind: ${request.kind}`,
          error: 'UNSUPPORTED_CALLABLE_KIND',
          failureClass: 'deterministic',
          sessionId: request.sessionId,
          turnId: request.turnId,
        }
      }

      if (!CAPABILITY_EXECUTOR_ALLOWLIST.has(request.name)) {
        return {
          ok: false,
          summary: `Capability not exposed by external executor: ${request.name}`,
          error: 'CAPABILITY_NOT_EXPOSED',
          failureClass: 'missing_dependency',
          sessionId: request.sessionId,
          turnId: request.turnId,
        }
      }

      await ensureReady()

      const result = await runtimeEnvironment.runtime.execute(
        {
          toolName: request.name,
          input: request.input,
        },
        {
          cwd: request.cwd,
          sessionId: request.sessionId,
          turnId: request.turnId,
          signal: request.signal,
        } satisfies ToolContext,
      )

      const data = readCapabilityToolData(result.data)
      const verification = data?.verification
      const verificationPassed = verification?.passed === true
      const ok = result.ok && verificationPassed

      return {
        ok,
        summary: result.summary,
        error: result.error,
        failureClass: data?.failureClass ?? result.failureClass,
        route: data?.route,
        verification: verification ?? {
          strategy: 'capability-execution',
          passed: false,
          details: result.error ?? result.summary,
        },
        operations: data?.operations ?? [],
        chainState: data?.chainState,
        recoveryPoint: data?.recoveryPoint,
        recoveryAction: data?.recoveryAction,
        recoveryUsed: data?.recoveryUsed ?? false,
        verificationEvidence: data?.verificationEvidence ?? [],
        output: data?.output,
        pointer: result.pointer,
        sessionId: data?.sessionId ?? request.sessionId,
        turnId: data?.turnId ?? request.turnId,
        data: result.data,
      }
    },
    async executeCapability(capabilityName, input) {
      return await facade.execute({
        name: capabilityName,
        kind: 'capability',
        input,
        cwd: options.cwd ?? CLI_WORKSPACE_ROOT,
        sessionId,
        turnId: resolveTurnId(),
      })
    },
    async dispose() {
      if (ownsWindowsHandle) {
        await windowsHandle?.dispose()
      }
    },
  }

  return facade
}

function readCapabilityToolData(
  value: unknown,
): CapabilityToolData<unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const candidate = value as { capabilityId?: unknown }
  return typeof candidate.capabilityId === 'string'
    ? (value as CapabilityToolData<unknown>)
    : undefined
}
