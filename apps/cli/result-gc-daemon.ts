import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CLI_DEFAULT_SESSION_ID,
  CLI_WORKSPACE_ROOT,
} from './cliApp.js'
import {
  DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS,
  startPeriodicResultGc,
} from '../../packages/tools/runtime/ResultGcScheduler.js'
import {
  acquireSingleInstanceLock,
  DEFAULT_SINGLE_INSTANCE_LOCK_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SINGLE_INSTANCE_LOCK_STALE_MS,
  startSingleInstanceLockHeartbeat,
  type SingleInstanceLockHeartbeatController,
} from '../../packages/tools/runtime/SingleInstanceLock.js'
import { DEFAULT_RESULT_GC_POLICY } from '../../packages/tools/runtime/ToolResultStorage.js'

type ResultGcDaemonOptions = {
  baseDir: string
  lockFilePath?: string
  lockHeartbeatIntervalMs?: number
  lockStaleAfterMs?: number
  forceTakeover: boolean
  takeoverReason?: string
  intervalMs?: number
  staleSessionAgeMs?: number
  maxSessionDirs?: number
  maxTotalBytes?: number
  preserveRecentSessionCount?: number
  protectedSessionId?: string
  runOnStart: boolean
  runOnce: boolean
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const lock = await acquireSingleInstanceLock(options.lockFilePath!, {
    command: process.argv.join(' '),
    staleAfterMs:
      options.lockStaleAfterMs ?? DEFAULT_SINGLE_INSTANCE_LOCK_STALE_MS,
    takeover: options.forceTakeover ? 'force' : 'never',
    takeoverReason: options.takeoverReason,
  })
  let controller:
    | ReturnType<typeof startPeriodicResultGc>
    | undefined
    | null = null
  let lockHeartbeat: SingleInstanceLockHeartbeatController | undefined
  let resolveInternalShutdown:
    | ((signal: 'lock-heartbeat-error') => void)
    | undefined
  const internalShutdown = new Promise<'lock-heartbeat-error'>(resolve => {
    resolveInternalShutdown = resolve
  })
  let shutdownRequested = false
  const handleShutdown = async (signal: string): Promise<void> => {
    if (shutdownRequested) {
      return
    }

    shutdownRequested = true
    console.log(`[result-gc-daemon] shutdown signal=${signal}`)
    await lockHeartbeat?.stop()
    await controller?.stop()
  }

  try {
    console.log(`[result-gc-daemon] baseDir=${options.baseDir}`)
    console.log(`[result-gc-daemon] lockFilePath=${options.lockFilePath}`)
    console.log(
      `[result-gc-daemon] intervalMs=${options.intervalMs ?? DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS} protectedSessionId=${options.protectedSessionId ?? 'none'} lockHeartbeatIntervalMs=${options.lockHeartbeatIntervalMs ?? DEFAULT_SINGLE_INSTANCE_LOCK_HEARTBEAT_INTERVAL_MS} lockStaleAfterMs=${options.lockStaleAfterMs ?? DEFAULT_SINGLE_INSTANCE_LOCK_STALE_MS} forceTakeover=${options.forceTakeover ? 'true' : 'false'}`,
    )

    lockHeartbeat = startSingleInstanceLockHeartbeat(lock, {
      intervalMs:
        options.lockHeartbeatIntervalMs ??
        DEFAULT_SINGLE_INSTANCE_LOCK_HEARTBEAT_INTERVAL_MS,
      keepProcessAlive: true,
      onError(error) {
        console.error(
          `[result-gc-daemon] lock-heartbeat error=${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        process.exitCode = 1
        void handleShutdown('lock-heartbeat-error')
        resolveInternalShutdown?.('lock-heartbeat-error')
      },
    })

    controller = startPeriodicResultGc({
      baseDir: options.baseDir,
      intervalMs:
        options.intervalMs ?? DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS,
      keepProcessAlive: true,
      runOnStart: false,
      policy: {
        staleSessionAgeMs:
          options.staleSessionAgeMs ?? DEFAULT_RESULT_GC_POLICY.staleSessionAgeMs,
        maxSessionDirs:
          options.maxSessionDirs ?? DEFAULT_RESULT_GC_POLICY.maxSessionDirs,
        maxTotalBytes:
          options.maxTotalBytes ?? DEFAULT_RESULT_GC_POLICY.maxTotalBytes,
        preserveRecentSessionCount:
          options.preserveRecentSessionCount ??
          DEFAULT_RESULT_GC_POLICY.preserveRecentSessionCount,
        protectedSessionId: options.protectedSessionId,
      },
      onSuccess(event) {
        if (event.trigger === 'interval' && event.plan.candidates.length === 0) {
          return
        }

        console.log(
          `[result-gc-daemon] trigger=${event.trigger} candidates=${event.plan.candidates.length} sessions_before=${event.plan.summary.totalSessionsBefore} sessions_after=${event.plan.summary.totalSessionsAfter} bytes_after=${event.plan.summary.totalBytesAfter}`,
        )
      },
      onError(event) {
        console.error(
          `[result-gc-daemon] trigger=${event.trigger} error=${
            event.error instanceof Error ? event.error.message : String(event.error)
          }`,
        )
      },
    })

    process.on('SIGINT', () => {
      void handleShutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void handleShutdown('SIGTERM')
    })

    if (options.runOnStart) {
      await controller.runNow('startup')
    }

    if (options.runOnce) {
      console.log('[result-gc-daemon] run-once completed')
      await controller.stop()
      return
    }

    console.log('[result-gc-daemon] running; press Ctrl+C or type exit to stop')
    const shutdownListener = createShutdownSignalListener()
    try {
      const shutdownSignal = await Promise.race([
        shutdownListener.promise,
        internalShutdown,
      ])
      await handleShutdown(shutdownSignal)
    } finally {
      shutdownListener.cleanup()
    }
  } finally {
    await handleShutdown('finalize')
    await lock.release()
  }
}

function parseArgs(argv: string[]): ResultGcDaemonOptions {
  const options: ResultGcDaemonOptions = {
    baseDir: resolve(CLI_WORKSPACE_ROOT, 'artifacts', 'tool-results'),
    lockFilePath: process.env.COMPUSER_RESULT_GC_LOCK_FILE_PATH,
    lockHeartbeatIntervalMs: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_LOCK_HEARTBEAT_INTERVAL_MS,
    ),
    lockStaleAfterMs: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_LOCK_STALE_AFTER_MS,
    ),
    forceTakeover:
      parseOptionalBoolean(process.env.COMPUSER_RESULT_GC_FORCE_TAKEOVER) ??
      false,
    takeoverReason: process.env.COMPUSER_RESULT_GC_TAKEOVER_REASON,
    intervalMs: parseOptionalNumber(
      process.env.COMPUSER_PERIODIC_RESULT_GC_INTERVAL_MS,
    ),
    staleSessionAgeMs: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_STALE_SESSION_AGE_MS,
    ),
    maxSessionDirs: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_MAX_SESSION_DIRS,
    ),
    maxTotalBytes: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_MAX_TOTAL_BYTES,
    ),
    preserveRecentSessionCount: parseOptionalNumber(
      process.env.COMPUSER_RESULT_GC_PRESERVE_RECENT_SESSION_COUNT,
    ),
    protectedSessionId:
      process.env.COMPUSER_RESULT_GC_PROTECTED_SESSION_ID ??
      CLI_DEFAULT_SESSION_ID,
    runOnStart:
      parseOptionalBoolean(process.env.COMPUSER_RESULT_GC_RUN_ON_START) ?? true,
    runOnce: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--base-dir':
        options.baseDir = argv[index + 1] ?? options.baseDir
        index += 1
        break
      case '--interval-ms':
        options.intervalMs = parseRequiredNumber(argv[index + 1], '--interval-ms')
        index += 1
        break
      case '--lock-file-path':
        options.lockFilePath = argv[index + 1] ?? options.lockFilePath
        index += 1
        break
      case '--lock-heartbeat-interval-ms':
        options.lockHeartbeatIntervalMs = parseRequiredNumber(
          argv[index + 1],
          '--lock-heartbeat-interval-ms',
        )
        index += 1
        break
      case '--lock-stale-after-ms':
        options.lockStaleAfterMs = parseRequiredNumber(
          argv[index + 1],
          '--lock-stale-after-ms',
        )
        index += 1
        break
      case '--force-takeover':
        options.forceTakeover = true
        break
      case '--takeover-reason':
        options.takeoverReason = argv[index + 1]
        index += 1
        break
      case '--stale-session-age-ms':
        options.staleSessionAgeMs = parseRequiredNumber(
          argv[index + 1],
          '--stale-session-age-ms',
        )
        index += 1
        break
      case '--max-session-dirs':
        options.maxSessionDirs = parseRequiredNumber(
          argv[index + 1],
          '--max-session-dirs',
        )
        index += 1
        break
      case '--max-total-bytes':
        options.maxTotalBytes = parseRequiredNumber(
          argv[index + 1],
          '--max-total-bytes',
        )
        index += 1
        break
      case '--preserve-recent-session-count':
        options.preserveRecentSessionCount = parseRequiredNumber(
          argv[index + 1],
          '--preserve-recent-session-count',
        )
        index += 1
        break
      case '--protected-session-id':
        options.protectedSessionId = argv[index + 1]
        index += 1
        break
      case '--no-protected-session':
        options.protectedSessionId = undefined
        break
      case '--skip-startup-run':
        options.runOnStart = false
        break
      case '--run-once':
        options.runOnce = true
        break
      default:
        break
    }
  }

  options.lockFilePath ??= resolve(options.baseDir, 'result-gc-daemon.lock')
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

  throw new Error(`无法解析布尔配置: ${value}`)
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  if (Number.isNaN(parsed)) {
    throw new Error(`无法解析数字配置: ${value}`)
  }
  return parsed
}

function parseRequiredNumber(
  value: string | undefined,
  optionName: string,
): number {
  if (value === undefined) {
    throw new Error(`缺少参数值: ${optionName}`)
  }

  return parseOptionalNumber(value) as number
}

function createShutdownSignalListener(): {
  promise: Promise<'SIGINT' | 'SIGTERM' | 'stdin'>
  cleanup(): void
} {
  let resolved = false
  const lineReader =
    process.stdin.readable && !process.stdin.destroyed
      ? createInterface({
          input: process.stdin,
          terminal: false,
        })
      : undefined
  let resolvePromise: ((signal: 'SIGINT' | 'SIGTERM' | 'stdin') => void) | undefined
  const promise = new Promise<'SIGINT' | 'SIGTERM' | 'stdin'>(resolve => {
    resolvePromise = resolve
  })

  const cleanup = () => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (lineReader) {
      lineReader.off('line', onLine)
      lineReader.close()
    }
  }
  const complete = (signal: 'SIGINT' | 'SIGTERM' | 'stdin') => {
    if (resolved) {
      return
    }

    resolved = true
    cleanup()
    resolvePromise?.(signal)
  }
  const onSigint = () => {
    complete('SIGINT')
  }
  const onSigterm = () => {
    complete('SIGTERM')
  }
  const onLine = (line: string) => {
    const normalized = line.trim().toLowerCase()
    if (
      normalized === 'exit' ||
      normalized === 'quit' ||
      normalized === 'stop'
    ) {
      complete('stdin')
    }
  }

  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  lineReader?.on('line', onLine)

  return {
    promise,
    cleanup,
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
