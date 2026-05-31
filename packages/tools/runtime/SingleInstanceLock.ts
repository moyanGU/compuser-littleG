import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

export const DEFAULT_SINGLE_INSTANCE_LOCK_HEARTBEAT_INTERVAL_MS = 10_000
export const DEFAULT_SINGLE_INSTANCE_LOCK_STALE_MS = 45_000

export interface SingleInstanceLockMetadata {
  instanceId: string
  pid: number
  startedAt: string
  heartbeatAt: string
  command: string
  hostName: string
  takeover?: {
    at: string
    mode: 'stale_recovery' | 'force'
    reason: string
    fromInstanceId: string
    fromPid: number
    fromStartedAt: string
    fromHeartbeatAt: string
    fromCommand: string
    fromHostName: string
  }
}

export interface SingleInstanceLockHandle {
  lockPath: string
  metadata: SingleInstanceLockMetadata
  refresh(): Promise<void>
  release(): Promise<void>
}

export interface SingleInstanceLockHeartbeatController {
  stop(): Promise<void>
}

export async function acquireSingleInstanceLock(
  lockPath: string,
  options: {
    command: string
    staleAfterMs?: number
    takeover?: 'never' | 'force'
    takeoverReason?: string
  },
): Promise<SingleInstanceLockHandle> {
  await mkdir(dirname(lockPath), { recursive: true })
  let metadata = createLockMetadata(options.command)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify(metadata, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
      })

      return {
        lockPath,
        metadata,
        async refresh(): Promise<void> {
          const current = await readLockMetadata(lockPath)
          if (!current || current.instanceId !== metadata.instanceId) {
            throw new Error(`守护进程锁已丢失: ${lockPath}`)
          }

          const updated: SingleInstanceLockMetadata = {
            ...current,
            pid: metadata.pid,
            command: metadata.command,
            hostName: metadata.hostName,
            startedAt: metadata.startedAt,
            instanceId: metadata.instanceId,
            heartbeatAt: new Date().toISOString(),
          }
          await writeFile(lockPath, JSON.stringify(updated, null, 2), 'utf8')
        },
        async release(): Promise<void> {
          const current = await readLockMetadata(lockPath)
          if (!current || current.instanceId !== metadata.instanceId) {
            return
          }

          await rm(lockPath, { force: true })
        },
      }
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }

      const current = await readLockMetadata(lockPath)
      if (
        current &&
        isLockActivelyHeld(
          current,
          options.staleAfterMs ?? DEFAULT_SINGLE_INSTANCE_LOCK_STALE_MS,
        )
      ) {
        if (options.takeover === 'force') {
          metadata = createLockMetadata(options.command, {
            mode: 'force',
            reason:
              options.takeoverReason ??
              'manual_force_takeover',
            previous: current,
          })
          await rm(lockPath, { force: true })
          continue
        }

        throw new Error(
          `result-gc-daemon 已在运行: pid=${current.pid} host=${current.hostName} startedAt=${current.startedAt} heartbeatAt=${current.heartbeatAt} lockPath=${lockPath}; 如需显式接管，请使用 force takeover`,
        )
      }

      if (current) {
        metadata = createLockMetadata(options.command, {
          mode: 'stale_recovery',
          reason:
            options.takeoverReason ??
            'stale_lock_recovery',
          previous: current,
        })
      }

      await rm(lockPath, { force: true })
    }
  }

  throw new Error(`无法获取守护进程锁文件: ${lockPath}`)
}

export function startSingleInstanceLockHeartbeat(
  lock: SingleInstanceLockHandle,
  options: {
    intervalMs?: number
    keepProcessAlive?: boolean
    onError?: (error: unknown) => void
  } = {},
): SingleInstanceLockHeartbeatController {
  const intervalMs = normalizePositiveMs(
    options.intervalMs,
    DEFAULT_SINGLE_INSTANCE_LOCK_HEARTBEAT_INTERVAL_MS,
    '锁文件心跳间隔',
  )
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> | undefined
  let inFlightToken: object | undefined
  let stopped = false

  const refresh = async (): Promise<void> => {
    if (stopped || inFlight) {
      return inFlight
    }

    const runToken = {}
    const currentRun = (async () => {
      try {
        await lock.refresh()
      } catch (error) {
        options.onError?.(error)
        throw error
      } finally {
        if (inFlightToken === runToken) {
          inFlight = undefined
          inFlightToken = undefined
        }
      }
    })()

    inFlightToken = runToken
    inFlight = currentRun
    return currentRun
  }

  timer = setInterval(() => {
    void refresh().catch(() => {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    })
  }, intervalMs)

  if (options.keepProcessAlive !== true) {
    timer.unref?.()
  }

  return {
    async stop(): Promise<void> {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      if (inFlight) {
        await inFlight.catch(() => {
          // Errors are already surfaced through onError.
        })
      }
    },
  }
}

async function readLockMetadata(
  lockPath: string,
): Promise<SingleInstanceLockMetadata | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<SingleInstanceLockMetadata>
    if (!isLockMetadata(parsed)) {
      return undefined
    }

    return parsed
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }

    throw error
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EPERM'
    ) {
      return true
    }

    return false
  }
}

function isLockMetadata(
  value: Partial<SingleInstanceLockMetadata>,
): value is SingleInstanceLockMetadata {
  return (
    typeof value.instanceId === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.startedAt === 'string' &&
    typeof value.heartbeatAt === 'string' &&
    typeof value.command === 'string' &&
    typeof value.hostName === 'string' &&
    isTakeoverMetadata(value.takeover)
  )
}

function createLockMetadata(
  command: string,
  takeover?: {
    mode: 'stale_recovery' | 'force'
    reason: string
    previous: SingleInstanceLockMetadata
  },
): SingleInstanceLockMetadata {
  const now = new Date().toISOString()
  return {
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    command,
    hostName: hostname(),
    takeover: takeover
      ? {
          at: now,
          mode: takeover.mode,
          reason: takeover.reason,
          fromInstanceId: takeover.previous.instanceId,
          fromPid: takeover.previous.pid,
          fromStartedAt: takeover.previous.startedAt,
          fromHeartbeatAt: takeover.previous.heartbeatAt,
          fromCommand: takeover.previous.command,
          fromHostName: takeover.previous.hostName,
        }
      : undefined,
  }
}

function isTakeoverMetadata(
  value: unknown,
): value is SingleInstanceLockMetadata['takeover'] {
  if (value === undefined) {
    return true
  }

  return (
    typeof value === 'object' &&
    value !== null &&
    'at' in value &&
    'mode' in value &&
    'reason' in value &&
    'fromInstanceId' in value &&
    'fromPid' in value &&
    'fromStartedAt' in value &&
    'fromHeartbeatAt' in value &&
    'fromCommand' in value &&
    'fromHostName' in value &&
    typeof (value as { at?: unknown }).at === 'string' &&
    (((value as { mode?: unknown }).mode === 'stale_recovery') ||
      (value as { mode?: unknown }).mode === 'force') &&
    typeof (value as { reason?: unknown }).reason === 'string' &&
    typeof (value as { fromInstanceId?: unknown }).fromInstanceId === 'string' &&
    typeof (value as { fromPid?: unknown }).fromPid === 'number' &&
    typeof (value as { fromStartedAt?: unknown }).fromStartedAt === 'string' &&
    typeof (value as { fromHeartbeatAt?: unknown }).fromHeartbeatAt ===
      'string' &&
    typeof (value as { fromCommand?: unknown }).fromCommand === 'string' &&
    typeof (value as { fromHostName?: unknown }).fromHostName === 'string'
  )
}

function isLockActivelyHeld(
  metadata: SingleInstanceLockMetadata,
  staleAfterMs: number,
): boolean {
  const heartbeatFresh =
    Date.now() - Date.parse(metadata.heartbeatAt) <= staleAfterMs
  if (!heartbeatFresh) {
    return false
  }

  return isProcessRunning(metadata.pid)
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  )
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}

function normalizePositiveMs(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${label}必须是正数，收到: ${normalized}`)
  }

  return Math.floor(normalized)
}
