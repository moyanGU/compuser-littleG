import type {
  PermissionPrompt,
  PermissionRequest,
} from '../../packages/security/PermissionPolicy.js'
import { isWithinCliWorkspace } from '../cli/workspaceRoot.js'
import type { PanelTimelineEvent, PendingPermissionView } from './panelTypes.js'
import type { SessionRecord } from './sessionStore.js'

export function createPanelPermissionPrompt(input: {
  sessionId: string
  getSession: (sessionId: string) => SessionRecord | undefined
}): PermissionPrompt {
  return {
    async confirm(request) {
      const record = input.getSession(input.sessionId)
      if (!record) {
        return {
          approved: false,
          reason: '面板会话不存在，先刷新页面再试一次。',
        }
      }

      const pendingPermission = toPendingPermissionView(request)
      record.state = {
        ...record.state,
        pendingPermission,
        pendingTemplateLaunch: undefined,
        updatedAt: new Date().toISOString(),
      }
      const waitEvent: PanelTimelineEvent = {
        title: '这一步停下来等你确认',
        detail: `${pendingPermission.toolName}: ${pendingPermission.reason}`,
        status: 'warning',
      }
      record.timeline = [
        ...record.timeline,
        waitEvent,
      ].slice(-40)
      record.state.timeline = record.timeline

      return await new Promise(resolveDecision => {
        record.pendingPermission = {
          id: pendingPermission.id,
          request,
          resolve: decision => {
            const decisionEvent: PanelTimelineEvent = {
              title:
                decision.approved === true
                  ? '你刚刚放行了这一步'
                  : '你刚刚拦住了这一步',
              detail: `${pendingPermission.toolName}: ${decision.reason ?? pendingPermission.reason}`,
              status: decision.approved === true ? 'success' : 'danger',
            }
            record.timeline = [
              ...record.timeline,
              decisionEvent,
            ].slice(-40)
            record.state = {
              ...record.state,
              pendingPermission: undefined,
              timeline: record.timeline,
              updatedAt: new Date().toISOString(),
            }
            resolveDecision(decision)
          },
        }
      })
    },
  }
}

export function toPendingPermissionView(
  request: PermissionRequest & { reasonText?: string },
): PendingPermissionView {
  const inputSummary = JSON.stringify(request.input)
  const targetPaths = extractTargetPaths(request.input)

  return {
    id: `${request.toolName}:${Date.now()}`,
    toolName: request.toolName,
    riskLevel: request.riskLevel,
    reason: request.reasonText ?? request.reason,
    reviewStage: 'prompt',
    reviewSource: 'web-panel',
    resourceScope: inferResourceScope(targetPaths),
    accessMode: inferAccessMode(request.input),
    targetPaths,
    inputSummary,
    availableGrantScopes: request.grantScopes,
  }
}

function inferResourceScope(paths: string[]): string | undefined {
  const normalized = paths.join(' ').toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized.includes('\\desktop') || normalized.includes('/desktop')) {
    return 'desktop'
  }

  if (paths.some(path => isWithinCliWorkspace(path))) {
    return 'workspace'
  }

  return 'external'
}

function inferAccessMode(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }

  const candidate = input as { mode?: unknown }
  return typeof candidate.mode === 'string' ? candidate.mode : undefined
}

function extractTargetPaths(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) {
    return []
  }

  const candidate = input as {
    path?: unknown
    targetPath?: unknown
  }

  return [candidate.path, candidate.targetPath].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  )
}
