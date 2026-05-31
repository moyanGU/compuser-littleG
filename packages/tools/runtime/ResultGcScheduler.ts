import {
  collectResultGcPlan,
  cleanupResultSessions,
  type ResultGcPlan,
  type ResultGcPolicy,
} from './ToolResultStorage.js'

export const DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS = 15 * 60 * 1000

export interface PeriodicResultGcEvent {
  trigger: 'startup' | 'interval' | 'manual'
  plan?: ResultGcPlan
  error?: unknown
}

export interface PeriodicResultGcController {
  runNow(trigger?: PeriodicResultGcEvent['trigger']): Promise<ResultGcPlan>
  stop(): Promise<void>
}

export interface StartPeriodicResultGcOptions {
  baseDir: string
  policy: ResultGcPolicy
  intervalMs?: number
  runOnStart?: boolean
  keepProcessAlive?: boolean
  onSuccess?: (event: Required<Pick<PeriodicResultGcEvent, 'trigger' | 'plan'>>) => void
  onError?: (event: Required<Pick<PeriodicResultGcEvent, 'trigger' | 'error'>>) => void
}

export function startPeriodicResultGc(
  options: StartPeriodicResultGcOptions,
): PeriodicResultGcController {
  const intervalMs = normalizeIntervalMs(options.intervalMs)
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<ResultGcPlan> | undefined
  let inFlightToken: object | undefined

  const runNow = async (
    trigger: PeriodicResultGcEvent['trigger'] = 'manual',
  ): Promise<ResultGcPlan> => {
    if (inFlight) {
      return inFlight
    }

    const runToken = {}
    let currentRun: Promise<ResultGcPlan>
    currentRun = (async () => {
      try {
        const plan = await collectResultGcPlan(options.baseDir, options.policy)
        if (plan.candidates.length > 0) {
          await cleanupResultSessions(options.baseDir, options.policy)
        }

        options.onSuccess?.({
          trigger,
          plan,
        })

        return plan
      } catch (error) {
        options.onError?.({
          trigger,
          error,
        })
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
    if (inFlight) {
      return
    }

    void runNow('interval').catch(() => {
      // Errors are surfaced through onError so the scheduler can keep running.
    })
  }, intervalMs)
  if (options.keepProcessAlive !== true) {
    timer.unref?.()
  }

  if (options.runOnStart !== false) {
    void runNow('startup').catch(() => {
      // Errors are surfaced through onError so startup can continue.
    })
  }

  return {
    runNow,
    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      if (inFlight) {
        await inFlight.catch(() => {
          // Errors were already reported through onError.
        })
      }
    },
  }
}

function normalizeIntervalMs(intervalMs: number | undefined): number {
  if (intervalMs === undefined) {
    return DEFAULT_PERIODIC_RESULT_GC_INTERVAL_MS
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`周期性结果 GC 间隔必须是正数，收到: ${intervalMs}`)
  }

  return Math.floor(intervalMs)
}
