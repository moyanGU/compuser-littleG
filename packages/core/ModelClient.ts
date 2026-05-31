import type { AssembledContext } from '../harness/context/ContextAssembler.js'
import type { MemoryFact } from '../harness/context/ContextAssembler.js'
import type { ToolCall } from '../tools/Tool.js'
import type { QueryMessage } from './QueryEngine.js'
import {
  createLinkedAbortSignal,
  ExecutionAbortedError,
} from './ExecutionControl.js'

export interface ModelRequest {
  context: AssembledContext
  messages: QueryMessage[]
  signal?: AbortSignal
}

export type ModelResponse =
  | {
      type: 'final'
      message: string
    }
  | {
      type: 'tool_calls'
      assistantMessage: string
      toolCalls: ToolCall[]
    }

export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>
  generateCompact(request: {
    kind: 'session-memory' | 'full'
    messages: QueryMessage[]
    signal?: AbortSignal
  }): Promise<{
    summaryText: string
    memoryFacts?: MemoryFact[]
  }>
}

export interface OpenAICompatibleModelClientOptions {
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  stream?: boolean
  maxRetries?: number
  retryDelayMs?: number
  compatibilityMode?: 'strict' | 'openai' | 'ollama' | 'generic'
  extraHeaders?: Record<string, string>
}

export type OpenAICompatibleCompatibilityMode =
  | 'strict'
  | 'openai'
  | 'ollama'
  | 'generic'

export type OpenAICompatibleErrorCode =
  | 'http_error'
  | 'timeout'
  | 'api_error'
  | 'network_error'
  | 'stream_error'
  | 'parse_error'
  | 'response_shape_error'
  | 'tool_schema_error'

export class DemoModelClient implements ModelClient {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const lastMessage = request.messages.at(-1)

    if (lastMessage?.role === 'tool') {
      if (request.context.routingPlan.executionState.recentAttempts.length >= 2) {
        return {
          type: 'final',
          message: `已完成工具调用。最近一次工具结果为：${lastMessage.content}`,
        }
      }

      const recoveryAction = selectRecoveryActionFromRoutingState(
        request.context,
      )
      if (recoveryAction) {
        return {
          type: 'tool_calls',
          assistantMessage: recoveryAction.assistantMessage,
          toolCalls: [
            {
              toolName: recoveryAction.toolName,
              input: recoveryAction.input,
            },
          ],
        }
      }

      return {
        type: 'final',
        message: `已完成工具调用。最近一次工具结果为：${lastMessage.content}`,
      }
    }

    const nextAction = selectNextActionFromRoutingPlan(request.context)
    if (nextAction) {
      return {
        type: 'tool_calls',
        assistantMessage: nextAction.assistantMessage,
        toolCalls: [
          {
            toolName: nextAction.toolName,
            input: nextAction.input,
          },
        ],
      }
    }

    return {
      type: 'final',
      message: 'QueryEngine 已接入可迭代模型接口。当前 DemoModelClient 会按请求决定是否调用工具。',
    }
  }

  async generateCompact(request: {
    kind: 'session-memory' | 'full'
    messages: QueryMessage[]
    signal?: AbortSignal
  }): Promise<{
    summaryText: string
    memoryFacts?: MemoryFact[]
  }> {
    if (request.kind === 'session-memory') {
      return {
        summaryText: `Session-memory compact summarized ${request.messages.length} messages in demo mode.`,
        memoryFacts: [],
      }
    }

    return {
      summaryText: `Full compact summarized ${request.messages.length} messages in demo mode.`,
    }
  }
}

type OpenAICompatibleChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

export type OpenAICompatibleChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string
            text?: string
            content?: string
          }>
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
        name?: string
        arguments?: string
      }>
    }
    finish_reason?: string
  }>
  error?: {
    message?: string
  }
}

type OpenAICompatibleChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?:
        | string
        | Array<{
            type?: string
            text?: string
            content?: string
          }>
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string
  }>
  error?: {
    message?: string
  }
}

export class OpenAICompatibleModelClient implements ModelClient {
  constructor(
    private readonly options: OpenAICompatibleModelClientOptions,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const maxRetries = this.options.maxRetries ?? 2
    const retryDelayMs = this.options.retryDelayMs ?? 1_000

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const payload = await this.executeRequest(request)
        return parseModelResponse(payload, request.context, {
          compatibilityMode: this.options.compatibilityMode ?? 'generic',
        })
      } catch (error) {
        const retryable = isRetryableRequestError(error)
        if (!retryable || attempt >= maxRetries) {
          throw error
        }

        await delay(retryDelayMs * (attempt + 1))
      }
    }

    throw new OpenAICompatibleRequestError(
      'OpenAI-compatible request exhausted retries without result.',
      {
        code: 'network_error',
        retryable: true,
      },
    )
  }

  async generateCompact(request: {
    kind: 'session-memory' | 'full'
    messages: QueryMessage[]
    signal?: AbortSignal
  }): Promise<{
    summaryText: string
    memoryFacts?: MemoryFact[]
  }> {
    const prompt =
      request.kind === 'session-memory'
        ? buildCompactSessionMemoryRequest(request.messages)
        : buildCompactFullRequest(request.messages)
    const payload = await this.executeCompactRequest(prompt, request.signal)
    const text = extractAssistantContent(payload).trim()

    if (request.kind === 'session-memory') {
      const parsed = parseJsonObject(text)
      return {
        summaryText: stringifyCompactMemorySummary(parsed),
        memoryFacts: mapSessionMemoryFacts(parsed),
      }
    }

    return {
      summaryText: extractCompactSummary(text),
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(this.options.apiKey
        ? { authorization: `Bearer ${this.options.apiKey}` }
        : {}),
      ...this.options.extraHeaders,
    }
  }

  private buildRequestBody(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      temperature: this.options.temperature ?? 0,
      messages: buildApiMessages(request),
      tools: buildApiTools(request.context),
      stream: this.options.stream ?? false,
    }

    applyCompatibilityOptions(
      body,
      this.options.compatibilityMode ?? 'generic',
    )

    if (this.options.maxTokens !== undefined) {
      body.max_tokens = this.options.maxTokens
    }

    return body
  }

  private async executeRequest(
    request: ModelRequest,
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    const timeoutMs = this.options.timeoutMs ?? 60_000
    const linkedSignal = createLinkedAbortSignal({
      timeoutMs,
      externalSignal: request.signal,
    })

    try {
      const response = await fetch(this.options.baseUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildRequestBody(request)),
        signal: linkedSignal.signal,
      })

      if (!response.ok) {
        const responseText = await response.text()
        throw new OpenAICompatibleRequestError(
          `OpenAI-compatible request failed: ${response.status} ${response.statusText} ${responseText}`,
          {
            code: 'http_error',
            retryable: isRetryableStatus(response.status),
            status: response.status,
          },
        )
      }

      const payload = await this.readResponsePayload(response)

      if (payload.error?.message) {
        throw new OpenAICompatibleRequestError(
          `OpenAI-compatible request returned error: ${payload.error.message}`,
          {
            code: 'api_error',
            retryable: false,
          },
        )
      }

      return payload
    } catch (error) {
      if (isAbortError(error)) {
        if (linkedSignal.didExternalAbort()) {
          throw new ExecutionAbortedError(
            'OpenAI-compatible request aborted by external stop signal.',
          )
        }
        throw new OpenAICompatibleRequestError(
          `OpenAI-compatible request timed out after ${timeoutMs}ms.`,
          {
            code: 'timeout',
            retryable: true,
          },
        )
      }

      if (error instanceof OpenAICompatibleRequestError) {
        throw error
      }

      if (error instanceof Error) {
        throw new OpenAICompatibleRequestError(error.message, {
          code: 'network_error',
          retryable: true,
          cause: error,
        })
      }

      throw error
    } finally {
      linkedSignal.dispose()
    }
  }

  private async readResponsePayload(
    response: Response,
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    const contentType = response.headers.get('content-type') ?? ''
    if (
      (this.options.stream ?? false) ||
      contentType.includes('text/event-stream')
    ) {
      return readStreamingChatCompletion(response)
    }

    return await parseJsonResponsePayload(response)
  }

  protected async executeCompactRequest(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    const timeoutMs = this.options.timeoutMs ?? 60_000
    const linkedSignal = createLinkedAbortSignal({
      timeoutMs,
      externalSignal: signal,
    })

    try {
      const response = await fetch(this.options.baseUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You are a compaction helper. Return only the requested compact output and never emit tool calls.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          stream: false,
        }),
        signal: linkedSignal.signal,
      })

      if (!response.ok) {
        const responseText = await response.text()
        throw new OpenAICompatibleRequestError(
          `Compact request failed: ${response.status} ${response.statusText} ${responseText}`,
          {
            code: 'http_error',
            retryable: isRetryableStatus(response.status),
            status: response.status,
          },
        )
      }

      return await parseJsonResponsePayload(response)
    } catch (error) {
      if (isAbortError(error)) {
        if (linkedSignal.didExternalAbort()) {
          throw new ExecutionAbortedError(
            'Compact request aborted by external stop signal.',
          )
        }
        throw new OpenAICompatibleRequestError(
          `Compact request timed out after ${timeoutMs}ms.`,
          {
            code: 'timeout',
            retryable: true,
          },
        )
      }

      if (error instanceof OpenAICompatibleRequestError) {
        throw error
      }

      if (error instanceof Error) {
        throw new OpenAICompatibleRequestError(error.message, {
          code: 'network_error',
          retryable: true,
          cause: error,
        })
      }

      throw error
    } finally {
      linkedSignal.dispose()
    }
  }
}

async function parseJsonResponsePayload(
  response: Response,
): Promise<OpenAICompatibleChatCompletionResponse> {
  const text = await response.text()

  try {
    return JSON.parse(text) as OpenAICompatibleChatCompletionResponse
  } catch (error) {
    const contentType = response.headers.get('content-type') ?? 'unknown'
    const preview = text.slice(0, 160).replace(/\s+/g, ' ').trim()
    throw new OpenAICompatibleRequestError(
      `OpenAI-compatible response was not valid JSON. contentType=${contentType} preview=${preview}`,
      {
        code: 'parse_error',
        retryable: false,
        status: response.status,
        cause: error,
      },
    )
  }
}

function buildApiMessages(
  request: ModelRequest,
): OpenAICompatibleChatMessage[] {
  const messages: OpenAICompatibleChatMessage[] = [
    {
      role: 'system',
      content: buildSystemInstruction(request.context),
    },
  ]

  for (const message of request.messages) {
    if (message.role === 'system') {
      continue
    }

    if (message.role === 'tool') {
      if (message.toolCallId) {
        messages.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId,
        })
        continue
      }

      messages.push({
        role: 'user',
        content: `工具执行结果：${message.content}`,
      })
      continue
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((toolCall, index) => ({
          id: toolCall.callId ?? `synthetic-tool-call-${index}`,
          type: 'function',
          function: {
            name: encodeOpenAICompatibleToolName(toolCall.toolName),
            arguments: JSON.stringify(toolCall.input ?? {}),
          },
        })),
      })
      continue
    }

    messages.push({
      role: message.role,
      content: message.content,
    })
  }

  return messages
}

function buildApiTools(context: AssembledContext): Array<Record<string, unknown>> {
  return context.toolCatalog.map(tool => ({
    type: 'function',
    function: {
      name: encodeOpenAICompatibleToolName(tool.name),
      description: tool.description,
      parameters: {
        type: 'object',
        description: tool.inputSchema.description,
        properties: tool.inputSchema.properties ?? {},
        required: tool.inputSchema.required ?? [],
        additionalProperties: true,
      },
    },
  }))
}

type ParseModelResponseOptions = {
  compatibilityMode: OpenAICompatibleCompatibilityMode
}

type StreamAccumulator = {
  content: string
  toolCalls: Array<{
    id?: string
    type?: string
    function: {
      name: string
      arguments: string
    }
  }>
  finishReason?: string
}

function buildSystemInstruction(context: AssembledContext): string {
  return buildPhase1SystemInstruction(context)

  const recommendedCapabilities = context.routingPlan.recommendedCapabilities
    .map(
      capability =>
        [
          `- toolName: ${capability.toolName}`,
          `  title: ${capability.title}`,
          `  preferredRoute: ${capability.preferredRoute}`,
          `  reason: ${capability.reason}`,
          `  attempts: ${capability.attemptCount}`,
          `  remainingAttempts: ${capability.remainingAttempts}`,
          `  retryable: ${capability.retryable}`,
          `  retryOn: ${capability.retryOn.join(', ') || 'n/a'}`,
          `  maxAttempts: ${capability.maxAttempts}`,
          `  exhausted: ${capability.exhausted}`,
          `  lastOutcome: ${capability.lastOutcome ?? 'n/a'}`,
        ].join('\n'),
    )
    .join('\n')

  const fallbackTools = context.routingPlan.fallbackTools
    .map(
      tool =>
        [
          `- toolName: ${tool.toolName}`,
          `  risk: ${tool.riskLevel}`,
          `  reason: ${tool.reason}`,
          `  attempts: ${tool.attemptCount}`,
          `  remainingAttempts: ${tool.remainingAttempts}`,
          `  retryable: ${tool.retryable}`,
          `  retryOn: ${tool.retryOn.join(', ') || 'n/a'}`,
          `  maxAttempts: ${tool.maxAttempts}`,
          `  exhausted: ${tool.exhausted}`,
          `  lastOutcome: ${tool.lastOutcome ?? 'n/a'}`,
        ].join('\n'),
    )
    .join('\n')

  const executionState = context.routingPlan.executionState
  const recentAttempts =
    executionState.recentAttempts.length === 0
      ? '- 无'
      : executionState.recentAttempts
          .map(
            attempt =>
              `- #${attempt.sequence} ${attempt.toolName} outcome=${attempt.outcome} failureClass=${attempt.failureClass ?? 'n/a'} exhausted=${attempt.exhausted} route=${attempt.route ?? 'n/a'} turn=${attempt.turnId}`,
          )
          .join('\n')

  const capabilityCatalog = context.capabilityCatalog
    .map(
      capability =>
        [
          `- toolName: ${capability.toolName}`,
          `  title: ${capability.title}`,
          `  kind: ${capability.kind}`,
          `  preferredRoute: ${capability.preferredRoute}`,
          `  description: ${capability.description}`,
          `  tags: ${capability.tags.join(', ') || 'n/a'}`,
          `  retryable: ${capability.retryPolicy.retryable}`,
          `  maxAttempts: ${capability.retryPolicy.maxAttempts}`,
        ].join('\n'),
    )
    .join('\n')

  const toolCatalog = context.toolCatalog
    .map(
      tool =>
        [
          `- name: ${tool.name}`,
          `  description: ${tool.description}`,
          `  availability: ${tool.availability}`,
          `  searchHints: ${(tool.searchHints ?? []).join(', ') || 'n/a'}`,
        ].join('\n'),
    )
    .join('\n')

  const memoryFacts =
    context.memoryFacts.length === 0
      ? '- 无'
      : context.memoryFacts
          .map(fact => `- ${fact.category}: ${fact.content}`)
          .join('\n')

  return [
    context.systemPrompt,
    '',
    '你负责决定是直接回复，还是调用能力/工具。',
    '当需要外部能力时，优先复用已经封装好的 capability（skill / command）；只有在 capability 不覆盖时才直接拼底层 tools。',
    '不要伪造工具结果。',
    '如果最近一次工具结果失败，或 verification 明确 passed=false，优先按 routingPlan 切换到备用 capability；若没有合适备用 capability，再退回 fallback tools。',
    '当前任务意图：',
    context.routingPlan.taskText || '- 无',
    '',
    '推荐优先尝试的 capability：',
    recommendedCapabilities || '- 无',
    '',
    '当前路由执行态：',
    `- attemptedTools: ${executionState.attemptedTools.join(', ') || '无'}`,
    `- failedTools: ${executionState.failedTools.join(', ') || '无'}`,
    `- blockedTools: ${executionState.blockedTools.join(', ') || '无'}`,
    `- exhaustedTools: ${executionState.exhaustedTools.join(', ') || '无'}`,
    `- lastAttempt: ${executionState.lastAttempt?.toolName ?? '无'}`,
    `- lastAttemptOutcome: ${executionState.lastAttempt?.outcome ?? '无'}`,
    `- lastAttemptFailureClass: ${executionState.lastAttempt?.failureClass ?? '无'}`,
    '最近尝试轨迹：',
    recentAttempts,
    '',
    '可接受的底层回落工具：',
    fallbackTools || '- 无',
    '',
    '能力路由规则：',
    context.routingPlan.policyHints.map(hint => `- ${hint}`).join('\n'),
    '',
    '可用能力如下：',
    capabilityCatalog || '- 无',
    '',
    '可用工具如下：',
    toolCatalog || '- 无',
    '',
    '当前结构化记忆：',
    memoryFacts,
    '',
    '如果任务已完成，直接给出最终答复。',
    '如果拿到了工具结果，先结合结果继续判断，只有在确实需要时再发起下一次工具调用。',
  ].join('\n')
}

function buildPhase1SystemInstruction(context: AssembledContext): string {
  const executionState = context.routingPlan.executionState

  return [
    context.systemPrompt,
    '',
    'You are deciding whether to answer directly or call tools.',
    'Prefer high-level capabilities first. Use raw tools only when no suitable capability exists.',
    'Never fabricate tool results.',
    'When the last attempt failed or verification did not pass, prefer the next safe route from the routing plan before retrying blindly.',
    '',
    'Task:',
    context.routingPlan.taskText || 'none',
    '',
    'Active plan:',
    `- goal: ${context.activePlan.goal}`,
    `- subgoal: ${context.activePlan.subgoal}`,
    `- status: ${context.activePlan.status}`,
    '',
    'Compact state:',
    `- tier: ${context.compactState.tier}`,
    `- estimatedInputTokens: ${context.compactState.tokenBudget.estimatedInputTokens}`,
    `- headroom: ${context.compactState.tokenBudget.headroom}`,
    `- lastSummary: ${context.compactState.lastSummary ?? 'none'}`,
    '',
    'Recommended capabilities:',
    formatCatalogBlock(
      context.routingPlan.recommendedCapabilities.slice(0, 5).map(capability =>
        [
          `${capability.toolName} (${capability.title})`,
          `route=${capability.preferredRoute}`,
          `reason=${capability.reason}`,
          `attempts=${capability.attemptCount}/${capability.maxAttempts}`,
          `retryable=${capability.retryable}`,
          `lastOutcome=${capability.lastOutcome ?? 'n/a'}`,
          `exhausted=${capability.exhausted}`,
        ].join('; '),
      ),
    ),
    '',
    'Fallback tools:',
    formatCatalogBlock(
      context.routingPlan.fallbackTools.slice(0, 5).map(tool =>
        [
          tool.toolName,
          `risk=${tool.riskLevel}`,
          `reason=${tool.reason}`,
          `attempts=${tool.attemptCount}/${tool.maxAttempts}`,
          `retryable=${tool.retryable}`,
          `lastOutcome=${tool.lastOutcome ?? 'n/a'}`,
          `exhausted=${tool.exhausted}`,
        ].join('; '),
      ),
    ),
    '',
    'Routing execution state:',
    `- attemptedTools: ${executionState.attemptedTools.join(', ') || 'none'}`,
    `- failedTools: ${executionState.failedTools.join(', ') || 'none'}`,
    `- blockedTools: ${executionState.blockedTools.join(', ') || 'none'}`,
    `- exhaustedTools: ${executionState.exhaustedTools.join(', ') || 'none'}`,
    `- currentSubgoal: ${executionState.currentSubgoal ?? 'none'}`,
    `- lastVerificationResult: ${executionState.lastVerificationResult ?? 'unknown'}`,
    `- lastAttempt: ${executionState.lastAttempt?.toolName ?? 'none'}`,
    `- lastAttemptOutcome: ${executionState.lastAttempt?.outcome ?? 'none'}`,
    `- lastAttemptFailureClass: ${executionState.lastAttempt?.failureClass ?? 'none'}`,
    'Recent attempts:',
    formatCatalogBlock(
      executionState.recentAttempts.slice(-5).map(
        attempt =>
          `#${attempt.sequence} ${attempt.toolName}; outcome=${attempt.outcome}; verification=${
            attempt.verificationPassed === undefined
              ? 'unknown'
              : attempt.verificationPassed
                ? 'passed'
                : 'failed'
          }; failureClass=${attempt.failureClass ?? 'n/a'}; exhausted=${attempt.exhausted}; route=${attempt.route ?? 'n/a'}`,
      ),
    ),
    '',
    'Chain state:',
    `- currentTarget: ${context.chainState.currentTarget ?? 'none'}`,
    `- currentArtifact: ${context.chainState.currentArtifact ?? 'none'}`,
    `- lastVerifiedAnchor: ${context.chainState.lastVerifiedAnchor ?? 'none'}`,
    `- lastRecoveryPoint: ${context.chainState.lastRecoveryPoint ?? 'none'}`,
    `- chainStatus: ${context.chainState.chainStatus ?? 'none'}`,
    '',
    'Routing hints:',
    formatCatalogBlock(context.routingPlan.policyHints),
    '',
    'Relevant capabilities:',
    formatCatalogBlock(
      context.capabilityCatalog.slice(0, 8).map(capability =>
        [
          `${capability.toolName} (${capability.kind})`,
          `title=${capability.title}`,
          `route=${capability.preferredRoute}`,
          `retryable=${capability.retryPolicy.retryable}`,
          `maxAttempts=${capability.retryPolicy.maxAttempts}`,
          `tags=${capability.tags.join(', ') || 'n/a'}`,
        ].join('; '),
      ),
    ),
    '',
    'Visible tools:',
    formatCatalogBlock(
      context.toolCatalog.slice(0, 12).map(tool =>
        [
          tool.name,
          `availability=${tool.availability}`,
          `risk=${tool.riskLevel}`,
          `hints=${(tool.searchHints ?? []).join(', ') || 'n/a'}`,
        ].join('; '),
      ),
    ),
    '',
    'Structured memory:',
    formatCatalogBlock(
      context.memoryFacts
        .slice(-10)
        .map(fact => `${fact.key ?? fact.category}: ${fact.content}`),
    ),
    '',
    'If the task is complete, return the final answer.',
    'If you need more information or action, issue the smallest next tool call that matches the current subgoal.',
  ].join('\n')
}

function buildCompactSessionMemoryRequest(messages: QueryMessage[]): string {
  return [
    'Summarize only stable session-memory facts.',
    'Return strict JSON only.',
    '{"taskCurrent":"string","taskPlan":"string","taskLastOutcome":"string","taskCurrentTarget":"string","taskCurrentArtifact":"string","routingLastAttempt":"string","routingExecutionState":"string","routingLastVerifiedAnchor":"string","routingLastRecoveryPoint":"string","routingChainStatus":"string","projectStructure":"string","projectRecentPaths":["string"],"preferenceResponseLanguage":"string","preferenceExecutionPath":"string","constraintActive":"string","compactLastSummary":"string"}',
    '',
    ...messages.map(
      message =>
        `[${message.role}${message.toolName ? `:${message.toolName}` : ''}] ${message.content.slice(0, 500)}`,
    ),
  ].join('\n')
}

function buildCompactFullRequest(messages: QueryMessage[]): string {
  return [
    'Summarize this conversation for context compaction.',
    'Return exactly <analysis>...</analysis><summary>...</summary>.',
    '',
    ...messages.map(
      message =>
        `[${message.role}${message.toolName ? `:${message.toolName}` : ''}] ${message.content.slice(0, 500)}`,
    ),
  ].join('\n')
}

function stringifyCompactMemorySummary(
  parsed: Record<string, unknown>,
): string {
  return [
    `taskCurrent=${readString(parsed.taskCurrent)}`,
    `taskPlan=${readString(parsed.taskPlan)}`,
    `taskLastOutcome=${readString(parsed.taskLastOutcome)}`,
    `taskCurrentTarget=${readString(parsed.taskCurrentTarget)}`,
    `taskCurrentArtifact=${readString(parsed.taskCurrentArtifact)}`,
    `routingLastAttempt=${readString(parsed.routingLastAttempt)}`,
    `routingExecutionState=${readString(parsed.routingExecutionState)}`,
    `routingLastVerifiedAnchor=${readString(parsed.routingLastVerifiedAnchor)}`,
    `routingLastRecoveryPoint=${readString(parsed.routingLastRecoveryPoint)}`,
    `routingChainStatus=${readString(parsed.routingChainStatus)}`,
    `projectStructure=${readString(parsed.projectStructure)}`,
    `projectRecentPaths=${readStringArray(parsed.projectRecentPaths).join(', ')}`,
    `preferenceResponseLanguage=${readString(parsed.preferenceResponseLanguage)}`,
    `preferenceExecutionPath=${readString(parsed.preferenceExecutionPath)}`,
    `constraintActive=${readString(parsed.constraintActive)}`,
    `compactLastSummary=${readString(parsed.compactLastSummary)}`,
  ].join('; ')
}

function mapSessionMemoryFacts(parsed: Record<string, unknown>): MemoryFact[] {
  const facts: MemoryFact[] = []
  pushCompactFact(facts, 'task.current', 'task', readString(parsed.taskCurrent))
  pushCompactFact(facts, 'task.plan', 'task', readString(parsed.taskPlan))
  pushCompactFact(
    facts,
    'task.last_outcome',
    'task',
    readString(parsed.taskLastOutcome),
  )
  pushCompactFact(
    facts,
    'task.current_target',
    'task',
    readString(parsed.taskCurrentTarget),
  )
  pushCompactFact(
    facts,
    'task.current_artifact',
    'task',
    readString(parsed.taskCurrentArtifact),
  )
  pushCompactFact(
    facts,
    'routing.last_attempt',
    'routing',
    readString(parsed.routingLastAttempt),
  )
  pushCompactFact(
    facts,
    'routing.execution_state',
    'routing',
    readString(parsed.routingExecutionState),
  )
  pushCompactFact(
    facts,
    'routing.last_verified_anchor',
    'routing',
    readString(parsed.routingLastVerifiedAnchor),
  )
  pushCompactFact(
    facts,
    'routing.last_recovery_point',
    'routing',
    readString(parsed.routingLastRecoveryPoint),
  )
  pushCompactFact(
    facts,
    'routing.chain_status',
    'routing',
    readString(parsed.routingChainStatus),
  )
  pushCompactFact(
    facts,
    'project.structure',
    'project',
    readString(parsed.projectStructure),
  )
  const recentPaths = readStringArray(parsed.projectRecentPaths)
  if (recentPaths.length > 0) {
    pushCompactFact(
      facts,
      'project.recent_paths',
      'project',
      recentPaths.join('\n'),
    )
  }
  pushCompactFact(
    facts,
    'preference.response_language',
    'preference',
    readString(parsed.preferenceResponseLanguage),
  )
  pushCompactFact(
    facts,
    'preference.execution_path',
    'preference',
    readString(parsed.preferenceExecutionPath),
  )
  pushCompactFact(
    facts,
    'constraint.active',
    'constraint',
    readString(parsed.constraintActive),
  )
  pushCompactFact(
    facts,
    'compact.last_summary',
    'compact',
    readString(parsed.compactLastSummary),
  )
  return facts
}

function pushCompactFact(
  facts: MemoryFact[],
  key: MemoryFact['key'],
  category: string,
  content: string,
): void {
  if (!key || !content.trim()) {
    return
  }

  facts.push({
    key,
    category,
    content: content.trim().slice(0, 240),
    mergeStrategy: 'replace',
  })
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string')
}

function extractCompactSummary(text: string): string {
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim()
  }

  throw new OpenAICompatibleRequestError(
    `Compact response is missing <summary>: ${text}`,
    {
      code: 'parse_error',
      retryable: false,
    },
  )
}

function formatCatalogBlock(lines: string[]): string {
  return lines.length > 0 ? lines.map(line => `- ${line}`).join('\n') : '- none'
}

function hasTool(context: AssembledContext, toolName: string): boolean {
  return context.toolCatalog.some(tool => tool.name === toolName)
}

function selectNextActionFromRoutingPlan(
  context: AssembledContext,
): { toolName: string; input: Record<string, unknown>; assistantMessage: string } | undefined {
  const initialFallbackTool = selectInitialFallbackTool(context)
  if (initialFallbackTool && shouldPreferFallbackToolFirst(context, initialFallbackTool.toolName)) {
    return {
      toolName: initialFallbackTool.toolName,
      input: inferToolInput(initialFallbackTool.toolName, context.routingPlan.taskText),
      assistantMessage: `没有合适 capability 命中，先使用低风险回落工具 ${initialFallbackTool.toolName} 收集信息。`,
    }
  }

  const selectedCapability = context.routingPlan.recommendedCapabilities.find(
    capability =>
      !capability.exhausted &&
      !shouldSkipRecommendedCapability(context, capability.toolName) &&
      canPrepareToolCall(
        context,
        capability.toolName,
        context.routingPlan.taskText,
      ),
  )
  if (selectedCapability) {
    return {
      toolName: selectedCapability.toolName,
      input: inferToolInput(selectedCapability.toolName, context.routingPlan.taskText),
      assistantMessage: `根据 routing policy，先尝试高层能力 ${selectedCapability.toolName}。`,
    }
  }

  const fallbackTool = initialFallbackTool
  if (fallbackTool) {
    return {
      toolName: fallbackTool.toolName,
      input: inferToolInput(fallbackTool.toolName, context.routingPlan.taskText),
      assistantMessage: `没有合适 capability 命中，先使用低风险回落工具 ${fallbackTool.toolName} 收集信息。`,
    }
  }

  return undefined
}

function selectRecoveryActionFromRoutingState(
  context: AssembledContext,
): { toolName: string; input: Record<string, unknown>; assistantMessage: string } | undefined {
  const lastAttempt = context.routingPlan.executionState.lastAttempt
  if (!lastAttempt || !shouldAttemptRecovery(lastAttempt)) {
    return undefined
  }

  const exhaustedTools = new Set(context.routingPlan.executionState.exhaustedTools)
  const lastRecoveryPoint = context.chainState.lastRecoveryPoint
  const lastVerifiedAnchor = context.chainState.lastVerifiedAnchor
  const blockedCount = context.routingPlan.executionState.blockedTools.length
  const topCapabilityScore =
    context.routingPlan.recommendedCapabilities[0]?.score ?? 0

  const recoveryTool = selectRecoveryTool(context, lastAttempt.toolName)
  if (
    lastAttempt.outcome === 'verified_failed' &&
    recoveryTool &&
    canPrepareToolCall(context, recoveryTool, context.routingPlan.taskText)
  ) {
    return {
      toolName: recoveryTool,
      input: inferRecoveryInput(
        context,
        recoveryTool,
        context.routingPlan.taskText,
      ),
      assistantMessage: `The last step failed verification. Recover using ${recoveryTool} from ${
        lastRecoveryPoint ?? lastVerifiedAnchor ?? 'the latest known safe observation'
      } before continuing.`,
    }
  }

  if (lastAttempt.outcome === 'blocked' || blockedCount > 0) {
    const safeFallback = context.routingPlan.fallbackTools.find(
      tool =>
        tool.toolName !== lastAttempt.toolName &&
        !exhaustedTools.has(tool.toolName) &&
        !isGuiActionTool(tool.toolName) &&
        !tool.toolName.startsWith('command.') &&
        canPrepareToolCall(context, tool.toolName, context.routingPlan.taskText),
    )
    if (safeFallback) {
      return {
        toolName: safeFallback.toolName,
        input: inferRecoveryInput(
          context,
          safeFallback.toolName,
          context.routingPlan.taskText,
        ),
        assistantMessage: `The previous route was blocked, so switch to the safer recovery path ${safeFallback.toolName}.`,
      }
    }
  }

  const backupCapability = context.routingPlan.recommendedCapabilities.find(
    capability =>
      capability.toolName !== lastAttempt.toolName &&
      !exhaustedTools.has(capability.toolName) &&
      (
        lastAttempt.outcome !== 'blocked' ||
        (
          !isGuiActionTool(capability.toolName) &&
          !capability.toolName.startsWith('command.')
        )
      ) &&
      capability.score >= Math.max(1, topCapabilityScore - 8) &&
      canPrepareToolCall(
        context,
        capability.toolName,
        context.routingPlan.taskText,
      ),
  )
  if (backupCapability) {
    return {
      toolName: backupCapability.toolName,
      input: inferToolInput(
        backupCapability.toolName,
        context.routingPlan.taskText,
      ),
      assistantMessage: `上一步 ${lastAttempt.toolName} 未通过校验或执行失败，切换到备用能力 ${backupCapability.toolName}。`,
    }
  }

  const fallbackTool = context.routingPlan.fallbackTools.find(
    tool =>
      tool.toolName !== lastAttempt.toolName &&
      !exhaustedTools.has(tool.toolName) &&
      canPrepareToolCall(context, tool.toolName, context.routingPlan.taskText),
  )
  if (fallbackTool) {
    return {
      toolName: fallbackTool.toolName,
      input: inferToolInput(fallbackTool.toolName, context.routingPlan.taskText),
      assistantMessage: `上一步 ${lastAttempt.toolName} 未通过校验或执行失败，回退到更安全的工具 ${fallbackTool.toolName}。`,
    }
  }

  if (
    lastAttempt.retryable &&
    !lastAttempt.exhausted &&
    canPrepareToolCall(context, lastAttempt.toolName, context.routingPlan.taskText)
  ) {
    return {
      toolName: lastAttempt.toolName,
      input: inferToolInput(lastAttempt.toolName, context.routingPlan.taskText),
      assistantMessage: `上一步 ${lastAttempt.toolName} 因 ${lastAttempt.failureClass ?? 'unknown'} 失败，但该失败类别允许重试，按策略再次尝试。`,
    }
  }

  return undefined
}

function shouldAttemptRecovery(
  attempt: AssembledContext['routingPlan']['executionState']['recentAttempts'][number],
): boolean {
  return attempt.outcome !== 'succeeded'
}

function inferToolInput(
  toolName: string,
  taskText: string,
): Record<string, unknown> {
  switch (toolName) {
    case 'command.workspace.search_text':
      return {
        query: resolveSearchQuery(taskText),
      }
    case 'command.workspace.read_text':
      return {
        path: extractLikelyPath(taskText) ?? 'package.json',
      }
    case 'command.workspace.inspect_tree':
    case 'skill.desktop.observe':
    case 'windows.snapshot':
    case 'windows.screenshot':
      return {}
    case 'skill.browser_to_editor.capture_verify':
      return {
        appName: extractLikelyAppName(taskText) ?? 'Notepad',
      }
    case 'skill.browser.extract_then_transfer':
      return {
        targetWindowTitle: extractLikelyAppName(taskText) ?? 'Notepad',
      }
    case 'skill.cross_app.open_observe_act_verify':
      return {
        appName: extractLikelyAppName(taskText) ?? 'Notepad',
      }
    case 'command.app.open_or_focus':
      return {
        appName: extractLikelyAppName(taskText) ?? 'Notepad',
      }
    case 'command.desktop.capture_and_locate':
      return {
        query:
          extractQuotedText(taskText) ??
          extractLikelyAppName(taskText) ??
          taskText,
      }
    case 'command.browser.inspect_dom':
      return {}
    default:
      return {}
  }
}

function inferRecoveryInput(
  context: AssembledContext,
  toolName: string,
  taskText: string,
): Record<string, unknown> {
  switch (toolName) {
    case 'command.desktop.capture_and_locate':
      return {
        query:
          context.chainState.lastVerifiedAnchor ??
          context.chainState.currentTarget ??
          extractQuotedText(taskText) ??
          taskText,
      }
    case 'command.app.open_or_focus':
      return {
        appName:
          context.chainState.currentTarget ??
          extractQuotedText(taskText) ??
          'Notepad',
      }
    case 'skill.desktop.observe':
    case 'command.browser.inspect_dom':
    case 'windows.snapshot':
    case 'windows.screenshot':
      return {}
    default:
      return inferToolInput(toolName, taskText)
  }
}

function selectRecoveryTool(
  context: AssembledContext,
  lastToolName: string,
): string | undefined {
  const candidates = context.chainState.lastRecoveryPoint?.startsWith('focus:')
    ? [
        'command.app.open_or_focus',
        'command.desktop.capture_and_locate',
        'command.browser.inspect_dom',
        'skill.desktop.observe',
        'windows.snapshot',
        'windows.screenshot',
      ]
    : context.chainState.lastRecoveryPoint?.startsWith('observe:')
      ? [
          'command.desktop.capture_and_locate',
          'command.browser.inspect_dom',
          'command.app.open_or_focus',
          'skill.desktop.observe',
          'windows.snapshot',
          'windows.screenshot',
        ]
    : [
        'command.app.open_or_focus',
        'command.desktop.capture_and_locate',
        'command.browser.inspect_dom',
        'skill.desktop.observe',
        'windows.snapshot',
        'windows.screenshot',
      ]

  return candidates.find(
    toolName =>
      toolName !== lastToolName &&
      hasTool(context, toolName),
  )
}

function shouldPreferFallbackToolFirst(
  context: AssembledContext,
  fallbackToolName: string,
): boolean {
  const bestCapability = context.routingPlan.recommendedCapabilities[0]
  if (!bestCapability) {
    return true
  }

  if (fallbackToolName === 'command.workspace.search_text') {
    return true
  }

  if (
    (fallbackToolName.startsWith('skill.') || fallbackToolName.startsWith('command.')) &&
    bestCapability.toolName === 'skill.desktop.observe'
  ) {
    if (
      fallbackToolName === 'command.app.open_or_focus' &&
      context.toolCatalog.some(
        tool => tool.name === 'skill.cross_app.open_observe_act_verify',
      ) &&
      /open|focus/i.test(context.routingPlan.taskText)
    ) {
      return false
    }

    return true
  }

  if (
    fallbackToolName === 'windows.snapshot' &&
    bestCapability.toolName === 'skill.desktop.observe'
  ) {
    return false
  }

  return bestCapability.score <= 0
}

function selectInitialFallbackTool(
  context: AssembledContext,
) {
  const preferredOpenFocusFallback =
    context.toolCatalog.some(
      tool => tool.name === 'skill.cross_app.open_observe_act_verify',
    ) &&
    /open|focus/i.test(context.routingPlan.taskText)
      ? context.routingPlan.fallbackTools.find(
          tool =>
            tool.toolName === 'skill.cross_app.open_observe_act_verify' &&
            !tool.exhausted &&
            canPrepareToolCall(context, tool.toolName, context.routingPlan.taskText),
        )
      : undefined

  if (preferredOpenFocusFallback) {
    return preferredOpenFocusFallback
  }

  return context.routingPlan.fallbackTools.find(
    tool =>
      !tool.exhausted &&
      canPrepareToolCall(context, tool.toolName, context.routingPlan.taskText),
  )
}

function shouldSkipRecommendedCapability(
  context: AssembledContext,
  capabilityToolName: string,
): boolean {
  return (
    capabilityToolName === 'skill.desktop.observe' &&
    context.toolCatalog.some(
      tool => tool.name === 'skill.cross_app.open_observe_act_verify',
    ) &&
    /open|focus/i.test(context.routingPlan.taskText)
  )
}

function isGuiActionTool(toolName: string): boolean {
  return (
    toolName === 'windows.click' ||
    toolName === 'windows.type' ||
    toolName === 'windows.shortcut' ||
    toolName === 'windows.move_or_drag' ||
    toolName.includes('cross_app.transfer') ||
    toolName.includes('open_observe_act_verify')
  )
}

function stripIntentPrefix(value: string, prefix: string): string {
  return value.replace(new RegExp(`^.*${prefix}`), '').trim()
}

function resolveSearchQuery(taskText: string): string {
  const extractedQuery = extractQuotedText(taskText)
  if (extractedQuery) {
    return extractedQuery
  }

  return stripIntentPrefix(taskText, '搜索') || taskText
}

function canPrepareToolCall(
  context: AssembledContext,
  toolName: string,
  taskText: string,
): boolean {
  const tool = context.toolCatalog.find(candidate => candidate.name === toolName)
  if (!tool) {
    return false
  }

  const inferredInput =
    context.chainState.lastRecoveryPoint || context.chainState.lastVerifiedAnchor
      ? inferRecoveryInput(context, toolName, taskText)
      : inferToolInput(toolName, taskText)
  return (tool.inputSchema.required ?? []).every(key => key in inferredInput)
}

function extractQuotedText(value: string): string | undefined {
  const quoted = value.match(/["'`“”‘’]([^"'`“”‘’]+)["'`“”‘’]/)
  return quoted?.[1]?.trim() || undefined
}

function extractLikelyPath(value: string): string | undefined {
  const pathMatch = value.match(/[A-Za-z]:\\[^\s"'`]+|[./\\][^\s"'`]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt)\b/)
  return pathMatch?.[0]
}

function extractLikelyAppName(value: string): string | undefined {
  const leadingVerbMatch = value.match(
    /^\s*(?:open|focus)\s+([A-Z][A-Za-z0-9_-]+)/i,
  )
  if (leadingVerbMatch?.[1]) {
    return leadingVerbMatch[1]
  }

  const windowMatch = value.match(/\b(?:into|to|in|focus|open|send it to)\s+([A-Z][A-Za-z0-9_-]+)/i)
  if (windowMatch?.[1]) {
    return windowMatch[1]
  }

  const knownApps = ['Notepad', 'Browser', 'Calculator', 'Editor']
  return knownApps.find(app => value.toLowerCase().includes(app.toLowerCase()))
}

function extractAssistantContent(
  payload: OpenAICompatibleChatCompletionResponse,
): string {
  const message = payload.choices?.[0]?.message
  if (!message) {
    throw new OpenAICompatibleRequestError(
      'OpenAI-compatible response does not contain choices[0].message.',
      {
        code: 'response_shape_error',
        retryable: false,
      },
    )
  }

  if (typeof message.content === 'string') {
    return message.content
  }

  if (Array.isArray(message.content)) {
    const text = message.content
      .map(item => {
        if (typeof item.text === 'string') {
          return item.text
        }
        if (typeof item.content === 'string') {
          return item.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')

    if (text) {
      return text
    }
  }

  return ''
}

function parseModelResponse(
  payload: OpenAICompatibleChatCompletionResponse,
  context: AssembledContext,
  options: ParseModelResponseOptions,
): ModelResponse {
  const message = payload.choices?.[0]?.message
  if (!message) {
    throw new OpenAICompatibleRequestError(
      'OpenAI-compatible response does not contain choices[0].message.',
      {
        code: 'response_shape_error',
        retryable: false,
      },
    )
  }

  const normalizedToolCalls = normalizeToolCalls(payload, options)
  if (normalizedToolCalls.length > 0) {
    return {
      type: 'tool_calls',
      assistantMessage: extractAssistantContent(payload),
      toolCalls: normalizedToolCalls.map(toolCall =>
        validateOpenAIToolCall(toolCall, context),
      ),
    }
  }

  const content = extractAssistantContent(payload).trim()
  if (!content) {
    return {
      type: 'final',
      message: '模型未返回任何内容。',
    }
  }

  try {
    const parsed = parseJsonObject(content)

    if (parsed.type === 'tool_calls') {
      if (
        typeof parsed.assistantMessage === 'string' &&
        Array.isArray(parsed.toolCalls)
      ) {
        return {
          type: 'tool_calls',
          assistantMessage: parsed.assistantMessage,
          toolCalls: parsed.toolCalls.map(toolCall =>
            validateToolCall(toolCall, context),
          ),
        }
      }
    }

    if (parsed.type === 'final' && typeof parsed.message === 'string') {
      return {
        type: 'final',
        message: parsed.message,
      }
    }
  } catch {
    // Fall through to plain-text final answer for gateways that ignore tools
  }

  return {
    type: 'final',
    message: content,
  }
}

export function parseOpenAICompatiblePayload(
  payload: OpenAICompatibleChatCompletionResponse,
  context: AssembledContext,
  compatibilityMode: OpenAICompatibleCompatibilityMode = 'generic',
): ModelResponse {
  return parseModelResponse(payload, context, {
    compatibilityMode,
  })
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  const withoutCodeFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  try {
    return JSON.parse(withoutCodeFence) as Record<string, unknown>
  } catch {
    const firstBrace = withoutCodeFence.indexOf('{')
    const lastBrace = withoutCodeFence.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(
        withoutCodeFence.slice(firstBrace, lastBrace + 1),
      ) as Record<string, unknown>
    }
    throw new OpenAICompatibleRequestError(
      `Model response is not valid JSON: ${content}`,
      {
        code: 'parse_error',
        retryable: false,
      },
    )
  }
}

async function readStreamingChatCompletion(
  response: Response,
): Promise<OpenAICompatibleChatCompletionResponse> {
  if (!response.body) {
    throw new OpenAICompatibleRequestError(
      'Streaming response does not contain a readable body.',
      {
        code: 'stream_error',
        retryable: true,
      },
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const accumulator = createStreamAccumulator()

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const drained = drainSseEvents(buffer)
    buffer = drained.rest

    for (const event of drained.events) {
      const data = extractSseData(event)
      if (!data) {
        continue
      }

      if (data === '[DONE]') {
        continue
      }

      const chunk = parseStreamingChunk(data)
      if (chunk.error?.message) {
        throw new OpenAICompatibleRequestError(
          `OpenAI-compatible stream returned error: ${chunk.error.message}`,
          {
            code: 'api_error',
            retryable: false,
          },
        )
      }

      mergeStreamingChunk(accumulator, chunk)
    }
  }

  buffer += decoder.decode()
  const drained = drainSseEvents(buffer, true)
  for (const event of drained.events) {
    const data = extractSseData(event)
    if (!data || data === '[DONE]') {
      continue
    }

    const chunk = parseStreamingChunk(data)
    if (chunk.error?.message) {
      throw new OpenAICompatibleRequestError(
        `OpenAI-compatible stream returned error: ${chunk.error.message}`,
        {
          code: 'api_error',
          retryable: false,
        },
      )
    }

    mergeStreamingChunk(accumulator, chunk)
  }

  return finalizeStreamingAccumulator(accumulator)
}

function createStreamAccumulator(): StreamAccumulator {
  return {
    content: '',
    toolCalls: [],
  }
}

function mergeStreamingChunk(
  accumulator: StreamAccumulator,
  chunk: OpenAICompatibleChatCompletionChunk,
): void {
  const choice = chunk.choices?.[0]
  if (!choice) {
    return
  }

  if (choice.finish_reason) {
    accumulator.finishReason = choice.finish_reason
  }

  const delta = choice.delta
  if (!delta) {
    return
  }

  accumulator.content += extractChunkContent(delta.content)

  if (!Array.isArray(delta.tool_calls)) {
    return
  }

  for (const partialToolCall of delta.tool_calls) {
    const index =
      typeof partialToolCall.index === 'number'
        ? partialToolCall.index
        : accumulator.toolCalls.length

    const current =
      accumulator.toolCalls[index] ??
      {
        id: undefined,
        type: partialToolCall.type ?? 'function',
        function: {
          name: '',
          arguments: '',
        },
      }

    if (typeof partialToolCall.id === 'string') {
      current.id = partialToolCall.id
    }

    if (typeof partialToolCall.type === 'string') {
      current.type = partialToolCall.type
    }

    if (typeof partialToolCall.function?.name === 'string') {
      current.function.name += partialToolCall.function.name
    }

    if (typeof partialToolCall.function?.arguments === 'string') {
      current.function.arguments += partialToolCall.function.arguments
    }

    accumulator.toolCalls[index] = current
  }
}

function extractChunkContent(
  content:
    | string
    | Array<{
        type?: string
        text?: string
        content?: string
      }>
    | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(item => {
      if (typeof item.text === 'string') {
        return item.text
      }
      if (typeof item.content === 'string') {
        return item.content
      }
      return ''
    })
    .join('')
}

function finalizeStreamingAccumulator(
  accumulator: StreamAccumulator,
): OpenAICompatibleChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          content: accumulator.content,
          tool_calls: accumulator.toolCalls.map(toolCall => ({
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          })),
        },
        finish_reason: accumulator.finishReason,
      },
    ],
  }
}

function drainSseEvents(
  rawBuffer: string,
  flush = false,
): { events: string[]; rest: string } {
  const normalizedBuffer = rawBuffer.replace(/\r\n/g, '\n')
  const parts = normalizedBuffer.split('\n\n')

  if (flush) {
    return {
      events: parts.filter(part => part.trim().length > 0),
      rest: '',
    }
  }

  const rest = parts.pop() ?? ''
  return {
    events: parts.filter(part => part.trim().length > 0),
    rest,
  }
}

function extractSseData(event: string): string | undefined {
  const lines = event
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const dataLines = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())

  if (dataLines.length === 0) {
    return undefined
  }

  return dataLines.join('\n')
}

function validateToolCall(
  value: unknown,
  context: AssembledContext,
): ToolCall {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { toolName?: unknown }).toolName !== 'string'
  ) {
    throw new OpenAICompatibleRequestError(
      `Invalid tool call received from model: ${JSON.stringify(value)}`,
      {
        code: 'response_shape_error',
        retryable: false,
      },
    )
  }

  const toolCall = value as { toolName: string; input?: unknown }
  validateToolInput(toolCall.toolName, toolCall.input ?? {}, context)
  return {
    toolName: toolCall.toolName,
    input: toolCall.input ?? {},
  }
}

function validateOpenAIToolCall(
  value: NormalizedOpenAIToolCall,
  context: AssembledContext,
): ToolCall {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.id !== 'string' ||
    typeof value.function.name !== 'string'
  ) {
    throw new OpenAICompatibleRequestError(
      `Invalid OpenAI tool call received from model: ${JSON.stringify(value)}`,
      {
        code: 'response_shape_error',
        retryable: false,
      },
    )
  }

  let input: unknown = {}
  const rawArguments = value.function.arguments ?? '{}'

  try {
    input = parseMaybeJsonObject(rawArguments)
  } catch {
    throw new OpenAICompatibleRequestError(
      `Invalid OpenAI tool call arguments for ${value.function.name}: ${rawArguments}`,
      {
        code: 'parse_error',
        retryable: false,
      },
    )
  }

  const decodedToolName = decodeOpenAICompatibleToolName(value.function.name)
  validateToolInput(decodedToolName, input, context)

  return {
    callId: value.id,
    toolName: decodedToolName,
    input,
  }
}

type NormalizedOpenAIToolCall = {
  id: string
  function: {
    name: string
    arguments: string
  }
}

function normalizeToolCalls(
  payload: OpenAICompatibleChatCompletionResponse,
  options: ParseModelResponseOptions,
): NormalizedOpenAIToolCall[] {
  const firstChoice = payload.choices?.[0]
  const rawToolCalls = firstChoice?.message?.tool_calls
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    if (options.compatibilityMode === 'strict' && firstChoice?.finish_reason === 'tool_calls') {
      throw new OpenAICompatibleRequestError(
        'Model reported finish_reason=tool_calls but did not return tool_calls payload.',
        {
          code: 'response_shape_error',
          retryable: false,
        },
      )
    }
    return []
  }

  return rawToolCalls.map((toolCall, index) => {
    const allowFlatShape =
      options.compatibilityMode === 'generic' ||
      options.compatibilityMode === 'ollama'

    const normalizedName = getNormalizedToolName(toolCall, allowFlatShape)
    const normalizedArguments = getNormalizedToolArguments(
      toolCall,
      allowFlatShape,
    )

    const normalizedId =
      typeof toolCall.id === 'string'
        ? toolCall.id
        : `compat-tool-call-${index}`

    if (!normalizedName) {
      throw new OpenAICompatibleRequestError(
        `Tool call is missing function name under compatibility mode ${options.compatibilityMode}: ${JSON.stringify(toolCall)}`,
        {
          code: 'response_shape_error',
          retryable: false,
        },
      )
    }

    return {
      id: normalizedId,
      function: {
        name: normalizedName,
        arguments: normalizedArguments,
      },
    }
  })
}

function getNormalizedToolName(
  toolCall: NonNullable<
    NonNullable<
      NonNullable<OpenAICompatibleChatCompletionResponse['choices']>[number]['message']
    >['tool_calls']
  >[number],
  allowFlatShape: boolean,
): string | undefined {
  if (typeof toolCall.function?.name === 'string') {
    return toolCall.function.name
  }

  if (allowFlatShape && typeof toolCall.name === 'string') {
    return toolCall.name
  }

  return undefined
}

function encodeOpenAICompatibleToolName(toolName: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(toolName)) {
    return toolName
  }

  const encoded = Buffer.from(toolName, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return `tool_${encoded}`
}

function decodeOpenAICompatibleToolName(toolName: string): string {
  if (!toolName.startsWith('tool_')) {
    return toolName
  }

  const payload = toolName.slice('tool_'.length)
  if (!payload || !/^[a-zA-Z0-9_-]+$/.test(payload)) {
    return toolName
  }

  const normalizedBase64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const paddedBase64 =
    normalizedBase64 + '='.repeat((4 - (normalizedBase64.length % 4)) % 4)

  try {
    return Buffer.from(paddedBase64, 'base64').toString('utf8')
  } catch {
    return toolName
  }
}

function getNormalizedToolArguments(
  toolCall: NonNullable<
    NonNullable<
      NonNullable<OpenAICompatibleChatCompletionResponse['choices']>[number]['message']
    >['tool_calls']
  >[number],
  allowFlatShape: boolean,
): string {
  if (typeof toolCall.function?.arguments === 'string') {
    return toolCall.function.arguments
  }

  if (allowFlatShape && typeof toolCall.arguments === 'string') {
    return toolCall.arguments
  }

  return '{}'
}

function applyCompatibilityOptions(
  body: Record<string, unknown>,
  compatibilityMode: 'strict' | 'openai' | 'ollama' | 'generic',
): void {
  switch (compatibilityMode) {
    case 'strict':
    case 'openai':
      body.tool_choice = 'auto'
      body.parallel_tool_calls = false
      break
    case 'ollama':
      body.tool_choice = 'auto'
      break
    case 'generic':
    default:
      body.tool_choice = 'auto'
      break
  }
}

function parseMaybeJsonObject(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) {
    return {}
  }

  return parseJsonObject(trimmed)
}

function validateToolInput(
  toolName: string,
  input: unknown,
  context: AssembledContext,
): void {
  const tool = context.toolCatalog.find(candidate => candidate.name === toolName)
  if (!tool) {
    throw new OpenAICompatibleRequestError(
      `Model requested unknown tool: ${toolName}`,
      {
        code: 'tool_schema_error',
        retryable: false,
      },
    )
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OpenAICompatibleRequestError(
      `Tool input for ${toolName} must be an object.`,
      {
        code: 'tool_schema_error',
        retryable: false,
      },
    )
  }

  const required = tool.inputSchema.required ?? []
  for (const key of required) {
    if (!(key in input)) {
      throw new OpenAICompatibleRequestError(
        `Tool input for ${toolName} is missing required field: ${key}`,
        {
          code: 'tool_schema_error',
          retryable: false,
        },
      )
    }
  }

  const properties = tool.inputSchema.properties ?? {}
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key]
    if (!property || typeof property !== 'object' || property === null) {
      continue
    }

    const declaredType = (property as { type?: unknown }).type
    if (typeof declaredType !== 'string') {
      continue
    }

    if (!matchesSchemaType(value, declaredType)) {
      throw new OpenAICompatibleRequestError(
        `Tool input for ${toolName}.${key} expected ${declaredType} but received ${typeof value}.`,
        {
          code: 'tool_schema_error',
          retryable: false,
        },
      )
    }
  }
}

function matchesSchemaType(value: unknown, schemaType: string): boolean {
  switch (schemaType) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function isRetryableRequestError(error: unknown): boolean {
  return (
    error instanceof OpenAICompatibleRequestError && error.retryable === true
  )
}

function parseStreamingChunk(data: string): OpenAICompatibleChatCompletionChunk {
  try {
    return JSON.parse(data) as OpenAICompatibleChatCompletionChunk
  } catch {
    throw new OpenAICompatibleRequestError(
      `Streaming chunk is not valid JSON: ${data}`,
      {
        code: 'stream_error',
        retryable: true,
      },
    )
  }
}

export class OpenAICompatibleRequestError extends Error {
  readonly code: OpenAICompatibleErrorCode
  readonly retryable: boolean
  readonly status?: number

  constructor(
    message: string,
    options: {
      code: OpenAICompatibleErrorCode
      retryable: boolean
      status?: number
      cause?: unknown
    },
  ) {
    super(message)
    this.name = 'OpenAICompatibleRequestError'
    this.code = options.code
    this.retryable = options.retryable
    this.status = options.status
    if ('cause' in Error.prototype) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}
