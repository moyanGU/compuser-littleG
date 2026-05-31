import type { QueryMessage } from '../../core/QueryEngine.js'
import {
  buildFullCompactPrompt,
  buildSessionMemoryPrompt,
} from './CompactPrompts.js'
import type { ModelClient } from '../../core/ModelClient.js'
import type { MemoryFact } from '../context/ContextAssembler.js'

export type CompactTier = 'none' | 'micro' | 'session-memory' | 'full'

export interface CompactBudgetState {
  estimatedInputTokens: number
  softLimit: number
  hardLimit: number
  headroom: number
}

export interface CompactResult {
  messages: QueryMessage[]
  compacted: boolean
  tier: CompactTier
  summary?: string
  budget: CompactBudgetState
}

export interface CompactStrategy {
  compact(messages: QueryMessage[], signal?: AbortSignal): Promise<CompactResult>
}

export interface CompactModelInvoker {
  sessionMemoryCompact(messages: QueryMessage[], signal?: AbortSignal): Promise<{
    summaryText: string
    memoryFacts?: MemoryFact[]
  }>
  fullCompact(messages: QueryMessage[], signal?: AbortSignal): Promise<{
    summaryText: string
  }>
}

export class NoopCompactStrategy implements CompactStrategy {
  async compact(messages: QueryMessage[]): Promise<CompactResult> {
    return {
      messages,
      compacted: false,
      tier: 'none',
      budget: createBudgetState(messages),
    }
  }
}

export interface RuleBasedMicroCompactStrategyOptions {
  keepRecentToolMessages?: number
  maxInlineToolContentChars?: number
  compactibleToolNames?: string[]
  softLimit?: number
  hardLimit?: number
  headroom?: number
  minSessionMemoryMessages?: number
  modelInvoker?: CompactModelInvoker
  maxConsecutiveCompactFailures?: number
}

export class RuleBasedMicroCompactStrategy implements CompactStrategy {
  private readonly keepRecentToolMessages: number
  private readonly maxInlineToolContentChars: number
  private readonly compactibleToolNames: Set<string>
  private readonly softLimit: number
  private readonly hardLimit: number
  private readonly headroom: number
  private readonly minSessionMemoryMessages: number
  private readonly modelInvoker?: CompactModelInvoker
  private readonly maxConsecutiveCompactFailures: number
  private consecutiveCompactFailures = 0
  private compactPaused = false

  constructor(options: RuleBasedMicroCompactStrategyOptions = {}) {
    this.keepRecentToolMessages = options.keepRecentToolMessages ?? 2
    this.maxInlineToolContentChars = options.maxInlineToolContentChars ?? 400
    this.compactibleToolNames = new Set(
      options.compactibleToolNames ?? [
        'windows.snapshot',
        'windows.screenshot',
        'workspace.grep',
        'workspace.glob',
        'workspace.read_text',
        'command.workspace.inspect_tree',
        'command.workspace.search_text',
        'command.workspace.read_text',
        'artifacts.read_result',
      ],
    )
    this.softLimit = options.softLimit ?? 18_000
    this.hardLimit = options.hardLimit ?? 24_000
    this.headroom = options.headroom ?? 4_000
    this.minSessionMemoryMessages = options.minSessionMemoryMessages ?? 8
    this.modelInvoker = options.modelInvoker
    this.maxConsecutiveCompactFailures = options.maxConsecutiveCompactFailures ?? 3
  }

  async compact(messages: QueryMessage[], signal?: AbortSignal): Promise<CompactResult> {
    if (this.compactPaused) {
      return {
        messages,
        compacted: false,
        tier: 'none',
        summary: `Auto compact paused after ${this.consecutiveCompactFailures} consecutive compact failures.`,
        budget: createBudgetState(
          messages,
          this.softLimit,
          this.hardLimit,
          this.headroom,
        ),
      }
    }

    const initialBudget = createBudgetState(
      messages,
      this.softLimit,
      this.hardLimit,
      this.headroom,
    )

    const micro = this.applyMicroCompact(messages)
    const microBudget = createBudgetState(
      micro.messages,
      this.softLimit,
      this.hardLimit,
      this.headroom,
    )

    if (microBudget.estimatedInputTokens <= this.softLimit) {
      return {
        messages: micro.messages,
        compacted: micro.compacted,
        tier: micro.compacted ? 'micro' : 'none',
        summary: micro.summary,
        budget: microBudget,
      }
    }

    const sessionMemory = await this.applySessionMemoryCompact(micro.messages, signal)
    const sessionBudget = createBudgetState(
      sessionMemory.messages,
      this.softLimit,
      this.hardLimit,
      this.headroom,
    )
    if (sessionBudget.estimatedInputTokens <= this.hardLimit) {
      return {
        messages: sessionMemory.messages,
        compacted: true,
        tier: 'session-memory',
        summary:
          sessionMemory.summary ??
          `Session-memory compact reduced messages from ${messages.length} to ${sessionMemory.messages.length}.`,
        budget: sessionBudget,
      }
    }

    const fullCompact = await this.applyFullCompact(messages, initialBudget, signal)
    return {
      messages: fullCompact.messages,
      compacted: true,
      tier: 'full',
      summary: fullCompact.summary,
      budget: createBudgetState(
        fullCompact.messages,
        this.softLimit,
        this.hardLimit,
        this.headroom,
      ),
    }
  }

  private applyMicroCompact(messages: QueryMessage[]): {
    messages: QueryMessage[]
    compacted: boolean
    summary?: string
  } {
    const toolIndexes = messages.reduce<number[]>((indexes, message, index) => {
      if (message.role === 'tool') {
        indexes.push(index)
      }
      return indexes
    }, [])

    if (toolIndexes.length <= this.keepRecentToolMessages) {
      return {
        messages,
        compacted: false,
      }
    }

    const compactUntil = Math.max(0, toolIndexes.length - this.keepRecentToolMessages)
    let compactedCount = 0

    const compactedMessages = messages.map((message, index) => {
      if (message.role !== 'tool') {
        return message
      }

      const toolPosition = toolIndexes.indexOf(index)
      if (toolPosition < 0 || toolPosition >= compactUntil) {
        return message
      }

      const compacted = compactToolMessage(
        message,
        this.maxInlineToolContentChars,
        this.compactibleToolNames,
      )

      if (compacted !== message) {
        compactedCount += 1
      }

      return compacted
    })

    return {
      messages: compactedMessages,
      compacted: compactedCount > 0,
      summary:
        compactedCount > 0
          ? `Micro-compacted ${compactedCount} older tool result messages.`
          : undefined,
    }
  }

  private async applySessionMemoryCompact(messages: QueryMessage[], signal?: AbortSignal): Promise<{
    messages: QueryMessage[]
    summary: string
  }> {
    if (messages.length <= this.minSessionMemoryMessages) {
      return {
        messages,
        summary: 'Session-memory compact skipped because the message window is already small.',
      }
    }

    const recentMessages = messages.slice(-this.minSessionMemoryMessages)
    const olderMessages = messages.slice(0, -this.minSessionMemoryMessages)
    let invoked:
      | {
          summaryText: string
          memoryFacts?: MemoryFact[]
        }
      | undefined

    try {
      invoked = this.modelInvoker
        ? await this.modelInvoker.sessionMemoryCompact(olderMessages, signal)
        : undefined
      this.markCompactSuccess()
    } catch (error) {
      this.markCompactFailure()
      return {
        messages,
        summary: buildCompactFailureSummary(
          'session-memory',
          error,
          this.consecutiveCompactFailures,
          this.compactPaused,
        ),
      }
    }

    const memorySummary =
      invoked?.summaryText.trim() ||
      buildSessionMemoryPrompt(olderMessages)
    const summaryMessage: QueryMessage = {
      role: 'system',
      content: JSON.stringify({
        kind: 'session-memory',
        summary: memorySummary,
        memoryFacts: invoked?.memoryFacts ?? [],
      }),
    }

    return {
      messages: [summaryMessage, ...recentMessages],
      summary:
        invoked?.summaryText.trim() ||
        `Session-memory compact summarized ${olderMessages.length} older messages and kept ${recentMessages.length} recent messages.`,
    }
  }

  private async applyFullCompact(
    messages: QueryMessage[],
    budget: CompactBudgetState,
    signal?: AbortSignal,
  ): Promise<{
    messages: QueryMessage[]
    summary: string
  }> {
    let invoked:
      | {
          summaryText: string
        }
      | undefined

    try {
      invoked = this.modelInvoker
        ? await this.modelInvoker.fullCompact(messages, signal)
        : undefined
      this.markCompactSuccess()
    } catch (error) {
      this.markCompactFailure()
      const recentTail = collectRecentConversationTail(messages, 4)
      return {
        messages: recentTail.length > 0 ? recentTail : messages,
        summary: buildCompactFailureSummary(
          'full',
          error,
          this.consecutiveCompactFailures,
          this.compactPaused,
          budget.estimatedInputTokens,
        ),
      }
    }

    const summaryMessage: QueryMessage = {
      role: 'system',
      content:
        invoked?.summaryText.trim() || buildFullCompactPrompt(messages),
    }
    const recentTail = collectRecentConversationTail(messages, 4)
    return {
      messages: [summaryMessage, ...recentTail],
      summary: `Full compact summarized ${messages.length} messages after estimated tokens reached ${budget.estimatedInputTokens}.`,
    }
  }

  private markCompactSuccess(): void {
    this.consecutiveCompactFailures = 0
  }

  private markCompactFailure(): void {
    this.consecutiveCompactFailures += 1
    if (this.consecutiveCompactFailures >= this.maxConsecutiveCompactFailures) {
      this.compactPaused = true
    }
  }
}

function compactToolMessage(
  message: QueryMessage,
  maxInlineToolContentChars: number,
  compactibleToolNames: Set<string>,
): QueryMessage {
  const parsed = parseToolMessage(message.content)
  const toolName = parsed?.toolName ?? message.toolName

  if (toolName && !compactibleToolNames.has(toolName)) {
    return message
  }

  if (message.content.length <= maxInlineToolContentChars && parsed?.pointer) {
    return message
  }

  if (!parsed) {
    return {
      ...message,
      content: JSON.stringify({
        compacted: true,
        summary: 'Older tool result compacted into preview form.',
        preview: message.content.slice(0, maxInlineToolContentChars),
      }),
    }
  }

  return {
    ...message,
    content: JSON.stringify({
      toolName: parsed.toolName ?? message.toolName,
      ok: parsed.ok,
      summary: parsed.summary ?? 'Older tool result compacted into summary form.',
      error: parsed.error,
      failureClass: parsed.failureClass,
      pointer: parsed.pointer,
      compacted: true,
      note: 'older_tool_result_compacted',
    }),
  }
}

function parseToolMessage(content: string): {
  toolName?: string
  ok?: boolean
  summary?: string
  error?: string
  failureClass?: string
  pointer?: string
} | null {
  try {
    const parsed = JSON.parse(content) as {
      toolName?: unknown
      ok?: unknown
      summary?: unknown
      error?: unknown
      failureClass?: unknown
      pointer?: unknown
    }

    return {
      toolName:
        typeof parsed.toolName === 'string' ? parsed.toolName : undefined,
      ok: typeof parsed.ok === 'boolean' ? parsed.ok : undefined,
      summary:
        typeof parsed.summary === 'string' ? parsed.summary : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      failureClass:
        typeof parsed.failureClass === 'string'
          ? parsed.failureClass
          : undefined,
      pointer:
        typeof parsed.pointer === 'string' ? parsed.pointer : undefined,
    }
  } catch {
    return null
  }
}

function collectRecentConversationTail(
  messages: QueryMessage[],
  keepCount: number,
): QueryMessage[] {
  const nonSystemMessages = messages.filter(message => message.role !== 'system')
  return nonSystemMessages.slice(-keepCount)
}

function createBudgetState(
  messages: QueryMessage[],
  softLimit = 18_000,
  hardLimit = 24_000,
  headroom = 4_000,
): CompactBudgetState {
  const estimatedInputTokens = Math.ceil(
    messages.reduce((total, message) => total + message.content.length, 0) / 4,
  )

  return {
    estimatedInputTokens,
    softLimit,
    hardLimit,
    headroom,
  }
}

function buildCompactFailureSummary(
  tier: 'session-memory' | 'full',
  error: unknown,
  failures: number,
  paused: boolean,
  estimatedTokens?: number,
): string {
  const reason = error instanceof Error ? error.message : String(error)
  return [
    `${tier} compact failed: ${reason}`,
    `consecutiveFailures=${failures}`,
    estimatedTokens !== undefined ? `estimatedTokens=${estimatedTokens}` : undefined,
    paused ? 'autoCompactPaused=true' : 'autoCompactPaused=false',
    tier === 'session-memory'
      ? 'degraded to existing message window without session-memory summary'
      : 'degraded to recent conversation tail only',
  ]
    .filter(Boolean)
    .join('; ')
}
