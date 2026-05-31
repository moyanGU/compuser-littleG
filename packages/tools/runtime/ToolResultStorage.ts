import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  AnyToolDefinition,
  ToolContext,
  ToolResult,
} from '../Tool.js'

export interface ResultGcPolicy {
  staleSessionAgeMs?: number
  maxSessionDirs?: number
  maxTotalBytes?: number
  preserveRecentSessionCount?: number
  protectedSessionId?: string
}

export interface ResultSessionDirInfo {
  sessionId: string
  path: string
  ageMs: number
  mtimeMs: number
  totalBytes: number
}

export interface ResultGcCandidate extends ResultSessionDirInfo {
  reasons: Array<'stale' | 'max_session_dirs' | 'max_total_bytes'>
}

export interface ResultGcPlan {
  sessions: ResultSessionDirInfo[]
  candidates: ResultGcCandidate[]
  summary: {
    totalSessionsBefore: number
    totalBytesBefore: number
    candidateSessions: number
    candidateBytes: number
    totalSessionsAfter: number
    totalBytesAfter: number
  }
  appliedPolicy: {
    staleSessionAgeMs: number
    maxSessionDirs?: number
    maxTotalBytes?: number
    preserveRecentSessionCount: number
    protectedSessionId?: string
  }
}

export const DEFAULT_RESULT_GC_POLICY = {
  staleSessionAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxSessionDirs: 24,
  maxTotalBytes: 50 * 1024 * 1024,
  preserveRecentSessionCount: 2,
} as const

export interface ToolResultStorage {
  persistIfNeeded(
    tool: AnyToolDefinition,
    result: ToolResult,
    context: ToolContext,
  ): Promise<ToolResult>
}

export class FileToolResultStorage implements ToolResultStorage {
  constructor(
    private readonly options: {
      baseDirName?: string
      previewChars?: number
      staleSessionAgeMs?: number
      maxSessionDirs?: number
      maxTotalBytes?: number
      preserveRecentSessionCount?: number
    } = {},
  ) {}

  async persistIfNeeded(
    tool: AnyToolDefinition,
    result: ToolResult,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (
      tool.maxResultChars === undefined ||
      result.data === undefined ||
      result.pointer
    ) {
      return result
    }

    const serialized = JSON.stringify(result.data, null, 2)
    if (serialized.length <= tool.maxResultChars) {
      return result
    }

    const baseDir = resolve(
      context.cwd,
      this.options.baseDirName ?? 'artifacts/tool-results',
    )
    const sessionDir = resolve(
      baseDir,
      sanitizePathSegment(context.sessionId),
    )
    const outputDir = resolve(
      sessionDir,
      sanitizePathSegment(context.turnId),
    )
    const filePath = resolve(
      outputDir,
      `${sanitizePathSegment(tool.name)}-${Date.now()}.json`,
    )

    await mkdir(outputDir, { recursive: true })
    await writeFile(filePath, serialized, 'utf8')
    await cleanupResultSessions(baseDir, {
      staleSessionAgeMs:
        this.options.staleSessionAgeMs ??
        DEFAULT_RESULT_GC_POLICY.staleSessionAgeMs,
      maxSessionDirs:
        this.options.maxSessionDirs ?? DEFAULT_RESULT_GC_POLICY.maxSessionDirs,
      maxTotalBytes:
        this.options.maxTotalBytes ?? DEFAULT_RESULT_GC_POLICY.maxTotalBytes,
      preserveRecentSessionCount:
        this.options.preserveRecentSessionCount ??
        DEFAULT_RESULT_GC_POLICY.preserveRecentSessionCount,
      protectedSessionId: context.sessionId,
    })

    const previewChars = this.options.previewChars ?? 240
    const preview = serialized.slice(0, previewChars)

    return {
      ...result,
      summary: `${result.summary} 完整结果已外置存储。`,
      data: {
        compacted: true,
        preview,
      },
      pointer: filePath,
    }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

export async function cleanupResultSessions(
  baseDir: string,
  policy: ResultGcPolicy,
): Promise<void> {
  const plan = await collectResultGcPlan(baseDir, policy)

  for (const candidate of plan.candidates) {
    await rm(candidate.path, {
      recursive: true,
      force: true,
    })
  }
}

export async function collectResultGcPlan(
  baseDir: string,
  policy: ResultGcPolicy = {},
): Promise<ResultGcPlan> {
  const sessions = await listResultSessions(baseDir)
  const normalized = normalizeResultGcPolicy(policy)
  const selected = new Map<string, ResultGcCandidate>()

  for (const session of sessions) {
    if (isProtectedSession(session.sessionId, normalized.protectedSessionId)) {
      continue
    }

    if (session.ageMs >= normalized.staleSessionAgeMs) {
      addCandidate(selected, session, 'stale')
    }
  }

  const remainingAfterStale = sessions.filter(
    session => !selected.has(session.path),
  )
  const quotaPool = buildQuotaPool(
    remainingAfterStale,
    normalized.protectedSessionId,
    normalized.preserveRecentSessionCount,
  )

  if (
    normalized.maxSessionDirs !== undefined &&
    remainingAfterStale.length > normalized.maxSessionDirs
  ) {
    let sessionsToTrim = remainingAfterStale.length - normalized.maxSessionDirs
    for (const session of quotaPool) {
      if (sessionsToTrim <= 0) {
        break
      }

      if (selected.has(session.path)) {
        continue
      }

      addCandidate(selected, session, 'max_session_dirs')
      sessionsToTrim -= 1
    }
  }

  if (normalized.maxTotalBytes !== undefined) {
    let keptBytes = sumBytes(
      sessions.filter(session => !selected.has(session.path)),
    )
    if (keptBytes > normalized.maxTotalBytes) {
      for (const session of quotaPool) {
        if (keptBytes <= normalized.maxTotalBytes) {
          break
        }

        if (selected.has(session.path)) {
          continue
        }

        addCandidate(selected, session, 'max_total_bytes')
        keptBytes -= session.totalBytes
      }
    }
  }

  const candidates = Array.from(selected.values()).sort(
    (left, right) => left.mtimeMs - right.mtimeMs,
  )
  const candidateBytes = sumBytes(candidates)
  const totalBytesBefore = sumBytes(sessions)

  return {
    sessions,
    candidates,
    summary: {
      totalSessionsBefore: sessions.length,
      totalBytesBefore,
      candidateSessions: candidates.length,
      candidateBytes,
      totalSessionsAfter: sessions.length - candidates.length,
      totalBytesAfter: totalBytesBefore - candidateBytes,
    },
    appliedPolicy: normalized,
  }
}

async function listResultSessions(baseDir: string): Promise<ResultSessionDirInfo[]> {
  const now = Date.now()

  try {
    const entries = await readdir(baseDir, { withFileTypes: true })
    const sessions: ResultSessionDirInfo[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const entryPath = resolve(baseDir, entry.name)
      const metadata = await stat(entryPath)

      sessions.push({
        sessionId: entry.name,
        path: entryPath,
        ageMs: now - metadata.mtimeMs,
        mtimeMs: metadata.mtimeMs,
        totalBytes: await measurePathBytes(entryPath),
      })
    }

    return sessions.sort((left, right) => right.mtimeMs - left.mtimeMs)
  } catch (error) {
    if (isMissingPathError(error)) {
      return []
    }

    throw error
  }
}

async function measurePathBytes(path: string): Promise<number> {
  const metadata = await stat(path)
  if (!metadata.isDirectory()) {
    return metadata.size
  }

  const entries = await readdir(path, { withFileTypes: true })
  let total = 0

  for (const entry of entries) {
    total += await measurePathBytes(resolve(path, entry.name))
  }

  return total
}

function buildQuotaPool(
  sessions: ResultSessionDirInfo[],
  protectedSessionId: string | undefined,
  preserveRecentSessionCount: number,
): ResultSessionDirInfo[] {
  const removable = sessions.filter(
    session => !isProtectedSession(session.sessionId, protectedSessionId),
  )
  const preservedRecent = new Set(
    removable
      .slice(0, preserveRecentSessionCount)
      .map(session => session.path.toLowerCase()),
  )

  return removable
    .filter(session => !preservedRecent.has(session.path.toLowerCase()))
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
}

function normalizeResultGcPolicy(
  policy: ResultGcPolicy,
): ResultGcPlan['appliedPolicy'] {
  return {
    staleSessionAgeMs: Math.max(
      60_000,
      policy.staleSessionAgeMs ?? DEFAULT_RESULT_GC_POLICY.staleSessionAgeMs,
    ),
    maxSessionDirs:
      policy.maxSessionDirs === undefined
        ? DEFAULT_RESULT_GC_POLICY.maxSessionDirs
        : normalizeOptionalLimit(policy.maxSessionDirs),
    maxTotalBytes:
      policy.maxTotalBytes === undefined
        ? DEFAULT_RESULT_GC_POLICY.maxTotalBytes
        : normalizeOptionalLimit(policy.maxTotalBytes),
    preserveRecentSessionCount: Math.max(
      0,
      policy.preserveRecentSessionCount ??
        DEFAULT_RESULT_GC_POLICY.preserveRecentSessionCount,
    ),
    protectedSessionId:
      policy.protectedSessionId !== undefined
        ? sanitizePathSegment(policy.protectedSessionId)
        : undefined,
  }
}

function normalizeOptionalLimit(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined
  }

  const normalized = Math.max(0, Math.floor(value))
  return normalized === 0 ? undefined : normalized
}

function isProtectedSession(
  sessionId: string,
  protectedSessionId: string | undefined,
): boolean {
  return protectedSessionId !== undefined && sessionId === protectedSessionId
}

function addCandidate(
  selected: Map<string, ResultGcCandidate>,
  session: ResultSessionDirInfo,
  reason: ResultGcCandidate['reasons'][number],
): void {
  const existing = selected.get(session.path)
  if (existing) {
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason)
    }
    return
  }

  selected.set(session.path, {
    ...session,
    reasons: [reason],
  })
}

function sumBytes(items: Array<{ totalBytes: number }>): number {
  return items.reduce((total, item) => total + item.totalBytes, 0)
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}
