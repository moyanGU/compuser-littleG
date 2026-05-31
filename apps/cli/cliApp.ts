import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'
import { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { PowerShellCliBackendAdapter } from '../../packages/adapters/cli/CliBackendAdapter.js'
import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { StreamableHttpWindowsMcpBridge } from '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import {
  createCapabilityTools,
  isCapabilityToolName,
} from '../../packages/capabilities/CapabilityTools.js'
import {
  DemoModelClient,
  OpenAICompatibleModelClient,
  type OpenAICompatibleModelClientOptions,
} from '../../packages/core/ModelClient.js'
import { QueryEngine } from '../../packages/core/QueryEngine.js'
import { RuleBasedMicroCompactStrategy } from '../../packages/harness/compact/CompactStrategy.js'
import { ContextAssembler } from '../../packages/harness/context/ContextAssembler.js'
import {
  FileMemoryStore,
  InMemoryMemoryStore,
} from '../../packages/harness/memory/MemoryStore.js'
import type {
  PermissionMode,
  PermissionPrompt,
} from '../../packages/security/PermissionPolicy.js'
import {
  InMemoryToolRegistry,
  type ToolDefinition,
} from '../../packages/tools/Tool.js'
import { createResultPointerTools } from '../../packages/tools/ResultPointerTools.js'
import { createWorkspaceTools } from '../../packages/tools/WorkspaceTools.js'
import {
  createPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'

export { CLI_WORKSPACE_ROOT }
export const CLI_DEFAULT_SESSION_ID = 'local-dev-session'

export interface CliAppOptions {
  sessionId?: string
  windowsMcpEndpoint?: string
  windowsMcpService?: WindowsMcpService
  model?: CliModelOptions
  permissionMode?: PermissionMode
  permissionPrompt?: PermissionPrompt
  memoryFilePath?: string
  maxContextMessages?: number
  executionSignal?: AbortSignal
}

export type CliModelProvider = 'demo' | 'openai-compatible'

export type CliModelOptions =
  | {
      provider?: 'demo'
    }
  | {
      provider: 'openai-compatible'
      openaiCompatible: OpenAICompatibleModelClientOptions
    }

export function createCliApp(options: CliAppOptions = {}): QueryEngine {
  const registry = new InMemoryToolRegistry()
  const cliBackendAdapter = new PowerShellCliBackendAdapter()
  const modelClient = createModelClient(options.model)
  const windowsBridge = createWindowsMcpBridge(options)
  const windowsAdapter = new BridgeWindowsMcpAdapter(windowsBridge)
  const capabilityCatalog = new InMemoryCapabilityCatalog(
    createBuiltinCapabilities(),
  )

  const echoTool: ToolDefinition<{ text: string }, { echoed: string }> = {
    name: 'echo',
    availability: 'core',
    description: 'Echo text for simple tool-path smoke checks.',
    searchHints: ['echo', 'smoke', 'test', 'text'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'echo tool input',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    async execute(input) {
      return {
        ok: true,
        summary: `echo: ${input.text}`,
        data: { echoed: input.text },
      }
    },
  }

  registry.register(echoTool)
  registry.register(createToolSearchTool(registry))
  for (const tool of createResultPointerTools(CLI_WORKSPACE_ROOT)) {
    registry.register(tool)
  }
  for (const tool of createWorkspaceTools({ workspaceRoot: CLI_WORKSPACE_ROOT })) {
    registry.register(tool)
  }
  for (const tool of createWindowsMcpTools(windowsAdapter)) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(
    registry,
    createPermissionChecker(
      registry,
      options.permissionMode,
      options.permissionPrompt,
      {
        filesystemRoots: {
          workspaceRoot: CLI_WORKSPACE_ROOT,
          desktopRoot: resolve(homedir(), 'Desktop'),
        },
      },
    ),
    undefined,
    {
      beforeModelCall(payload) {
        console.log(
          `[hook:model] tools=${payload.toolCatalogSize} discoverable=${payload.discoverableToolCount} note=${payload.note ?? 'n/a'}`,
        )
      },
      beforeHttpRequest(payload) {
        console.log(
          `[hook:http] tool=${payload.call.toolName} turn=${payload.context.turnId} note=${payload.note ?? 'n/a'}`,
        )
      },
      afterToolCall(payload) {
        if (!payload.result) {
          return
        }

        const pointerNote = payload.result.pointer
          ? ` pointer=${payload.result.pointer}`
          : ''
        const failureNote = payload.result.failureClass
          ? ` failureClass=${payload.result.failureClass}`
          : ''

        console.log(
          `[hook:tool] tool=${payload.call.toolName} ok=${payload.result.ok}${failureNote}${pointerNote} summary=${payload.result.summary}`,
        )
      },
    },
  )

  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
    cliAdapter: cliBackendAdapter,
  })) {
    registry.register(tool)
  }

  return new QueryEngine({
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: options.sessionId ?? CLI_DEFAULT_SESSION_ID,
    baseSystemPrompt:
      'You are compuser, a Windows desktop task orchestration agent that prefers backend-first execution, explicit verification, and safe fallback behavior.',
    modelClient,
    registry,
    runtime,
    contextAssembler: new ContextAssembler(),
    memoryStore: options.memoryFilePath
      ? new FileMemoryStore(options.memoryFilePath)
      : new InMemoryMemoryStore(),
    capabilityCatalog,
    compactStrategy: new RuleBasedMicroCompactStrategy({
      modelInvoker:
        typeof modelClient.generateCompact === 'function'
          ? {
              sessionMemoryCompact(messages) {
                return modelClient.generateCompact!({
                  kind: 'session-memory',
                  messages,
                })
              },
              fullCompact(messages) {
                return modelClient.generateCompact!({
                  kind: 'full',
                  messages,
                })
              },
            }
          : undefined,
    }),
    maxTurns: 6,
    maxContextMessages: options.maxContextMessages ?? 12,
  })
}

export async function resolveWindowsMcpServiceStatus(
  service: WindowsMcpService | undefined,
): Promise<ReturnType<WindowsMcpService['getStatus']> | undefined> {
  if (!service) {
    return undefined
  }

  return await service.healthcheck()
}

function createModelClient(model: CliModelOptions | undefined) {
  if (model?.provider === 'openai-compatible') {
    return new OpenAICompatibleModelClient(model.openaiCompatible)
  }

  return new DemoModelClient()
}

export function parseCliModelProvider(
  value: string | undefined,
  fallback: CliModelProvider = 'demo',
): CliModelProvider {
  if (value === 'demo' || value === 'openai-compatible') {
    return value
  }

  return fallback
}

export function createCliModelOptions(input: {
  provider: CliModelProvider
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
}): CliModelOptions {
  if (input.provider === 'openai-compatible') {
    return {
      provider: 'openai-compatible',
      openaiCompatible: {
        baseUrl: requireCliOption(
          input.modelBaseUrl,
          'missing_dependency missing modelBaseUrl / COMPUSER_MODEL_BASE_URL',
        ),
        apiKey: input.modelApiKey,
        model: requireCliOption(
          input.modelName,
          'missing_dependency missing modelName / COMPUSER_MODEL_NAME',
        ),
        temperature: input.modelTemperature,
        maxTokens: input.modelMaxTokens,
        timeoutMs: input.modelTimeoutMs,
        stream: input.modelStream,
        maxRetries: input.modelMaxRetries,
        retryDelayMs: input.modelRetryDelayMs,
        compatibilityMode: input.modelCompatibilityMode,
      },
    }
  }

  return {
    provider: 'demo',
  }
}

export function createWindowsMcpBridge(
  options: Pick<CliAppOptions, 'windowsMcpEndpoint' | 'windowsMcpService'> = {},
) {
  const windowsMcpEndpoint =
    options.windowsMcpEndpoint ??
    options.windowsMcpService?.getStatus().endpointUrl ??
    DEFAULT_WINDOWS_MCP_ENDPOINT

  return new StreamableHttpWindowsMcpBridge(windowsMcpEndpoint)
}

function requireCliOption(
  value: string | undefined,
  errorMessage: string,
): string {
  if (!value) {
    throw new Error(errorMessage)
  }

  return value
}

function createToolSearchTool(registry: InMemoryToolRegistry): ToolDefinition<{
  query: string
  limit?: number
  includeCore?: boolean
}> {
  return {
    name: 'tools.search',
    availability: 'core',
    description: 'Search discoverable tools and reveal their callable schemas before use.',
    searchHints: ['tools', 'discoverable', 'search', 'schema', 'catalog'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'tool search input',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        includeCore: { type: 'boolean' },
      },
      required: ['query'],
    },
    async execute(input) {
      const normalizedQuery = input.query.trim()
      const includeCore = input.includeCore === true
      const limit =
        typeof input.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(20, Math.floor(input.limit)))
          : 8

      const candidates = registry
        .list()
        .filter(
          tool =>
            !isCapabilityToolName(tool.name) &&
            (includeCore || (tool.availability ?? 'core') === 'discoverable'),
        )
        .map(tool => ({
          tool,
          score: scoreSearchableTool(normalizedQuery, tool),
        }))
        .filter(candidate => candidate.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(candidate => ({
          name: candidate.tool.name,
          description: candidate.tool.description,
          availability: candidate.tool.availability ?? 'core',
          searchHints:
            candidate.tool.searchHints && candidate.tool.searchHints.length > 0
              ? candidate.tool.searchHints
              : candidate.tool.searchHint
                ? [candidate.tool.searchHint]
                : [],
          riskLevel: candidate.tool.riskLevel,
          inputSchema: candidate.tool.inputSchema,
          resultPolicy: candidate.tool.resultPolicy,
          permissionProfile: candidate.tool.permissionProfile,
        }))

      return {
        ok: true,
        summary: candidates.length
          ? `Found ${candidates.length} tool definitions.`
          : 'No matching tools found.',
        data: {
          query: normalizedQuery,
          matches: candidates,
        },
      }
    },
  }
}

function scoreSearchableTool(
  query: string,
  tool: ReturnType<InMemoryToolRegistry['list']>[number],
): number {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return 1
  }

  const fields = [
    tool.name,
    tool.description,
    ...(tool.searchHints ?? tool.searchHint ? [tool.searchHint ?? '', ...(tool.searchHints ?? [])] : []),
  ]
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  let score = 0

  for (const field of fields) {
    const normalizedField = field.toLowerCase()
    if (normalizedField.includes(normalizedQuery)) {
      score += 5
    }

    for (const token of tokens) {
      if (normalizedField.includes(token)) {
        score += 2
      }
    }
  }

  return score
}
