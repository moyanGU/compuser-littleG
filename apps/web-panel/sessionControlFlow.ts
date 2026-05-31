import type { PanelTimelineEvent } from './panelTypes.js'
import type { SessionRecord } from './sessionStore.js'
import type { PermissionGrantScope } from '../../packages/security/PermissionPolicy.js'

export interface SessionControlFlowDependencies {
  sessions: Map<string, SessionRecord>
}

export type StopSessionResult =
  | {
      kind: 'session_not_found'
    }
  | {
      kind: 'accepted'
      sessionId: string
      state: SessionRecord['state']
    }

export type PermissionDecisionResult =
  | {
      kind: 'no_pending_permission'
    }
  | {
      kind: 'accepted'
      sessionId: string
    }

export function createSessionControlFlow(
  deps: SessionControlFlowDependencies,
) {
  function stopSession(sessionId: string): StopSessionResult {
    const record = deps.sessions.get(sessionId)
    if (!record) {
      return { kind: 'session_not_found' }
    }

    if (record.abortController && !record.abortController.signal.aborted) {
      record.abortController.abort()
      const stopEvent: PanelTimelineEvent = {
        title: '任务已停止',
        detail: '当前运行已被手动中止，这次任务不会再继续自动执行。',
        status: 'warning',
      }
      record.timeline = [...record.timeline, stopEvent].slice(-40)
      record.state = {
        ...record.state,
        view: 'result',
        isRunning: false,
        emergencyStopAvailable: false,
        stopReason: 'aborted',
        stageLabel: 'Stopped',
        finalText:
          record.state.finalText ??
          '当前运行已被手动中止，这次任务不会继续自动执行。',
        result: {
          kind: 'aborted',
          title: '任务已中止',
          summary:
            record.state.finalText ??
            '当前运行已被手动中止，这次任务不会继续自动执行。',
          nextActionText: '回到首页后，可以重新整理任务再发起。',
        },
        timeline: record.timeline,
        updatedAt: new Date().toISOString(),
      }
    }

    return {
      kind: 'accepted',
      sessionId,
      state: record.state,
    }
  }

  function resolvePermissionDecision(input: {
    sessionId: string
    decision: 'approve' | 'deny'
    grantScope?: PermissionGrantScope
    reason?: string
  }): PermissionDecisionResult {
    const record = deps.sessions.get(input.sessionId)
    if (!record?.pendingPermission) {
      return {
        kind: 'no_pending_permission',
      }
    }

    record.pendingPermission.resolve({
      approved: input.decision === 'approve',
      grantScope: input.grantScope,
      reason: input.reason,
    })
    record.pendingPermission = undefined
    record.state = {
      ...record.state,
      pendingPermission: undefined,
      updatedAt: new Date().toISOString(),
    }

    return {
      kind: 'accepted',
      sessionId: input.sessionId,
    }
  }

  return {
    stopSession,
    resolvePermissionDecision,
  }
}
