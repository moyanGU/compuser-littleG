import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DemoModelClient } from '../../packages/core/ModelClient.js'
import { QueryEngine } from '../../packages/core/QueryEngine.js'
import {
  type CapabilityDefinition,
  type CapabilityExecutionResult,
} from '../../packages/capabilities/Capability.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import {
  createCapabilityTools,
  isCapabilityToolName,
} from '../../packages/capabilities/CapabilityTools.js'
import { ContextAssembler } from '../../packages/harness/context/ContextAssembler.js'
import { InMemoryMemoryStore } from '../../packages/harness/memory/MemoryStore.js'
import {
  InMemoryToolRegistry,
  type ToolDefinition,
} from '../../packages/tools/Tool.js'
import {
  AllowAllPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'compuser-capability-'))

  try {
    const registry = new InMemoryToolRegistry()
    const capabilities = [
      ...createBuiltinCapabilities(),
      createHiddenEchoCapability(),
    ]
    const capabilityCatalog = new InMemoryCapabilityCatalog(capabilities)
    const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

    registry.register(createToolSearchTool(registry))
    for (const tool of createCapabilityTools({
      catalog: capabilityCatalog,
      runtime,
    })) {
      registry.register(tool)
    }

    const engine = new QueryEngine({
      cwd: workspaceRoot,
      sessionId: 'capability-discovery-regression',
      baseSystemPrompt:
        'You are the compuser capability discovery regression harness.',
      modelClient: new DemoModelClient(),
      registry,
      runtime,
      contextAssembler: new ContextAssembler(),
      memoryStore: new InMemoryMemoryStore(),
      capabilityCatalog,
      maxTurns: 1,
    })

    const visibleBefore = capabilityCatalog
      .list()
      .filter(item => {
        const tool = registry.get(item.toolName)
        return Boolean(tool && (tool.availability ?? 'core') === 'core')
      })
      .map(item => item.toolName)
      .sort()

    assertEqual(
      visibleBefore,
      [
        'skill.desktop.observe',
      ],
      'only desktop observe should be visible by default',
    )

    const blocked = await engine.executeTool({
      toolName: 'command.demo.hidden_echo',
      input: {
        text: 'blocked',
      },
    })
    assert(blocked.ok === false, 'hidden capability should be blocked before search')
    assert(
      blocked.error === 'CAPABILITY_DISCOVERY_REQUIRED',
      'hidden capability should require capabilities.search first',
    )

    const toolSearch = await engine.executeTool({
      toolName: 'tools.search',
      input: {
        query: 'hidden echo',
      },
    })
    assert(toolSearch.ok, 'tools.search should succeed')
    const leakedToolNames = readMatchNames(toolSearch.data)
    assert(
      !leakedToolNames.includes('command.demo.hidden_echo'),
      'tools.search should not leak capability tools',
    )

    const capabilitySearch = await engine.executeTool({
      toolName: 'capabilities.search',
      input: {
        query: 'hidden echo',
      },
    })
    assert(capabilitySearch.ok, 'capabilities.search should succeed')
    const revealedCapability = readCapabilityMatch(
      capabilitySearch.data,
      'command.demo.hidden_echo',
    )
    assert(revealedCapability, 'capabilities.search should return hidden capability')
    assert(
      revealedCapability?.revealed === true,
      'capabilities.search should mark discovered capability as revealed',
    )

    const allowed = await engine.executeTool({
      toolName: 'command.demo.hidden_echo',
      input: {
        text: 'allowed',
      },
    })
    assert(allowed.ok, 'discovered capability should execute after capabilities.search')
    assert(
      allowed.error === undefined,
      'discovered capability should no longer return discovery error',
    )

    console.log('Capability discovery regression passed: 4/4')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function createToolSearchTool(
  registry: InMemoryToolRegistry,
): ToolDefinition<{
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

function createHiddenEchoCapability(): CapabilityDefinition<
  {
    text: string
  },
  {
    echoed: string
  }
> {
  return {
    id: 'demo.hidden_echo',
    kind: 'command',
    title: 'Hidden Echo',
    description: 'Echo a short string after explicit capability discovery.',
    searchHints: ['hidden echo demo'],
    tags: ['demo', 'hidden', 'echo'],
    preferredRoute: 'tool',
    riskLevel: 'low',
    inputSchema: {
      description: 'hidden echo input',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    async execute(input): Promise<CapabilityExecutionResult<{ echoed: string }>> {
      return {
        ok: true,
        summary: `Echoed ${input.text}.`,
        route: 'tool',
        output: {
          echoed: input.text,
        },
        operations: [],
        verification: {
          strategy: 'demo-hidden-echo',
          passed: true,
          details: 'Capability was explicitly discovered and executed.',
        },
      }
    },
  }
}

function scoreSearchableTool(
  query: string,
  tool: ToolDefinition,
): number {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return 1
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const fields = [tool.name, tool.description, ...(tool.searchHints ?? [])]
  let score = 0

  for (const field of fields) {
    const normalizedField = field.toLowerCase()
    if (normalizedField.includes(normalizedQuery)) {
      score += 4
    }

    for (const token of tokens) {
      if (normalizedField.includes(token)) {
        score += 2
      }
    }
  }

  return score
}

function readMatchNames(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const matches = (data as { matches?: unknown }).matches
  if (!Array.isArray(matches)) {
    return []
  }

  return matches
    .map(match =>
      typeof match === 'object' &&
      match !== null &&
      typeof (match as { name?: unknown }).name === 'string'
        ? (match as { name: string }).name
        : undefined,
    )
    .filter((value): value is string => Boolean(value))
}

function readCapabilityMatch(
  data: unknown,
  toolName: string,
):
  | {
      toolName?: string
      revealed?: boolean
    }
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const matches = (data as { matches?: unknown }).matches
  if (!Array.isArray(matches)) {
    return undefined
  }

  return matches.find(
    match =>
      typeof match === 'object' &&
      match !== null &&
      (match as { toolName?: unknown }).toolName === toolName,
  ) as
    | {
        toolName?: string
        revealed?: boolean
      }
    | undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    )
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
