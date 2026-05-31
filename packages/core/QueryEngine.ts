import {
  NoopCompactStrategy,
  type CompactStrategy,
} from '../harness/compact/CompactStrategy.js'
import type {
  CapabilityCatalog,
  CapabilityFailureClass,
} from '../capabilities/Capability.js'
import {
  matchesRetryOn,
  resolveCapabilityRoutingExecutionState,
  resolveRoutingAttemptPolicy,
  type CapabilityRoutingExecutionState,
  type RoutingAttemptOutcome,
  type RoutingAttemptPolicy,
  type RoutingAttemptRecord,
} from '../capabilities/CapabilityRouting.js'
import { MEMORY_FACT_KEYS } from '../harness/context/ContextAssembler.js'
import type {
  CompactContextState,
  ContextAssembler,
  MemoryFact,
} from '../harness/context/ContextAssembler.js'
import type { MemoryStore } from '../harness/memory/MemoryStore.js'
import { extractSessionMemoryFacts } from '../harness/memory/SessionMemoryExtractor.js'
import type { ModelClient } from './ModelClient.js'
import {
  ALWAYS_VISIBLE_CAPABILITY_TOOL_NAMES,
  isCapabilityToolName,
} from '../capabilities/CapabilityTools.js'
import {
  ExecutionAbortedError,
  throwIfExecutionAborted,
} from './ExecutionControl.js'
import type {
  ToolCall,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from '../tools/Tool.js'
import type { ToolRuntime } from '../tools/runtime/ToolRuntime.js'

const ALWAYS_AVAILABLE_RECOVERY_TOOL_NAMES = new Set<string>([
  'command.app.open_or_focus',
  'command.desktop.capture_and_locate',
  'command.browser.inspect_dom',
])

export interface QueryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
}

export interface QueryTurnResult {
  messages: QueryMessage[]
  finalText: string
  toolResults: ToolResult[]
  stopReason: 'final' | 'max_turns' | 'aborted'
}

export interface QueryEngineOptions {
  cwd: string
  sessionId: string
  baseSystemPrompt: string
  modelClient: ModelClient
  registry: ToolRegistry
  runtime: ToolRuntime
  contextAssembler: ContextAssembler
  memoryStore: MemoryStore
  capabilityCatalog: CapabilityCatalog
  maxTurns?: number
  maxContextMessages?: number
  compactStrategy?: CompactStrategy
  executionSignal?: AbortSignal
}

export class QueryEngine {
  private readonly messages: QueryMessage[] = []
  private attemptHistory: RoutingAttemptRecord[] = []
  private readonly discoveredTools = new Set<string>()
  private readonly revealedCapabilities = new Set<string>(
    ALWAYS_VISIBLE_CAPABILITY_TOOL_NAMES,
  )
  private turnCounter = 0
  private compactState: CompactContextState = createDefaultCompactState()

  constructor(private readonly options: QueryEngineOptions) {}

  async submitUserMessage(input: string): Promise<QueryTurnResult> {
    const toolResults: ToolResult[] = []
    try {
      throwIfExecutionAborted(this.options.executionSignal)
      this.turnCounter += 1
      this.attemptHistory = []
      this.discoveredTools.clear()
      this.revealedCapabilities.clear()
      for (const toolName of ALWAYS_VISIBLE_CAPABILITY_TOOL_NAMES) {
        this.revealedCapabilities.add(toolName)
      }
      this.compactState = createDefaultCompactState()
      await this.resetRoutingMemoryState()

      const userMessage: QueryMessage = { role: 'user', content: input }
      this.messages.push(userMessage)
      await this.options.memoryStore.appendFact({
        key: 'task.current',
        category: 'task',
        content: compactMemoryText(input),
        mergeStrategy: 'replace',
      })
      await this.options.memoryStore.appendFact({
        key: 'task.plan',
        category: 'task',
        content: compactMemoryText(
          `Observe task intent, choose safest route, execute, verify, and recover if needed. User request: ${input}`,
        ),
        mergeStrategy: 'replace',
      })
      await this.persistSessionMemoryFacts(userMessage)

      const maxTurns = this.options.maxTurns ?? 6

      for (let step = 0; step < maxTurns; step += 1) {
        throwIfExecutionAborted(this.options.executionSignal)
        const memoryFacts = await this.options.memoryStore.listFacts()
        const routingExecutionState = this.getRoutingExecutionState()
        const visibleTools = this.getVisibleTools()
        const visibleCapabilities = this.getVisibleCapabilities()
        const hiddenDiscoverableToolCount = this.options.registry
          .list()
          .filter(tool => {
            if (isCapabilityToolName(tool.name)) {
              return false
            }
            const availability = tool.availability ?? 'core'
            return (
              availability === 'discoverable' &&
              !this.discoveredTools.has(tool.name)
            )
          }).length
        const context = this.options.contextAssembler.assemble({
          baseSystemPrompt: this.options.baseSystemPrompt,
          taskText: this.getLatestUserTaskText(),
          tools: visibleTools,
          hiddenDiscoverableToolCount,
          hiddenCapabilityCount:
            this.options.capabilityCatalog.list().length - visibleCapabilities.length,
          capabilities: visibleCapabilities,
          memoryFacts,
          routingExecutionState,
          compactState: this.compactState,
        })

        await this.options.runtime.notifyBeforeModelCall()
        await this.persistContextState(context)

        if (step === 0) {
          this.messages.push({
            role: 'system',
            content: `systemPrompt=${context.systemPrompt}`,
          })
        }

        const modelResponse = await this.options.modelClient.generate({
          context,
          messages: await this.buildMessagesForModel(),
          signal: this.options.executionSignal,
        })

        if (modelResponse.type === 'final') {
          const assistantMessage: QueryMessage = {
            role: 'assistant',
            content: modelResponse.message,
          }
          this.messages.push(assistantMessage)
          await this.options.memoryStore.appendFact({
            key: 'task.last_outcome',
            category: 'task',
            content: compactMemoryText(modelResponse.message),
            mergeStrategy: 'replace',
          })
          await this.options.memoryStore.appendFact({
            key: 'routing.execution_state',
            category: 'routing',
            content: compactMemoryText(
              summarizeRoutingExecutionState(this.getRoutingExecutionState()),
            ),
            mergeStrategy: 'replace',
          })
          await this.persistSessionMemoryFacts(assistantMessage)
          return {
            messages: [...this.messages],
            finalText: modelResponse.message,
            toolResults,
            stopReason: 'final',
          }
        }

        const assistantMessage: QueryMessage = {
          role: 'assistant',
          content: modelResponse.assistantMessage,
          toolCalls: modelResponse.toolCalls,
        }
        this.messages.push(assistantMessage)
        await this.persistSessionMemoryFacts(assistantMessage)

        const roundToolResults = await this.executeTools(modelResponse.toolCalls)
        toolResults.push(...roundToolResults)
      }

      const finalText = `Reached max turns (${this.options.maxTurns ?? 6}) and stopped further execution.`
      const finalAssistantMessage: QueryMessage = {
        role: 'assistant',
        content: finalText,
      }
      this.messages.push(finalAssistantMessage)
      await this.options.memoryStore.appendFact({
        key: 'task.last_outcome',
        category: 'task',
        content: compactMemoryText(finalText),
        mergeStrategy: 'replace',
      })
      await this.persistSessionMemoryFacts(finalAssistantMessage)
      return {
        messages: [...this.messages],
        finalText,
        toolResults,
        stopReason: 'max_turns',
      }
    } catch (error) {
      if (error instanceof ExecutionAbortedError) {
        return await this.buildAbortedResult(toolResults, error.message)
      }
      throw error
    }
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    throwIfExecutionAborted(this.options.executionSignal)
    const result = await this.executeSingleToolCall(call)
    this.captureDiscoveredTools(call, result)

    const toolMessage: QueryMessage = {
      role: 'tool',
      content: formatToolMessageContent(call.toolName, result),
      toolCallId: call.callId,
      toolName: call.toolName,
    }
    this.messages.push(toolMessage)
    await this.recordRoutingAttempt(call, result)
    await this.persistSessionMemoryFacts(toolMessage)

    return result
  }

  async executeTools(calls: ToolCall[]): Promise<ToolResult[]> {
    if (calls.length === 0) {
      return []
    }

    const context = {
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      turnId: `turn-${this.turnCounter}`,
      signal: this.options.executionSignal,
    }
    const executionPairs = await this.options.runtime.executeMany(calls, context)
    const results: ToolResult[] = []

    for (let index = 0; index < calls.length; index += 1) {
      throwIfExecutionAborted(this.options.executionSignal)
      const call = calls[index]
      const result = executionPairs[index]
      this.captureDiscoveredTools(call, result)

      const toolMessage: QueryMessage = {
        role: 'tool',
        content: formatToolMessageContent(call.toolName, result),
        toolCallId: call.callId,
        toolName: call.toolName,
      }
      this.messages.push(toolMessage)
      await this.recordRoutingAttempt(call, result)
      await this.persistSessionMemoryFacts(toolMessage)
      results.push(result)
    }

    return results
  }

  getMessages(): QueryMessage[] {
    return [...this.messages]
  }

  private getLatestUserTaskText(): string {
    const latestUserMessage = [...this.messages]
      .reverse()
      .find(message => message.role === 'user')
    return latestUserMessage?.content ?? ''
  }

  private getVisibleTools(): ToolDefinition[] {
    return this.options.registry.list().filter(tool => {
      if (ALWAYS_AVAILABLE_RECOVERY_TOOL_NAMES.has(tool.name)) {
        return true
      }

      if (this.isDiscoverableCapabilityTool(tool)) {
        return this.revealedCapabilities.has(tool.name)
      }

      const availability = tool.availability ?? 'core'
      return availability === 'core' || this.discoveredTools.has(tool.name)
    })
  }

  private getVisibleCapabilities() {
    return this.options.capabilityCatalog
      .list()
      .filter(item => {
        if (item.availability === 'core') {
          return true
        }
        return this.revealedCapabilities.has(item.toolName)
      })
  }

  private async executeSingleToolCall(call: ToolCall): Promise<ToolResult> {
    throwIfExecutionAborted(this.options.executionSignal)
    const tool = this.options.registry.get(call.toolName)
    if (tool && ALWAYS_AVAILABLE_RECOVERY_TOOL_NAMES.has(call.toolName)) {
      return this.options.runtime.execute(call, {
        cwd: this.options.cwd,
        sessionId: this.options.sessionId,
        turnId: `turn-${this.turnCounter}`,
        signal: this.options.executionSignal,
      })
    }

    if (tool && this.isDiscoverableCapabilityTool(tool)) {
      if (!this.revealedCapabilities.has(call.toolName)) {
        return {
          ok: false,
          summary: `Capability ${call.toolName} must be revealed by capabilities.search before execution.`,
          error: 'CAPABILITY_DISCOVERY_REQUIRED',
          failureClass: 'deterministic',
          data: {
            requiredDiscoveryTool: 'capabilities.search',
            hiddenCapability: call.toolName,
          },
        }
      }
    }

    if (
      tool &&
      !this.isDiscoverableCapabilityTool(tool) &&
      (tool.availability ?? 'core') === 'discoverable' &&
      !this.discoveredTools.has(call.toolName)
    ) {
      return {
        ok: false,
        summary: `Discoverable tool ${call.toolName} must be revealed by tools.search before execution.`,
        error: 'TOOL_DISCOVERY_REQUIRED',
        failureClass: 'deterministic',
        data: {
          requiredDiscoveryTool: 'tools.search',
          discoverableTool: call.toolName,
        },
      }
    }

    return this.options.runtime.execute(call, {
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      turnId: `turn-${this.turnCounter}`,
      signal: this.options.executionSignal,
    })
  }

  private getRoutingExecutionState(): CapabilityRoutingExecutionState {
    return resolveCapabilityRoutingExecutionState({
      attempts: this.attemptHistory,
      capabilities: this.options.capabilityCatalog.list(),
      tools: this.options.registry.list(),
    })
  }

  private async recordRoutingAttempt(
    call: ToolCall,
    result: ToolResult,
  ): Promise<void> {
    const executionStateBeforeAttempt = this.getRoutingExecutionState()
    const policy = resolveRoutingAttemptPolicy({
      toolName: call.toolName,
      capabilities: this.options.capabilityCatalog.list(),
      tools: this.options.registry.list(),
    })
    const attempt = buildRoutingAttemptRecord(
      call,
      result,
      this.attemptHistory.length + 1,
      `turn-${this.turnCounter}`,
      policy,
      executionStateBeforeAttempt,
    )
    this.attemptHistory.push(attempt)

    const executionState = this.getRoutingExecutionState()
    const verificationPassed = readVerificationPassed(result.data)

    await this.options.memoryStore.appendFact({
      key: 'routing.last_attempt',
      category: 'routing',
      content: compactMemoryText(
        `${attempt.toolName}: status=${attempt.outcome}; failureClass=${attempt.failureClass ?? 'n/a'}; exhausted=${attempt.exhausted}; route=${attempt.route ?? 'n/a'}; turn=${attempt.turnId}`,
      ),
      mergeStrategy: 'replace',
    })

    await this.options.memoryStore.appendFact({
      key: 'routing.execution_state',
      category: 'routing',
      content: compactMemoryText(
        summarizeRoutingExecutionState(executionState),
      ),
      mergeStrategy: 'replace',
    })

    await this.options.memoryStore.appendFact({
      key: 'task.last_outcome',
      category: 'task',
      content: compactMemoryText(
        `${call.toolName}: ok=${result.ok}; summary=${result.summary}`,
      ),
      mergeStrategy: 'replace',
    })
    await this.persistChainStateFacts(call.toolName, result, attempt.outcome)
  }

  private async persistSessionMemoryFacts(message: QueryMessage): Promise<void> {
    const facts = extractSessionMemoryFacts(message)
    for (const fact of facts) {
      await this.options.memoryStore.appendFact(fact)
    }
  }

  private async persistContextState(
    context: Awaited<ReturnType<ContextAssembler['assemble']>>,
  ): Promise<void> {
    await this.options.memoryStore.appendFact({
      key: 'task.plan',
      category: 'task',
      content: compactMemoryText(
        `Goal=${context.activePlan.goal}; subgoal=${context.activePlan.subgoal}; status=${context.activePlan.status}`,
      ),
      mergeStrategy: 'replace',
    })
    if (context.chainState.currentTarget) {
      await this.options.memoryStore.appendFact({
        key: 'task.current_target',
        category: 'task',
        content: compactMemoryText(context.chainState.currentTarget),
        mergeStrategy: 'replace',
      })
    }
    if (context.chainState.currentArtifact) {
      await this.options.memoryStore.appendFact({
        key: 'task.current_artifact',
        category: 'task',
        content: compactMemoryText(context.chainState.currentArtifact),
        mergeStrategy: 'replace',
      })
    }
  }

  private captureDiscoveredTools(call: ToolCall, result: ToolResult): void {
    if (call.toolName === 'capabilities.search' && result.ok) {
      const matches = readSearchMatches(result.data)
      for (const match of matches) {
        if (
          this.options.capabilityCatalog
            .list()
            .some(item => item.toolName === match)
        ) {
          this.revealedCapabilities.add(match)
        }
      }
      markCapabilitySearchMatchesAsRevealed(result.data, this.revealedCapabilities)
      return
    }

    if (call.toolName !== 'tools.search' || !result.ok) {
      return
    }

    const matches = readSearchMatches(result.data)
    for (const match of matches) {
      this.discoveredTools.add(match)
    }
  }

  private isDiscoverableCapabilityTool(tool: ToolDefinition): boolean {
    if (!isCapabilityToolName(tool.name)) {
      return false
    }

    return (tool.availability ?? 'core') !== 'core'
  }

  private async resetRoutingMemoryState(): Promise<void> {
    await this.options.memoryStore.appendFact({
      key: 'routing.last_attempt',
      category: 'routing',
      content: 'No capability or tool attempts have run for the current task yet.',
      mergeStrategy: 'replace',
    })
    await this.options.memoryStore.appendFact({
      key: 'routing.execution_state',
      category: 'routing',
      content: 'Routing state reset for a new task.',
      mergeStrategy: 'replace',
    })
    await this.options.memoryStore.appendFact({
      key: 'routing.last_verified_anchor',
      category: 'routing',
      content: 'No verified anchor has been recorded for the current task yet.',
      mergeStrategy: 'replace',
    })
    await this.options.memoryStore.appendFact({
      key: 'routing.last_recovery_point',
      category: 'routing',
      content: 'No recovery point has been recorded for the current task yet.',
      mergeStrategy: 'replace',
    })
    await this.options.memoryStore.appendFact({
      key: 'routing.chain_status',
      category: 'routing',
      content: 'idle',
      mergeStrategy: 'replace',
    })
  }

  private async buildMessagesForModel(): Promise<QueryMessage[]> {
    const maxContextMessages = this.options.maxContextMessages ?? 12
    const nonSystemMessages = this.messages.filter(message => message.role !== 'system')

    const windowedMessages =
      nonSystemMessages.length <= maxContextMessages
        ? [...this.messages]
        : buildRecentContextWindow(nonSystemMessages, maxContextMessages)

    const compactStrategy =
      this.options.compactStrategy ?? new NoopCompactStrategy()
    const compacted = await compactStrategy.compact(
      windowedMessages,
      this.options.executionSignal,
    )

    this.compactState = {
      tier: compacted.tier,
      tokenBudget: {
        softLimit: compacted.budget.softLimit,
        hardLimit: compacted.budget.hardLimit,
        headroom: compacted.budget.headroom,
        estimatedInputTokens: compacted.budget.estimatedInputTokens,
      },
      lastSummary: compacted.summary,
    }

    await this.options.memoryStore.appendFact({
      key: 'compact.last_summary',
      category: 'compact',
      content: compactMemoryText(
        compacted.summary ??
          `Compact tier=${compacted.tier}; estimatedTokens=${compacted.budget.estimatedInputTokens}`,
      ),
      mergeStrategy: 'replace',
    })

    if (compacted.tier === 'session-memory') {
      const sessionFacts = extractCompactMemoryFacts(compacted.messages[0]?.content)
      for (const fact of sessionFacts) {
        await this.options.memoryStore.appendFact(fact)
      }
    }

    return compacted.messages
  }

  private async buildAbortedResult(
    toolResults: ToolResult[],
    reason: string,
  ): Promise<QueryTurnResult> {
    const finalText = 'Task execution was stopped by the user.'
    const finalAssistantMessage: QueryMessage = {
      role: 'assistant',
      content: finalText,
    }
    this.messages.push(finalAssistantMessage)
    await this.options.memoryStore.appendFact({
      key: 'task.last_outcome',
      category: 'task',
      content: compactMemoryText(`${finalText} ${reason}`),
      mergeStrategy: 'replace',
    })
    await this.options.memoryStore.appendFact({
      key: 'routing.execution_state',
      category: 'routing',
      content: compactMemoryText(`aborted; reason=${reason}`),
      mergeStrategy: 'replace',
    })
    await this.options.memoryStore.appendFact({
      key: 'routing.chain_status',
      category: 'routing',
      content: 'blocked',
      mergeStrategy: 'replace',
    })
    await this.persistSessionMemoryFacts(finalAssistantMessage)
    return {
      messages: [...this.messages],
      finalText,
      toolResults,
      stopReason: 'aborted',
    }
  }

  private async persistChainStateFacts(
    toolName: string,
    result: ToolResult,
    attemptOutcome: RoutingAttemptOutcome,
  ): Promise<void> {
    const chainState = readChainState(result.data)
    const recoveryPoint = readRecoveryPoint(result.data)
    const verificationEvidence = readVerificationEvidence(result.data)

    const currentTarget = chainState?.currentTarget
    if (currentTarget) {
      await this.options.memoryStore.appendFact({
        key: 'task.current_target',
        category: 'task',
        content: compactMemoryText(currentTarget),
        mergeStrategy: 'replace',
      })
    }

    const currentArtifact = chainState?.currentArtifact ?? result.pointer
    if (currentArtifact) {
      await this.options.memoryStore.appendFact({
        key: 'task.current_artifact',
        category: 'task',
        content: compactMemoryText(currentArtifact),
        mergeStrategy: 'replace',
      })
    }

    const lastVerifiedAnchor = chainState?.lastVerifiedAnchor
    if (lastVerifiedAnchor) {
      await this.options.memoryStore.appendFact({
        key: 'routing.last_verified_anchor',
        category: 'routing',
        content: compactMemoryText(lastVerifiedAnchor),
        mergeStrategy: 'replace',
      })
    }

    if (recoveryPoint) {
      await this.options.memoryStore.appendFact({
        key: 'routing.last_recovery_point',
        category: 'routing',
        content: compactMemoryText(recoveryPoint),
        mergeStrategy: 'replace',
      })
    }

    const chainStatus = resolveChainStatus(result, attemptOutcome, chainState)
    await this.options.memoryStore.appendFact({
      key: 'routing.chain_status',
      category: 'routing',
      content: chainStatus,
      mergeStrategy: 'replace',
    })

    if (verificationEvidence.length > 0) {
      await this.options.memoryStore.appendFact({
        key: 'task.last_outcome',
        category: 'task',
        content: compactMemoryText(
          `${toolName}: ok=${result.ok}; verification=${verificationEvidence.join(' | ')}`,
        ),
        mergeStrategy: 'replace',
      })
    }
  }
}

function formatToolMessageContent(
  toolName: string,
  result: ToolResult,
): string {
  return JSON.stringify({
    toolName,
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error,
    failureClass: result.failureClass,
    pointer: result.pointer,
  })
}

function createDefaultCompactState(): CompactContextState {
  return {
    tier: 'none',
    tokenBudget: {
      softLimit: 18_000,
      hardLimit: 24_000,
      headroom: 4_000,
      estimatedInputTokens: 0,
    },
  }
}

function compactMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function buildRecentContextWindow(
  nonSystemMessages: QueryMessage[],
  maxContextMessages: number,
): QueryMessage[] {
  const kept: QueryMessage[] = []
  let keptCount = 0

  for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
    const current = nonSystemMessages[index]
    kept.unshift(current)
    keptCount += 1

    if (keptCount < maxContextMessages) {
      continue
    }

    if (current.role === 'tool') {
      const previous = nonSystemMessages[index - 1]
      if (previous?.role === 'assistant' && previous.toolCalls?.length) {
        kept.unshift(previous)
      }
    }
    break
  }

  return kept
}

function buildRoutingAttemptRecord(
  call: ToolCall,
  result: ToolResult,
  sequence: number,
  turnId: string,
  policy: RoutingAttemptPolicy,
  executionStateBeforeAttempt: CapabilityRoutingExecutionState,
): RoutingAttemptRecord {
  const verificationPassed = readVerificationPassed(result.data)
  const failureClass =
    result.failureClass ??
    readFailureClass(result.data) ??
    inferFailureClass(result.error, verificationPassed)
  const outcome = classifyRoutingAttemptOutcome(result, verificationPassed)
  const previousFailedAttempts = executionStateBeforeAttempt.recentAttempts.filter(
    attempt =>
      attempt.toolName === call.toolName &&
      isRetryRelevantOutcome(attempt.outcome) &&
      matchesRetryOn(policy, attempt.failureClass),
  ).length
  const failedAttemptCount =
    previousFailedAttempts +
    (isRetryRelevantOutcome(outcome) && matchesRetryOn(policy, failureClass) ? 1 : 0)
  const exhausted =
    outcome === 'blocked' ||
    (outcome !== 'succeeded' &&
      (
        !matchesRetryOn(policy, failureClass) ||
        !policy.retryable ||
        failedAttemptCount >= policy.maxAttempts
      ))

  return {
    toolName: call.toolName,
    kind: isCapabilityTool(call.toolName) ? 'capability' : 'tool',
    outcome,
    turnId,
    sequence,
    summary: result.summary,
    error: result.error,
    verificationPassed,
    route: readRoute(result.data),
    failureClass,
    retryable: policy.retryable,
    maxAttempts: policy.maxAttempts,
    retryOn: policy.retryOn,
    exhausted,
    exhaustedReason:
      outcome === 'succeeded'
        ? undefined
        : outcome === 'blocked'
          ? 'blocked'
          : !matchesRetryOn(policy, failureClass) || !policy.retryable
            ? 'non_retryable'
            : failedAttemptCount >= policy.maxAttempts
              ? 'max_attempts'
              : undefined,
  }
}

function classifyRoutingAttemptOutcome(
  result: ToolResult,
  verificationPassed: boolean | undefined,
): RoutingAttemptOutcome {
  if (result.ok && verificationPassed !== false) {
    return 'succeeded'
  }

  if (isBlockedError(result.error)) {
    return 'blocked'
  }

  if (verificationPassed === false) {
    return 'verified_failed'
  }

  return 'failed'
}

function summarizeRoutingExecutionState(
  executionState: CapabilityRoutingExecutionState,
): string {
  return [
    `attempted=${executionState.attemptedTools.join(', ') || 'none'}`,
    `failed=${executionState.failedTools.join(', ') || 'none'}`,
    `blocked=${executionState.blockedTools.join(', ') || 'none'}`,
    `exhausted=${executionState.exhaustedTools.join(', ') || 'none'}`,
    `subgoal=${executionState.currentSubgoal ?? 'none'}`,
    `verification=${executionState.lastVerificationResult ?? 'unknown'}`,
    `last=${executionState.lastAttempt?.toolName ?? 'none'}`,
    `lastOutcome=${executionState.lastAttempt?.outcome ?? 'none'}`,
  ].join('; ')
}

function readFailureClass(data: unknown): CapabilityFailureClass | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const failureClass = (data as { failureClass?: unknown }).failureClass
  if (
    failureClass === 'transient' ||
    failureClass === 'deterministic' ||
    failureClass === 'permission' ||
    failureClass === 'missing_dependency'
  ) {
    return failureClass
  }

  return undefined
}

function readVerificationPassed(data: unknown): boolean | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    return undefined
  }

  const passed = (verification as { passed?: unknown }).passed
  return typeof passed === 'boolean' ? passed : undefined
}

function readRoute(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const route = (data as { route?: unknown }).route
  return typeof route === 'string' ? route : undefined
}

function readChainState(
  data: unknown,
):
  | {
      currentTarget?: string
      currentArtifact?: string
      lastVerifiedAnchor?: string
      chainStatus?: string
    }
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const chainState = (data as { chainState?: unknown }).chainState
  if (typeof chainState !== 'object' || chainState === null) {
    return undefined
  }

  return {
    currentTarget: readStringField(chainState, 'currentTarget'),
    currentArtifact: readStringField(chainState, 'currentArtifact'),
    lastVerifiedAnchor: readStringField(chainState, 'lastVerifiedAnchor'),
    chainStatus: readStringField(chainState, 'chainStatus'),
  }
}

function readRecoveryPoint(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return readStringField(data, 'recoveryPoint')
}

function readVerificationEvidence(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const value = (data as { verificationEvidence?: unknown }).verificationEvidence
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string').slice(0, 5)
}

function readStringField(
  value: unknown,
  key: string,
): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}

function resolveChainStatus(
  result: ToolResult,
  attemptOutcome: RoutingAttemptOutcome,
  chainState:
    | {
        chainStatus?: string
      }
    | undefined,
): string {
  const explicit = chainState?.chainStatus
  if (
    explicit === 'idle' ||
    explicit === 'running' ||
    explicit === 'completed' ||
    explicit === 'verified_failed' ||
    explicit === 'execution_failed' ||
    explicit === 'blocked'
  ) {
    return explicit
  }

  if (attemptOutcome === 'blocked') {
    return 'blocked'
  }

  if (attemptOutcome === 'verified_failed') {
    return 'verified_failed'
  }

  if (!result.ok) {
    return 'execution_failed'
  }

  const verificationPassed = readVerificationPassed(result.data)
  if (verificationPassed === true) {
    return 'completed'
  }

  return 'running'
}

function isCapabilityTool(toolName: string): boolean {
  return isCapabilityToolName(toolName)
}

function isBlockedError(error: string | undefined): boolean {
  if (!error) {
    return false
  }

  return (
    error.startsWith('TOOL_PERMISSION_') ||
    error === 'TOOL_NOT_FOUND' ||
    error === 'CAPABILITY_NOT_FOUND' ||
    error === 'CAPABILITY_DISCOVERY_REQUIRED'
  )
}

function inferFailureClass(
  error: string | undefined,
  verificationPassed: boolean | undefined,
): CapabilityFailureClass | undefined {
  if (!error) {
    return verificationPassed === false ? 'deterministic' : undefined
  }

  if (error.startsWith('TOOL_PERMISSION_')) {
    return 'permission'
  }

  if (
    error === 'TOOL_NOT_FOUND' ||
    error === 'CAPABILITY_NOT_FOUND' ||
    error === 'CLI_ADAPTER_MISSING'
  ) {
    return 'missing_dependency'
  }

  if (
    error === 'CLI_COMMAND_TIMEOUT' ||
    error.includes('TIMEOUT') ||
    error.includes('NETWORK') ||
    error.includes('HTTP_5')
  ) {
    return 'transient'
  }

  if (verificationPassed === false) {
    return 'deterministic'
  }

  return 'deterministic'
}

function markCapabilitySearchMatchesAsRevealed(
  data: unknown,
  revealedCapabilities: ReadonlySet<string>,
): void {
  if (typeof data !== 'object' || data === null) {
    return
  }

  const matches = (data as { matches?: unknown }).matches
  if (!Array.isArray(matches)) {
    return
  }

  for (const match of matches) {
    if (typeof match !== 'object' || match === null) {
      continue
    }

    const toolName = (match as { toolName?: unknown }).toolName
    if (typeof toolName !== 'string' || !isCapabilityToolName(toolName)) {
      continue
    }

    ;(match as { revealed?: boolean }).revealed =
      revealedCapabilities.has(toolName)
  }
}

function isRetryRelevantOutcome(outcome: RoutingAttemptOutcome): boolean {
  return outcome !== 'succeeded'
}

function readSearchMatches(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const matches = (data as { matches?: unknown }).matches
  if (!Array.isArray(matches)) {
    return []
  }

  return matches
    .map(match => {
      if (typeof match === 'string') {
        return match
      }

      if (
        typeof match === 'object' &&
        match !== null &&
        typeof (match as { name?: unknown }).name === 'string'
      ) {
        return (match as { name: string }).name
      }

      if (
        typeof match === 'object' &&
        match !== null &&
        typeof (match as { toolName?: unknown }).toolName === 'string'
      ) {
        return (match as { toolName: string }).toolName
      }

      return undefined
    })
    .filter((value): value is string => Boolean(value))
}

function extractCompactMemoryFacts(content: string | undefined): MemoryFact[] {
  if (!content) {
    return []
  }

  try {
    const parsed = JSON.parse(content) as {
      kind?: unknown
      memoryFacts?: unknown
    }
    if (parsed.kind !== 'session-memory' || !Array.isArray(parsed.memoryFacts)) {
      return []
    }

    const validKeys = new Set<string>(MEMORY_FACT_KEYS)
    return parsed.memoryFacts.filter((fact): fact is MemoryFact => {
      if (typeof fact !== 'object' || fact === null) {
        return false
      }

      const key = (fact as { key?: unknown }).key
      const category = (fact as { category?: unknown }).category
      const contentValue = (fact as { content?: unknown }).content
      const mergeStrategy = (fact as { mergeStrategy?: unknown }).mergeStrategy

      return (
        typeof key === 'string' &&
        validKeys.has(key) &&
        typeof category === 'string' &&
        typeof contentValue === 'string' &&
        (mergeStrategy === undefined ||
          mergeStrategy === 'replace' ||
          mergeStrategy === 'append')
      )
    })
  } catch {
    return []
  }
}
