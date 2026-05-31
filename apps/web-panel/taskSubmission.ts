export interface PanelAttachment {
  name: string
  mimeType: string
  base64: string
}

export interface TaskSubmissionPayload {
  task: string
  sessionId: string
  attachments: PanelAttachment[]
}

export function parseTaskSubmissionPayload(
  payload: unknown,
  defaultSessionId: string,
): TaskSubmissionPayload {
  const candidate =
    typeof payload === 'object' && payload !== null
      ? (payload as {
          task?: unknown
          sessionId?: unknown
          attachments?: unknown
        })
      : {}

  return {
    task: typeof candidate.task === 'string' ? candidate.task.trim() : '',
    sessionId:
      typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
        ? candidate.sessionId.trim()
        : defaultSessionId,
    attachments: normalizePanelAttachments(candidate.attachments),
  }
}

export function normalizePanelAttachments(value: unknown): PanelAttachment[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(item => {
      if (typeof item !== 'object' || item === null) {
        return undefined
      }

      const candidate = item as {
        name?: unknown
        mimeType?: unknown
        base64?: unknown
      }
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
      const mimeType =
        typeof candidate.mimeType === 'string'
          ? candidate.mimeType.trim()
          : 'application/octet-stream'
      const base64 = typeof candidate.base64 === 'string' ? candidate.base64.trim() : ''

      if (!name || !base64) {
        return undefined
      }

      return {
        name,
        mimeType,
        base64,
      }
    })
    .filter((item): item is PanelAttachment => Boolean(item))
}
