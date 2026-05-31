import {
  type ToolCall,
  type ToolContext,
  type ToolFailureClass,
  type ToolRegistry,
  type ToolSearchDescriptor,
  type ToolResult,
} from '../Tool.js'
import {
  createPermissionRequest,
  type PermissionEvaluationResult,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionPrompt,
  type PermissionReviewer,
  RiskAwarePermissionPolicy,
  RuleBasedPermissionReviewer,
} from '../../security/PermissionPolicy.js'
import {
  FileToolResultStorage,
  type ToolResultStorage,
} from './ToolResultStorage.js'
import { planToolExecutionBatches } from './ToolOrchestration.js'

export interface PermissionCheckerResult {
  allowed: boolean
  reason?: string
  evaluation?: PermissionEvaluationResult
}

export interface PermissionChecker {
  canUseTool(toolName: string, input: unknown): Promise<PermissionCheckerResult>
}

export interface ToolRuntimeHookPayload {
  call: ToolCall
  context: ToolContext
  result?: ToolResult
  note?: string
}

export interface BeforeModelCallHookPayload {
  toolCatalogSize: number
  discoverableToolCount: number
  note?: string
}

export interface ToolRuntimeHooks {
  beforeToolCall?: (payload: ToolRuntimeHookPayload) => Promise<void> | void
  afterToolCall?: (payload: ToolRuntimeHookPayload) => Promise<void> | void
  beforeModelCall?: (payload: BeforeModelCallHookPayload) => Promise<void> | void
  beforeHttpRequest?: (payload: ToolRuntimeHookPayload) => Promise<void> | void
}

export interface ToolSearchResult {
  name: string
  description: string
  availability: 'core' | 'discoverable'
  searchHints: string[]
  riskLevel: 'low' | 'medium' | 'high'
  inputSchema: ToolSearchDescriptor['inputSchema']
  resultPolicy?: ToolSearchDescriptor['resultPolicy']
  permissionProfile?: ToolSearchDescriptor['permissionProfile']
}

export class AllowAllPermissionChecker implements PermissionChecker {
  async canUseTool(): Promise<PermissionCheckerResult> {
    return { allowed: true }
  }
}

export class PolicyPermissionChecker implements PermissionChecker {
  private readonly approvedTools = new Set<string>()
  private readonly approvedRiskLevels = new Set<
    PermissionEvaluationResult['classification']['riskLevel']
  >()
  private readonly permissionMode: PermissionMode

  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: PermissionPolicy = new RiskAwarePermissionPolicy(),
    private readonly permissionPrompt?: PermissionPrompt,
    private readonly reviewer: PermissionReviewer = new RuleBasedPermissionReviewer(),
    private readonly filesystemRoots?: {
      workspaceRoot: string
      desktopRoot?: string
    },
  ) {
    this.permissionMode =
      policy instanceof RiskAwarePermissionPolicy
        ? policy.getMode()
        : 'default'
  }

  async canUseTool(toolName: string, input: unknown): Promise<PermissionCheckerResult> {
    const tool = this.registry.get(toolName)
    if (!tool) {
      return {
        allowed: false,
        reason: 'TOOL_NOT_FOUND',
      }
    }

    const request = createPermissionRequest(
      toolName,
      input,
      tool.riskLevel,
      tool.permissionProfile?.grantScopes,
      this.filesystemRoots,
    )

    if (this.approvedTools.has(toolName)) {
      return {
        allowed: true,
        evaluation: {
          decision: 'allow',
          reason: `session grant already approved tool ${toolName}`,
          classification: request.readonlyShell
            ? {
                riskLevel: request.riskLevel,
                reason: request.riskReason,
                readonlyShell: true,
              }
            : {
                riskLevel: request.riskLevel,
                reason: request.riskReason,
              },
          grantScope: 'tool',
        },
      }
    }

    if (this.approvedRiskLevels.has(request.riskLevel)) {
      return {
        allowed: true,
        evaluation: {
          decision: 'allow',
          reason: `session grant already approved risk level ${request.riskLevel}`,
          classification: request.readonlyShell
            ? {
                riskLevel: request.riskLevel,
                reason: request.riskReason,
                readonlyShell: true,
              }
            : {
                riskLevel: request.riskLevel,
                reason: request.riskReason,
              },
          grantScope: 'risk',
        },
      }
    }

    const evaluation = await this.policy.evaluate(request)
    const requiresReview =
      tool.permissionProfile?.classifier === 'review-required' ||
      (
        request.riskLevel === 'high' &&
        (
          toolName === 'windows.click' ||
          toolName === 'windows.type' ||
          toolName === 'windows.shortcut' ||
          toolName === 'windows.move_or_drag' ||
          toolName === 'windows.process' ||
          toolName === 'windows.shell'
        )
      ) ||
      (toolName === 'windows.clipboard' && request.riskLevel !== 'low')

    const reviewed = requiresReview && this.permissionMode !== 'auto'
      ? await this.reviewer.review(request)
      : undefined

    const mergedEvaluation = reviewed
      ? {
          ...evaluation,
          decision: reviewed.decision,
          reason: reviewed.reason ?? evaluation.reason,
          grantScope: reviewed.grantScope ?? evaluation.grantScope,
          reviewStage: reviewed.reviewStage,
          reviewSource: reviewed.reviewSource,
        }
      : evaluation

    if (mergedEvaluation.decision === 'allow') {
      return {
        allowed: true,
        evaluation: mergedEvaluation,
      }
    }

    if (mergedEvaluation.decision === 'ask') {
      if (!this.permissionPrompt) {
        return {
          allowed: false,
          reason: mergedEvaluation.reason ?? 'TOOL_PERMISSION_REQUIRES_CONFIRMATION',
          evaluation: mergedEvaluation,
        }
      }

      const promptDecision = await this.permissionPrompt.confirm({
        ...request,
        reasonText: mergedEvaluation.reason,
      })

      if (promptDecision.approved) {
        if (promptDecision.grantScope === 'tool') {
          this.approvedTools.add(toolName)
        }

        if (promptDecision.grantScope === 'risk') {
          this.approvedRiskLevels.add(request.riskLevel)
        }

        return {
          allowed: true,
          evaluation: {
            ...mergedEvaluation,
            grantScope: promptDecision.grantScope ?? mergedEvaluation.grantScope,
          },
        }
      }

      return {
        allowed: false,
        reason:
          promptDecision.reason ??
          mergedEvaluation.reason ??
          'TOOL_PERMISSION_REJECTED_BY_USER',
        evaluation: mergedEvaluation,
      }
    }

    return {
      allowed: false,
      reason: mergedEvaluation.reason ?? 'TOOL_PERMISSION_DENIED',
      evaluation: mergedEvaluation,
    }
  }
}

export function createPermissionChecker(
  registry: ToolRegistry,
  mode: PermissionMode = 'default',
  permissionPrompt?: PermissionPrompt,
  options: {
    filesystemRoots?: {
      workspaceRoot: string
      desktopRoot?: string
    }
  } = {},
): PermissionChecker {
  return new PolicyPermissionChecker(
    registry,
    new RiskAwarePermissionPolicy(mode),
    permissionPrompt,
    new RuleBasedPermissionReviewer(),
    options.filesystemRoots,
  )
}

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionChecker: PermissionChecker,
    private readonly resultStorage: ToolResultStorage = new FileToolResultStorage(),
    private readonly hooks: ToolRuntimeHooks = {},
  ) {}

  searchTools(query: string, options: { includeCore?: boolean } = {}): ToolSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase()
    const includeCore = options.includeCore ?? true

    return this.registry
      .list()
      .filter(tool => includeCore || tool.availability === 'discoverable')
      .map(tool => ({
        tool,
        score: scoreTool(query, normalizedQuery, tool.searchHints, tool.description),
      }))
      .filter(candidate => candidate.score > 0 || normalizedQuery.length === 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }
        return left.tool.name.localeCompare(right.tool.name)
      })
      .map(candidate => ({
        name: candidate.tool.name,
        description: candidate.tool.description,
        availability: candidate.tool.availability ?? 'core',
        searchHints:
          candidate.tool.searchHints && candidate.tool.searchHints.length > 0
            ? candidate.tool.searchHints
            : candidate.tool.searchHint
              ? [candidate.tool.searchHint]
              : [],
        riskLevel: candidate.tool.riskLevel,
        inputSchema: candidate.tool.inputSchema,
        resultPolicy: candidate.tool.resultPolicy,
        permissionProfile: candidate.tool.permissionProfile,
      }))
  }

  async notifyBeforeModelCall(): Promise<void> {
    const tools = this.registry.list()
    const discoverableToolCount = tools.filter(
      tool => (tool.availability ?? 'core') === 'discoverable',
    ).length

    await this.runHook('beforeModelCall', {
      toolCatalogSize: tools.length,
      discoverableToolCount,
      note: 'model context assembly',
    })
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    return this.executeSingle(call, context)
  }

  async executeMany(
    calls: ToolCall[],
    context: ToolContext,
  ): Promise<ToolResult[]> {
    const batches = planToolExecutionBatches(calls, this.registry)
    const results: ToolResult[] = []

    for (const batch of batches) {
      if (batch.mode === 'parallel') {
        results.push(
          ...(await Promise.all(
            batch.calls.map(call => this.executeSingle(call, context)),
          )),
        )
        continue
      }

      for (const call of batch.calls) {
        results.push(await this.executeSingle(call, context))
      }
    }

    return results
  }

  private async executeSingle(
    call: ToolCall,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(call.toolName)
    if (!tool) {
      return {
        ok: false,
        summary: `Tool not found: ${call.toolName}`,
        error: 'TOOL_NOT_FOUND',
        failureClass: 'missing_dependency',
      }
    }

    await this.runHook('beforeToolCall', { call, context })

    const decision = await this.permissionChecker.canUseTool(call.toolName, call.input)
    if (!decision.allowed) {
      const deniedResult: ToolResult = {
        ok: false,
        summary: `Tool denied: ${call.toolName}`,
        error: decision.reason ?? 'TOOL_PERMISSION_DENIED',
        failureClass: 'permission',
        data: decision.evaluation
          ? {
              permission: {
                decision: decision.evaluation.decision,
                riskLevel: decision.evaluation.classification.riskLevel,
                reason: decision.evaluation.reason,
                grantScope: decision.evaluation.grantScope,
                reviewStage: decision.evaluation.reviewStage,
                reviewSource: decision.evaluation.reviewSource,
                auditMetadata: decision.evaluation.auditMetadata,
              },
            }
          : undefined,
        auditTrail: decision.evaluation
          ? [
              {
                stage: decision.evaluation.reviewStage ?? 'static',
                source: decision.evaluation.reviewSource ?? 'policy',
                decision: decision.evaluation.decision,
                reason: decision.evaluation.reason,
                metadata: decision.evaluation.auditMetadata,
              },
            ]
          : undefined,
      }
      await this.runHook('afterToolCall', { call, context, result: deniedResult })
      return deniedResult
    }

    try {
      if (call.toolName.startsWith('windows.') || call.toolName === 'windows.shell') {
        await this.runHook('beforeHttpRequest', {
          call,
          context,
          note: 'windows bridge request',
        })
      }

      const result = await tool.execute(call.input, context)
      const persisted = await this.resultStorage.persistIfNeeded(tool, result, context)
      const auditedResult =
        decision.evaluation?.auditMetadata && Array.isArray(persisted.auditTrail)
          ? {
              ...persisted,
              auditTrail: [
                {
                  stage: decision.evaluation.reviewStage ?? 'static',
                  source: decision.evaluation.reviewSource ?? 'policy',
                  decision: decision.evaluation.decision,
                  reason: decision.evaluation.reason,
                  metadata: decision.evaluation.auditMetadata,
                },
                ...persisted.auditTrail,
              ],
            }
          : decision.evaluation?.auditMetadata
            ? {
                ...persisted,
                auditTrail: [
                  {
                    stage: decision.evaluation.reviewStage ?? 'static',
                    source: decision.evaluation.reviewSource ?? 'policy',
                    decision: decision.evaluation.decision,
                    reason: decision.evaluation.reason,
                    metadata: decision.evaluation.auditMetadata,
                  },
                ],
              }
            : persisted
      await this.runHook('afterToolCall', { call, context, result: auditedResult })
      return auditedResult
    } catch (error) {
      const failedResult: ToolResult = {
        ok: false,
        summary: `Tool execution error: ${call.toolName}`,
        error: error instanceof Error ? error.message : String(error),
        failureClass: classifyExecutionFailure(error),
      }
      await this.runHook('afterToolCall', { call, context, result: failedResult })
      return failedResult
    }
  }

  private async runHook(
    name: 'beforeToolCall' | 'afterToolCall' | 'beforeHttpRequest',
    payload: ToolRuntimeHookPayload,
  ): Promise<void>
  private async runHook(
    name: 'beforeModelCall',
    payload: BeforeModelCallHookPayload,
  ): Promise<void>
  private async runHook(
    name: keyof ToolRuntimeHooks,
    payload:
      | ToolRuntimeHookPayload
      | BeforeModelCallHookPayload,
  ): Promise<void> {
    const hook = this.hooks[name] as
      | ((payload: ToolRuntimeHookPayload | BeforeModelCallHookPayload) => Promise<void> | void)
      | undefined
    if (!hook) {
      return
    }

    await hook(payload)
  }
}

function classifyExecutionFailure(error: unknown): ToolFailureClass {
  if (error instanceof Error) {
    const message = error.message.toUpperCase()
    const code =
      'code' in error ? String((error as Error & { code?: unknown }).code ?? '') : ''

    if (
      code === 'ENOENT' ||
      message.includes('NOT FOUND') ||
      message.includes('MISSING')
    ) {
      return 'missing_dependency'
    }

    if (
      message.includes('TIMEOUT') ||
      message.includes('TIMED OUT') ||
      message.includes('ECONNRESET') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT')
    ) {
      return 'transient'
    }
  }

  return 'deterministic'
}

function scoreTool(
  rawQuery: string,
  normalizedQuery: string,
  searchHints: string[] | undefined,
  description: string,
): number {
  if (!normalizedQuery) {
    return 1
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const fields = [rawQuery, description, ...(searchHints ?? [])]
  let score = 0

  for (const field of fields) {
    const normalizedField = field.toLowerCase()
    if (normalizedField.includes(normalizedQuery)) {
      score += 4
    }

    for (const token of tokens) {
      if (normalizedField.includes(token)) {
        score += 2
      }
    }
  }

  return score
}
