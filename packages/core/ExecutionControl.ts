export class ExecutionAbortedError extends Error {
  constructor(message = 'Task execution was aborted.') {
    super(message)
    this.name = 'ExecutionAbortedError'
  }
}

export function isExecutionAbortedError(error: unknown): error is ExecutionAbortedError {
  return error instanceof ExecutionAbortedError
}

export function throwIfExecutionAborted(
  signal: AbortSignal | undefined,
  message = 'Task execution was aborted.',
): void {
  if (signal?.aborted) {
    throw new ExecutionAbortedError(message)
  }
}

export function createLinkedAbortSignal(input: {
  timeoutMs: number
  externalSignal?: AbortSignal
}): {
  signal: AbortSignal
  dispose: () => void
  didExternalAbort: () => boolean
} {
  const abortController = new AbortController()
  let externalAbort = false
  const timeout = setTimeout(() => abortController.abort(), input.timeoutMs)

  const onExternalAbort = () => {
    externalAbort = true
    abortController.abort()
  }

  if (input.externalSignal) {
    if (input.externalSignal.aborted) {
      onExternalAbort()
    } else {
      input.externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  return {
    signal: abortController.signal,
    dispose: () => {
      clearTimeout(timeout)
      if (input.externalSignal) {
        input.externalSignal.removeEventListener('abort', onExternalAbort)
      }
    },
    didExternalAbort: () => externalAbort,
  }
}
