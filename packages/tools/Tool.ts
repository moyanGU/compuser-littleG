export type ToolRiskLevel = 'low' | 'medium' | 'high'

export type ToolExecutionMode = 'sync' | 'async'

export type ToolAvailability = 'core' | 'discoverable'

export type ToolFailureClass =
  | 'transient'
  | 'deterministic'
  | 'permission'
  | 'missing_dependency'

export interface ToolSchema {
  description: string
  properties?: Record<string, unknown>
  required?: string[]
}

export interface ToolResultPolicy {
  inlineMaxChars?: number
  storeRaw?: boolean
  readBackTool?: string
}

export interface ToolPermissionProfile {
  grantScopes?: Array<'once' | 'tool' | 'risk'>
  classifier?: 'static-rule' | 'review-required'
  readOnly?: boolean
}

export interface ToolSearchDescriptor {
  name: string
  description: string
  availability: ToolAvailability
  searchHints: string[]
  riskLevel: ToolRiskLevel
  inputSchema: ToolSchema
  resultPolicy?: ToolResultPolicy
  permissionProfile?: ToolPermissionProfile
}

export interface ToolResult<TData = unknown> {
  ok: boolean
  summary: string
  data?: TData
  error?: string
  failureClass?: ToolFailureClass
  pointer?: string
  auditTrail?: Array<{
    stage: string
    source: string
    decision?: string
    reason?: string
    metadata?: Record<string, unknown>
  }>
}

export interface ToolContext {
  cwd: string
  sessionId: string
  turnId: string
  signal?: AbortSignal
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  availability?: ToolAvailability
  searchHint?: string
  searchHints?: string[]
  riskLevel: ToolRiskLevel
  executionMode: ToolExecutionMode
  concurrencySafe: boolean
  inputSchema: ToolSchema
  maxResultChars?: number
  resultPolicy?: ToolResultPolicy
  permissionProfile?: ToolPermissionProfile
  execute: (
    input: TInput,
    context: ToolContext,
  ) => Promise<ToolResult<TOutput>>
}

export type AnyToolDefinition = ToolDefinition<any, any>

export interface ToolCall<TInput = unknown> {
  callId?: string
  toolName: string
  input: TInput
}

export interface ToolRegistry {
  register(tool: AnyToolDefinition): void
  get(toolName: string): AnyToolDefinition | undefined
  list(): AnyToolDefinition[]
}

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>()

  register(tool: AnyToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  get(toolName: string): AnyToolDefinition | undefined {
    return this.tools.get(toolName)
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()]
  }
}
