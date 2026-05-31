import { isAbsolute, resolve } from 'node:path'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export type PermissionMode =
  | 'default'
  | 'auto'
  | 'confirm-high-risk'
  | 'read-only'

export type PermissionGrantScope = 'once' | 'tool' | 'risk'

export type FilesystemPermissionScope = 'workspace' | 'desktop' | 'external'

export type FilesystemAccessMode = 'read' | 'write' | 'delete'

export interface FilesystemPermissionPathAuditEvent {
  path: string
  kind: 'primary' | 'target'
  access: FilesystemAccessMode
  scope: FilesystemPermissionScope
}

export interface DesktopPermissionEnvelope {
  surface: 'desktop'
  scopes: FilesystemPermissionScope[]
  access: FilesystemAccessMode
  outcome: 'allow' | 'ask' | 'deny'
}

export interface FilesystemPermissionMetadata {
  access: FilesystemAccessMode
  scopes: FilesystemPermissionScope[]
  envelope: DesktopPermissionEnvelope
  pathAudit: FilesystemPermissionPathAuditEvent[]
}

export interface FilesystemPermissionRoots {
  workspaceRoot: string
  desktopRoot?: string
}

export interface PermissionClassification {
  riskLevel: 'low' | 'medium' | 'high'
  reason?: string
  readonlyShell?: boolean
  filesystem?: FilesystemPermissionMetadata
}

export interface PermissionRequest {
  toolName: string
  input: unknown
  reason: string
  riskLevel: 'low' | 'medium' | 'high'
  declaredRiskLevel?: 'low' | 'medium' | 'high'
  riskReason?: string
  grantScopes: PermissionGrantScope[]
  readonlyShell?: boolean
  filesystemRoots?: FilesystemPermissionRoots
}

export interface PermissionEvaluationResult {
  decision: PermissionDecision
  reason?: string
  classification: PermissionClassification
  grantScope?: PermissionGrantScope
  reviewStage?: 'static' | 'review'
  reviewSource?: 'policy' | 'rule-reviewer'
  auditMetadata?: {
    desktopPermission?: DesktopPermissionEnvelope
    pathAudit?: FilesystemPermissionPathAuditEvent[]
  }
}

export interface PermissionPolicy {
  evaluate(request: PermissionRequest): Promise<PermissionEvaluationResult>
}

export interface PermissionReviewResult {
  decision: PermissionDecision
  reason?: string
  riskLevel: 'low' | 'medium' | 'high'
  grantScope?: PermissionGrantScope
  reviewStage: 'review'
  reviewSource: 'rule-reviewer'
}

export interface PermissionReviewer {
  review(request: PermissionRequest): Promise<PermissionReviewResult>
}

export interface PermissionPrompt {
  confirm(
    request: PermissionRequest & { reasonText?: string },
  ): Promise<{
    approved: boolean
    reason?: string
    grantScope?: PermissionGrantScope
  }>
}

export class PermissionDeniedError extends Error {
  constructor(
    message: string,
    readonly decision: PermissionDecision,
  ) {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

export class StaticPermissionPrompt implements PermissionPrompt {
  constructor(
    private readonly approved: boolean,
    private readonly reason?: string,
    private readonly grantScope: PermissionGrantScope = 'once',
  ) {}

  async confirm(): Promise<{
    approved: boolean
    reason?: string
    grantScope?: PermissionGrantScope
  }> {
    return {
      approved: this.approved,
      reason: this.reason,
      grantScope: this.grantScope,
    }
  }
}

export class RiskAwarePermissionPolicy implements PermissionPolicy {
  constructor(
    private readonly mode: PermissionMode = 'default',
  ) {}

  getMode(): PermissionMode {
    return this.mode
  }

  async evaluate(request: PermissionRequest): Promise<PermissionEvaluationResult> {
    const classification = classifyPermissionRequest(
      request.toolName,
      request.input,
      request.declaredRiskLevel ?? request.riskLevel,
      request.filesystemRoots,
    )
    const normalizedRequest: PermissionRequest = {
      ...request,
      riskLevel: classification.riskLevel,
      riskReason: classification.reason,
      readonlyShell: classification.readonlyShell,
    }
    const riskExplanation = formatRiskExplanation(normalizedRequest)
    const filesystemDecision = classification.filesystem
      ? decisionFromFilesystemClassification(classification.filesystem)
      : undefined

    if (filesystemDecision) {
      return withClassificationMetadata({
        decision: filesystemDecision.decision,
        reason: filesystemDecision.reason,
        classification,
        reviewStage: 'static',
        reviewSource: 'policy',
      })
    }

    switch (this.mode) {
      case 'auto':
        return withClassificationMetadata({
          decision: 'allow',
          classification,
          reviewStage: 'static',
          reviewSource: 'policy',
        })
      case 'read-only':
        if (classification.riskLevel === 'low') {
          return withClassificationMetadata({
            decision: 'allow',
            classification,
            reviewStage: 'static',
            reviewSource: 'policy',
          })
        }
        return withClassificationMetadata({
          decision: 'deny',
          reason: `read-only mode denied ${request.toolName}. ${riskExplanation}`,
          classification,
          reviewStage: 'static',
          reviewSource: 'policy',
        })
      case 'confirm-high-risk':
        if (classification.riskLevel === 'high') {
          return withClassificationMetadata({
            decision: 'ask',
            reason: `high-risk tool ${request.toolName} requires confirmation. ${riskExplanation}`,
            classification,
            grantScope: 'once',
            reviewStage: 'static',
            reviewSource: 'policy',
          })
        }
        return withClassificationMetadata({
          decision: 'allow',
          classification,
          reviewStage: 'static',
          reviewSource: 'policy',
        })
      case 'default':
      default:
        if (classification.riskLevel === 'high') {
          return withClassificationMetadata({
            decision: 'deny',
            reason: `default mode denied high-risk tool ${request.toolName}. ${riskExplanation}`,
            classification,
            reviewStage: 'static',
            reviewSource: 'policy',
          })
        }
        return withClassificationMetadata({
          decision: 'allow',
          classification,
          reviewStage: 'static',
          reviewSource: 'policy',
        })
    }
  }
}

export class RuleBasedPermissionReviewer implements PermissionReviewer {
  async review(request: PermissionRequest): Promise<PermissionReviewResult> {
    const reason = buildReviewerReason(request)

    if (request.readonlyShell) {
      return {
        decision: 'allow',
        reason,
        riskLevel: request.riskLevel,
        reviewStage: 'review',
        reviewSource: 'rule-reviewer',
      }
    }

    if (
      request.toolName === 'windows.click' ||
      request.toolName === 'windows.move_or_drag' ||
      request.toolName === 'windows.process' ||
      request.toolName === 'windows.shortcut'
    ) {
      return {
        decision: 'ask',
        reason,
        riskLevel: request.riskLevel,
        grantScope: 'once',
        reviewStage: 'review',
        reviewSource: 'rule-reviewer',
      }
    }

    if (
      request.toolName === 'windows.shell' &&
      request.riskLevel !== 'low'
    ) {
      return {
        decision: 'ask',
        reason,
        riskLevel: request.riskLevel,
        grantScope: 'once',
        reviewStage: 'review',
        reviewSource: 'rule-reviewer',
      }
    }

    return {
      decision: request.riskLevel === 'high' ? 'ask' : 'allow',
      reason,
      riskLevel: request.riskLevel,
      grantScope: request.riskLevel === 'high' ? 'once' : undefined,
      reviewStage: 'review',
      reviewSource: 'rule-reviewer',
    }
  }
}

export function createPermissionRequest(
  toolName: string,
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
  grantScopes: PermissionGrantScope[] = ['once', 'tool', 'risk'],
  filesystemRoots?: FilesystemPermissionRoots,
): PermissionRequest {
  const classification = classifyPermissionRequest(
    toolName,
    input,
    declaredRiskLevel,
    filesystemRoots,
  )

  return {
    toolName,
    input,
    reason: `model requested tool ${toolName}`,
    riskLevel: classification.riskLevel,
    declaredRiskLevel,
    riskReason: classification.reason,
    grantScopes,
    readonlyShell: classification.readonlyShell,
    filesystemRoots,
  }
}

export function classifyPermissionRequest(
  toolName: string,
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
  filesystemRoots?: FilesystemPermissionRoots,
): PermissionClassification {
  switch (toolName) {
    case 'windows.type':
      return classifyWindowsTypeInput(input, declaredRiskLevel)
    case 'windows.focus_window':
      return classifyFocusWindowInput(input, declaredRiskLevel)
    case 'windows.click':
      return {
        riskLevel: 'high',
        reason: 'Click directly affects the current desktop focus and cannot be proven safe statically.',
      }
    case 'windows.scroll':
      return {
        riskLevel: 'medium',
        reason: 'Scroll changes viewport state but is less destructive than direct click or typing.',
      }
    case 'windows.move_or_drag':
      return classifyMoveOrDragInput(input, declaredRiskLevel)
    case 'windows.shortcut':
      return classifyShortcutInput(input, declaredRiskLevel)
    case 'windows.clipboard':
      return classifyClipboardInput(input, declaredRiskLevel)
    case 'windows.process':
      return classifyProcessInput(input, declaredRiskLevel)
    case 'windows.registry':
      return {
        riskLevel: 'high',
        reason: 'Registry mutation is system-destructive and always high risk.',
      }
    case 'windows.shell':
      return classifyShellInput(input, declaredRiskLevel)
    case 'windows.filesystem':
      return classifyFilesystemInput(input, declaredRiskLevel, filesystemRoots)
    case 'windows.notification':
      return {
        riskLevel: 'medium',
        reason: 'Notifications change visible system state but are not destructive.',
      }
    default:
      return {
        riskLevel: declaredRiskLevel,
      }
  }
}

function classifyWindowsTypeInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { text?: unknown }).text !== 'string'
  ) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Input shape is invalid, so the declared risk is preserved.',
    }
  }

  const text = (input as { text: string }).text
  const normalized = text.trim()
  const sensitivePattern =
    /(password|passwd|token|secret|api[_-]?key|authorization|cookie|setx|reg add|shutdown|format|powershell|cmd\.exe|curl|invoke-webrequest)/i

  if (normalized.length === 0) {
    return {
      riskLevel: 'medium',
      reason: 'Empty input is still an active UI action.',
    }
  }

  if (
    sensitivePattern.test(normalized) ||
    /[\r\n\t]/.test(text) ||
    normalized.length > 80
  ) {
    return {
      riskLevel: 'high',
      reason: 'Input may include secrets, commands, or large multi-line content.',
    }
  }

  return {
    riskLevel: 'medium',
    reason: 'Single-line text input is safer but still writes to the focused UI target.',
  }
}

function classifyFocusWindowInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { windowTitle?: unknown }).windowTitle !== 'string'
  ) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Window title is invalid, so the declared risk is preserved.',
    }
  }

  const windowTitle = (input as { windowTitle: string }).windowTitle.trim()
  const systemWindowPattern =
    /(powershell|terminal|cmd|regedit|registry|task manager|windows security|设置|控制面板)/i

  if (windowTitle.length === 0) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Empty window title cannot be evaluated safely.',
    }
  }

  if (systemWindowPattern.test(windowTitle)) {
    return {
      riskLevel: 'medium',
      reason: 'System or administrative windows remain medium risk.',
    }
  }

  return {
    riskLevel: 'low',
    reason: 'Window focusing alone does not directly mutate state.',
  }
}

function classifyShortcutInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  const shortcut =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { shortcut?: unknown }).shortcut === 'string'
      ? (input as { shortcut: string }).shortcut.trim().toLowerCase()
      : ''

  if (!shortcut) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Shortcut is missing or invalid.',
    }
  }

  if (/(alt\+f4|win\+r|ctrl\+shift\+esc|win|del|delete)/i.test(shortcut)) {
    return {
      riskLevel: 'high',
      reason: 'Shortcut can trigger global or destructive system actions.',
    }
  }

  return {
    riskLevel: 'medium',
    reason: 'Shortcut changes UI state and should not be considered read-only.',
  }
}

function classifyClipboardInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  const mode =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { mode?: unknown }).mode === 'string'
      ? (input as { mode: string }).mode
      : undefined

  if (mode === 'get') {
    return {
      riskLevel: 'low',
      reason: 'Clipboard read is read-only.',
    }
  }

  if (mode === 'set') {
    return {
      riskLevel: 'medium',
      reason: 'Clipboard write changes cross-application state.',
    }
  }

  return {
    riskLevel: declaredRiskLevel,
    reason: 'Clipboard mode is unknown.',
  }
}

function classifyMoveOrDragInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  const drag =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { drag?: unknown }).drag === 'boolean'
      ? (input as { drag: boolean }).drag
      : false

  if (drag) {
    return {
      riskLevel: 'high',
      reason: 'Drag can move or rearrange desktop state and is treated as high risk.',
    }
  }

  return {
    riskLevel: 'medium',
    reason: 'Cursor movement changes UI focus context but is less destructive than drag.',
  }
}

function classifyProcessInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  const mode =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { mode?: unknown }).mode === 'string'
      ? (input as { mode: string }).mode
      : undefined

  if (mode === 'list') {
    return {
      riskLevel: 'low',
      reason: 'Process listing is read-only.',
    }
  }

  if (mode === 'kill') {
    return {
      riskLevel: 'high',
      reason: 'Process termination is destructive.',
    }
  }

  return {
    riskLevel: declaredRiskLevel,
    reason: 'Process mode is unknown.',
  }
}

function classifyShellInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
): PermissionClassification {
  const command =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { command?: unknown }).command === 'string'
      ? (input as { command: string }).command.trim()
      : typeof input === 'string'
        ? input.trim()
        : ''

  if (!command) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Shell command is missing or invalid.',
    }
  }

  if (isReadonlyShellCommand(command)) {
    return {
      riskLevel: 'low',
      reason: 'Shell command matched the read-only allowlist.',
      readonlyShell: true,
    }
  }

  if (isApprovedAppLaunchShellCommand(command)) {
    return {
      riskLevel: 'medium',
      reason: 'Shell command matches the controlled app-launch allowlist.',
      readonlyShell: false,
    }
  }

  if (/(remove-item|del |erase |move-item|copy-item|set-item|reg add|taskkill|stop-process|shutdown|restart-computer|format|setx|sc.exe|start-process)/i.test(command)) {
    return {
      riskLevel: 'high',
      reason: 'Shell command appears to mutate system state or terminate processes.',
      readonlyShell: false,
    }
  }

  return {
    riskLevel: 'medium',
    reason: 'Shell command is not proven read-only, so it remains medium risk.',
    readonlyShell: false,
  }
}

function classifyFilesystemInput(
  input: unknown,
  declaredRiskLevel: 'low' | 'medium' | 'high',
  filesystemRoots?: FilesystemPermissionRoots,
): PermissionClassification {
  const request = readFilesystemRequest(input)
  if (!request) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Filesystem mode is unknown.',
    }
  }

  const access = classifyFilesystemAccessMode(request.mode)
  if (!access) {
    return {
      riskLevel: declaredRiskLevel,
      reason: 'Filesystem mode is unknown.',
    }
  }

  const pathAudit = buildFilesystemPathAuditEvents(
    request,
    access,
    filesystemRoots,
  )
  const scopes = dedupeScopes(pathAudit.map(event => event.scope))
  const envelope = buildDesktopPermissionEnvelope(scopes, access)

  if (scopes.includes('external')) {
    return {
      riskLevel: 'high',
      reason: 'Filesystem access to external paths is denied by sandbox policy.',
      filesystem: {
        access,
        scopes,
        envelope,
        pathAudit,
      },
    }
  }

  if (scopes.includes('desktop')) {
    return {
      riskLevel: access === 'read' ? 'medium' : 'high',
      reason:
        access === 'read'
          ? 'Filesystem access to Desktop paths requires confirmation.'
          : 'Filesystem mutation on Desktop paths requires confirmation.',
      filesystem: {
        access,
        scopes,
        envelope,
        pathAudit,
      },
    }
  }

  return {
    riskLevel: access === 'read' ? 'low' : access === 'delete' ? 'high' : 'medium',
    reason:
      access === 'read'
        ? 'Filesystem access stays within the workspace sandbox and is read-only.'
        : access === 'delete'
          ? 'Filesystem delete stays within the workspace sandbox but remains destructive.'
          : 'Filesystem mutation stays within the workspace sandbox.',
    filesystem: {
      access,
      scopes,
      envelope,
      pathAudit,
    },
  }
}

function isReadonlyShellCommand(command: string): boolean {
  return /^(Get-ChildItem|Get-Content|Get-Item|Get-Process|Get-Service|Get-Date|Resolve-Path|where|which|dir|ls|type |cat |pwd|Select-String|rg\b)/i.test(
    command,
  )
}

function isApprovedAppLaunchShellCommand(command: string): boolean {
  return /^Start-Process\s+(notepad(?:\.exe)?|calc(?:\.exe)?|mspaint(?:\.exe)?)\s*$/i.test(
    command.trim(),
  )
}

function formatRiskExplanation(request: PermissionRequest): string {
  const parts: string[] = []

  if (request.declaredRiskLevel && request.declaredRiskLevel !== request.riskLevel) {
    parts.push(
      `declared risk=${request.declaredRiskLevel}, classified risk=${request.riskLevel}.`,
    )
  } else {
    parts.push(`classified risk=${request.riskLevel}.`)
  }

  if (request.riskReason) {
    parts.push(request.riskReason)
  }

  if (request.readonlyShell) {
    parts.push('shell command matched readonly allowlist.')
  }

  if (request.filesystemRoots && request.toolName === 'windows.filesystem') {
    const filesystemDetails = classifyFilesystemInput(
      request.input,
      request.declaredRiskLevel ?? request.riskLevel,
      request.filesystemRoots,
    ).filesystem
    if (filesystemDetails) {
      parts.push(
        `filesystem access=${filesystemDetails.access}; scopes=${filesystemDetails.scopes.join(',')}.`,
      )
    }
  }

  return parts.join(' ')
}

function buildReviewerReason(request: PermissionRequest): string {
  return [
    `rule reviewer inspected ${request.toolName}.`,
    `classified risk=${request.riskLevel}.`,
    request.riskReason ?? 'no extra risk reason.',
  ].join(' ')
}

function withClassificationMetadata(
  evaluation: PermissionEvaluationResult,
): PermissionEvaluationResult {
  const filesystem = evaluation.classification.filesystem
  if (!filesystem) {
    return evaluation
  }

  return {
    ...evaluation,
    auditMetadata: {
      desktopPermission: {
        ...filesystem.envelope,
        outcome: evaluation.decision,
      },
      pathAudit: filesystem.pathAudit,
    },
  }
}

function decisionFromFilesystemClassification(
  filesystem: FilesystemPermissionMetadata,
): {
  decision: PermissionDecision
  reason: string
} {
  if (filesystem.scopes.includes('external')) {
    return {
      decision: 'deny',
      reason: 'Filesystem access to external paths is denied by sandbox policy.',
    }
  }

  if (filesystem.scopes.includes('desktop')) {
    return {
      decision: 'ask',
      reason:
        filesystem.access === 'read'
          ? 'Filesystem access to Desktop paths requires confirmation.'
          : 'Filesystem mutation on Desktop paths requires confirmation.',
    }
  }

  return {
    decision: 'allow',
    reason:
      filesystem.access === 'read'
        ? 'Filesystem access stays within the workspace sandbox and is read-only.'
        : filesystem.access === 'delete'
          ? 'Filesystem delete stays within the workspace sandbox but remains destructive.'
          : 'Filesystem mutation stays within the workspace sandbox.',
  }
}

function readFilesystemRequest(
  input: unknown,
):
  | {
      mode: string
      path?: string
      targetPath?: string
    }
  | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }

  const candidate = input as {
    mode?: unknown
    path?: unknown
    targetPath?: unknown
  }
  if (typeof candidate.mode !== 'string') {
    return undefined
  }

  return {
    mode: candidate.mode,
    path: typeof candidate.path === 'string' ? candidate.path : undefined,
    targetPath:
      typeof candidate.targetPath === 'string' ? candidate.targetPath : undefined,
  }
}

function classifyFilesystemAccessMode(
  mode: string,
): FilesystemAccessMode | undefined {
  if (mode === 'read' || mode === 'list' || mode === 'search' || mode === 'info') {
    return 'read'
  }

  if (mode === 'delete') {
    return 'delete'
  }

  if (mode === 'write' || mode === 'copy' || mode === 'move') {
    return 'write'
  }

  return undefined
}

function buildFilesystemPathAuditEvents(
  request: {
    mode: string
    path?: string
    targetPath?: string
  },
  access: FilesystemAccessMode,
  filesystemRoots?: FilesystemPermissionRoots,
): FilesystemPermissionPathAuditEvent[] {
  const events: FilesystemPermissionPathAuditEvent[] = []

  const primaryPath = normalizeFilesystemPath(
    request.path,
    filesystemRoots?.workspaceRoot,
  )
  if (primaryPath) {
    events.push({
      path: primaryPath,
      kind: 'primary',
      access,
      scope: classifyFilesystemScope(primaryPath, filesystemRoots),
    })
  }

  const targetPath = normalizeFilesystemPath(
    request.targetPath,
    filesystemRoots?.workspaceRoot,
  )
  if (targetPath) {
    events.push({
      path: targetPath,
      kind: 'target',
      access: request.mode === 'move' ? 'write' : access,
      scope: classifyFilesystemScope(targetPath, filesystemRoots),
    })
  }

  return events
}

function normalizeFilesystemPath(
  path: string | undefined,
  workspaceRoot?: string,
): string | undefined {
  const trimmed = path?.trim()
  if (!trimmed) {
    return undefined
  }

  return isAbsolute(trimmed) || !workspaceRoot
    ? resolve(trimmed)
    : resolve(workspaceRoot, trimmed)
}

function classifyFilesystemScope(
  path: string,
  filesystemRoots?: FilesystemPermissionRoots,
): FilesystemPermissionScope {
  const normalizedPath = normalizePathForComparison(path)
  const workspaceRoot = normalizePathForComparison(filesystemRoots?.workspaceRoot)
  const desktopRoot = normalizePathForComparison(filesystemRoots?.desktopRoot)

  if (!normalizedPath) {
    return 'external'
  }

  if (workspaceRoot && isWithinRoot(normalizedPath, workspaceRoot)) {
    return 'workspace'
  }

  if (desktopRoot && isWithinRoot(normalizedPath, desktopRoot)) {
    return 'desktop'
  }

  return 'external'
}

function normalizePathForComparison(path: string | undefined): string | undefined {
  const trimmed = path?.trim()
  if (!trimmed) {
    return undefined
  }

  return ensureTrailingSeparator(resolve(trimmed).toLowerCase())
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root)
}

function ensureTrailingSeparator(path: string): string {
  return path.endsWith('\\') || path.endsWith('/') ? path : `${path}\\`
}

function dedupeScopes(
  scopes: FilesystemPermissionScope[],
): FilesystemPermissionScope[] {
  return [...new Set(scopes)]
}

function buildDesktopPermissionEnvelope(
  scopes: FilesystemPermissionScope[],
  access: FilesystemAccessMode,
): DesktopPermissionEnvelope {
  return {
    surface: 'desktop',
    scopes: scopes.length > 0 ? scopes : ['external'],
    access,
    outcome: scopes.includes('external')
      ? 'deny'
      : scopes.includes('desktop')
        ? 'ask'
        : 'allow',
  }
}
