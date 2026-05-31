import type { AnyToolDefinition, ToolCall, ToolRegistry } from '../Tool.js'

export interface ToolExecutionBatch {
  mode: 'parallel' | 'serial'
  calls: ToolCall[]
}

export function planToolExecutionBatches(
  calls: ToolCall[],
  registry: ToolRegistry,
): ToolExecutionBatch[] {
  const batches: ToolExecutionBatch[] = []
  let pendingParallel: ToolCall[] = []

  const flushParallel = () => {
    if (pendingParallel.length === 0) {
      return
    }

    batches.push({
      mode: 'parallel',
      calls: pendingParallel,
    })
    pendingParallel = []
  }

  for (const call of calls) {
    const tool = registry.get(call.toolName)
    if (isParallelSafeTool(tool)) {
      pendingParallel.push(call)
      continue
    }

    flushParallel()
    batches.push({
      mode: 'serial',
      calls: [call],
    })
  }

  flushParallel()
  return batches
}

function isParallelSafeTool(tool: AnyToolDefinition | undefined): boolean {
  return tool?.concurrencySafe === true && tool.executionMode === 'sync'
}
