import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ToolDefinition, ToolResult } from './Tool.js'
import {
  collectResultGcPlan,
  cleanupResultSessions,
  DEFAULT_RESULT_GC_POLICY,
} from './runtime/ToolResultStorage.js'

export function createResultPointerTools(
  workspaceRoot: string,
): Array<
  | ToolDefinition<{ pointer: string; maxChars?: number; offset?: number }>
  | ToolDefinition<{
      staleAgeMs?: number
      maxSessionDirs?: number
      maxTotalBytes?: number
      preserveRecentSessionCount?: number
      dryRun?: boolean
      sessionId?: string
    }>
> {
  const readResultPointerTool: ToolDefinition<{
    pointer: string
    maxChars?: number
    offset?: number
  }> = {
    name: 'artifacts.read_result',
    description:
      '读取先前外置存储的工具结果文件，适合按需取回 pointer 指向的详细内容。',
    searchHint: '读取 结果 指针 artifact pointer 文件',
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'read result pointer input',
      properties: {
        pointer: { type: 'string' },
        maxChars: { type: 'number' },
        offset: { type: 'number' },
      },
      required: ['pointer'],
    },
    async execute(input): Promise<ToolResult> {
      const allowedRoot = resolve(workspaceRoot, 'artifacts', 'tool-results')
      const resolvedPointer = resolveAllowedPointer(
        input.pointer,
        workspaceRoot,
        allowedRoot,
      )
      const raw = await readFile(resolvedPointer, 'utf8')
      const maxChars = Math.max(1, Math.min(input.maxChars ?? 4_000, 20_000))
      const offset = Math.max(0, Math.min(input.offset ?? 0, raw.length))
      const endOffset = Math.min(offset + maxChars, raw.length)
      const truncated = offset > 0 || endOffset < raw.length
      const nextOffset = endOffset < raw.length ? endOffset : undefined

      return {
        ok: true,
        summary: truncated
          ? `已读取外置结果分段内容(${offset}-${endOffset}/${raw.length} chars)。`
          : `已读取完整外置结果(${raw.length} chars)。`,
        data: {
          pointer: resolvedPointer,
          content: raw.slice(offset, endOffset),
          startOffset: offset,
          endOffset,
          nextOffset,
          hasMore: nextOffset !== undefined,
          truncated,
          totalChars: raw.length,
        },
        pointer: resolvedPointer,
      }
    },
  }

  const gcResultsTool: ToolDefinition<{
    staleAgeMs?: number
    maxSessionDirs?: number
    maxTotalBytes?: number
    preserveRecentSessionCount?: number
    dryRun?: boolean
    sessionId?: string
  }> = {
    name: 'artifacts.gc_results',
    description:
      '清理工具结果目录；支持按时间、session 数量和总体积阈值回收，默认 dry-run 仅预览。',
    searchHint: '清理 回收 gc artifacts tool results',
    riskLevel: 'medium',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'gc result artifacts input',
      properties: {
        staleAgeMs: { type: 'number' },
        maxSessionDirs: { type: 'number' },
        maxTotalBytes: { type: 'number' },
        preserveRecentSessionCount: { type: 'number' },
        dryRun: { type: 'boolean' },
        sessionId: { type: 'string' },
      },
    },
    async execute(input, context): Promise<ToolResult> {
      const baseDir = resolve(workspaceRoot, 'artifacts', 'tool-results')
      const policy = {
        staleSessionAgeMs:
          input.staleAgeMs ?? DEFAULT_RESULT_GC_POLICY.staleSessionAgeMs,
        maxSessionDirs:
          input.maxSessionDirs ?? DEFAULT_RESULT_GC_POLICY.maxSessionDirs,
        maxTotalBytes:
          input.maxTotalBytes ?? DEFAULT_RESULT_GC_POLICY.maxTotalBytes,
        preserveRecentSessionCount:
          input.preserveRecentSessionCount ??
          DEFAULT_RESULT_GC_POLICY.preserveRecentSessionCount,
        protectedSessionId: input.sessionId ?? context.sessionId,
      }
      const result = await collectResultGcPlan(baseDir, policy)

      if (!input.dryRun) {
        await cleanupResultSessions(baseDir, policy)
      }

      const modeSummary =
        input.dryRun === false
          ? `已清理 ${result.candidates.length} 个结果目录。`
          : `dry-run：发现 ${result.candidates.length} 个可清理结果目录。`

      return {
        ok: true,
        summary: `${modeSummary} 当前策略同时考虑过期时间、session 数量和总体积阈值。`,
        data: {
          dryRun: input.dryRun !== false,
          deletedCount: input.dryRun === false ? result.candidates.length : 0,
          candidateCount: result.candidates.length,
          summary: result.summary,
          appliedPolicy: result.appliedPolicy,
          candidates: result.candidates,
        },
      }
    },
  }

  return [readResultPointerTool, gcResultsTool]
}

function resolveAllowedPointer(
  pointer: string,
  workspaceRoot: string,
  allowedRoot: string,
): string {
  const trimmedPointer = pointer.trim()
  const resolvedPointer = isAbsolute(trimmedPointer)
    ? resolve(trimmedPointer)
    : resolve(workspaceRoot, trimmedPointer)

  const normalizedAllowedRoot = ensureTrailingSeparator(allowedRoot.toLowerCase())
  const normalizedPointer = resolvedPointer.toLowerCase()

  if (
    normalizedPointer !== allowedRoot.toLowerCase() &&
    !normalizedPointer.startsWith(normalizedAllowedRoot)
  ) {
    throw new Error(
      `Pointer is outside allowed artifacts directory: ${resolvedPointer}`,
    )
  }

  return resolvedPointer
}

function ensureTrailingSeparator(path: string): string {
  return path.endsWith('\\') || path.endsWith('/') ? path : `${path}\\`
}
