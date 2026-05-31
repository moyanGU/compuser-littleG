import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DemoModelClient } from '../../packages/core/ModelClient.js'
import { QueryEngine } from '../../packages/core/QueryEngine.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
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
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'compuser-discoverable-'))

  try {
    const registry = new InMemoryToolRegistry()
    const searchTool = createToolSearchTool(registry)
    const discoverableTool = createDiscoverableWriteTool()
    registry.register(searchTool)
    registry.register(discoverableTool)

    const engine = new QueryEngine({
      cwd: workspaceRoot,
      sessionId: 'discoverable-tools-regression',
      baseSystemPrompt: 'You are the compuser discoverable tools regression harness.',
      modelClient: new DemoModelClient(),
      registry,
      runtime: new ToolRuntime(registry, new AllowAllPermissionChecker()),
      contextAssembler: new ContextAssembler(),
      memoryStore: new InMemoryMemoryStore(),
      capabilityCatalog: new InMemoryCapabilityCatalog(createBuiltinCapabilities()),
      maxTurns: 1,
    })

    const blocked = await engine.executeTool({
      toolName: 'workspace.write_text',
      input: {
        path: resolve(workspaceRoot, 'note.txt'),
        content: 'blocked',
      },
    })
    assert(blocked.ok === false, 'undiscovered tool should be blocked')
    assert(
      blocked.error === 'TOOL_DISCOVERY_REQUIRED',
      'undiscovered tool should require search first',
    )

    const discovered = await engine.executeTool({
      toolName: 'tools.search',
      input: {
        query: 'write',
      },
    })
    assert(discovered.ok, 'tools.search should succeed')

    const allowed = await engine.executeTool({
      toolName: 'workspace.write_text',
      input: {
        path: resolve(workspaceRoot, 'note.txt'),
        content: 'allowed',
      },
    })
    assert(allowed.ok, 'discovered tool should execute after tools.search')

    console.log('Discoverable tools regression passed: 2/2')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function createToolSearchTool(
  registry: InMemoryToolRegistry,
): ToolDefinition<{
  query: string
}> {
  return {
    name: 'tools.search',
    availability: 'core',
    description: 'Search discoverable tools and reveal their callable schemas before use.',
    searchHints: ['tools', 'discoverable', 'search', 'schema'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'tool search input',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    async execute(input) {
      const normalizedQuery = input.query.trim().toLowerCase()
      const matches = registry
        .list()
        .filter(tool => (tool.availability ?? 'core') === 'discoverable')
        .filter(tool => {
          const fields = [tool.name, tool.description, ...(tool.searchHints ?? [])]
          return fields.some(field => field.toLowerCase().includes(normalizedQuery))
        })
        .map(tool => ({
          name: tool.name,
          description: tool.description,
        }))

      return {
        ok: true,
        summary: `Found ${matches.length} discoverable tools.`,
        data: {
          matches,
        },
      }
    },
  }
}

function createDiscoverableWriteTool(): ToolDefinition<{
  path: string
  content: string
}> {
  return {
    name: 'workspace.write_text',
    availability: 'discoverable',
    description: 'Write a text file.',
    searchHints: ['workspace', 'write', 'file'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'write text input',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async execute(input) {
      return {
        ok: true,
        summary: `Wrote ${input.path}.`,
      }
    },
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
