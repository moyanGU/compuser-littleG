import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PermissionGrantScope } from '../../packages/security/PermissionPolicy.js'

export type PermissionDecision = 'approve' | 'deny'

export interface TemplateLaunchDecisionPayload {
  decision?: PermissionDecision
}

export interface PermissionDecisionPayload {
  decision?: PermissionDecision
  grantScope?: PermissionGrantScope
  reason?: string
}

export interface DecisionActionPayload {
  actionId?: string
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

export function parseTemplateLaunchDecisionPayload(
  payload: unknown,
): TemplateLaunchDecisionPayload {
  const candidate =
    typeof payload === 'object' && payload !== null
      ? (payload as { decision?: unknown })
      : {}

  return {
    decision: normalizePermissionDecision(candidate.decision),
  }
}

export function parsePermissionDecisionPayload(
  payload: unknown,
): PermissionDecisionPayload {
  const candidate =
    typeof payload === 'object' && payload !== null
      ? (payload as {
          decision?: unknown
          grantScope?: unknown
          reason?: unknown
        })
      : {}

  return {
    decision: normalizePermissionDecision(candidate.decision),
    grantScope: normalizeGrantScope(candidate.grantScope),
    reason:
      typeof candidate.reason === 'string' && candidate.reason.trim()
        ? candidate.reason.trim()
        : undefined,
  }
}

export function parseDecisionActionPayload(
  payload: unknown,
): DecisionActionPayload {
  const candidate =
    typeof payload === 'object' && payload !== null
      ? (payload as { actionId?: unknown })
      : {}

  return {
    actionId:
      typeof candidate.actionId === 'string' && candidate.actionId.trim()
        ? candidate.actionId.trim()
        : undefined,
  }
}

export function respondJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload, null, 2))
}

export function respondHtml(
  response: ServerResponse,
  payload: string,
): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
  })
  response.end(payload)
}

export function respondJavaScript(
  response: ServerResponse,
  payload: string,
): void {
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
  })
  response.end(payload)
}

export function respondCss(
  response: ServerResponse,
  payload: string,
): void {
  response.writeHead(200, {
    'content-type': 'text/css; charset=utf-8',
  })
  response.end(payload)
}

function normalizePermissionDecision(
  value: unknown,
): PermissionDecision | undefined {
  if (value === 'approve' || value === 'deny') {
    return value
  }

  return undefined
}

function normalizeGrantScope(
  value: unknown,
): PermissionGrantScope | undefined {
  if (value === 'once' || value === 'tool' || value === 'risk') {
    return value
  }

  return undefined
}
