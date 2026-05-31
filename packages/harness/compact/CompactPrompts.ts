import type { QueryMessage } from '../../core/QueryEngine.js'

export function buildSessionMemoryPrompt(messages: QueryMessage[]): string {
  return [
    'Summarize only stable facts from the older conversation window.',
    'Return strict JSON with this shape:',
    '{"taskCurrent":"string","taskPlan":"string","taskLastOutcome":"string","routingLastAttempt":"string","routingExecutionState":"string","projectStructure":"string","projectRecentPaths":["string"],"preferenceResponseLanguage":"string","preferenceExecutionPath":"string","constraintActive":"string","compactLastSummary":"string"}',
    'Rules:',
    '- Keep durable facts only.',
    '- Do not include chronological narration.',
    '- Use empty strings or empty arrays when unknown.',
    '- Preserve concrete paths and pointers when present.',
    '',
    'Conversation window:',
    summarizeMessages(messages)
      .map(
        message =>
          `[${message.role}${message.toolName ? `:${message.toolName}` : ''}] ${message.contentPreview}`,
      )
      .join('\n'),
  ].join('\n')
}

export function buildFullCompactPrompt(messages: QueryMessage[]): string {
  return [
    'Summarize the conversation into a structured compact boundary.',
    'Return exactly two XML sections: <analysis>...</analysis><summary>...</summary>.',
    'The <summary> section must be concise and include user intent, key actions, errors, fixes, remaining work, current routing state, and any important paths or pointers.',
    'The <analysis> section can reason freely but will not be shown back to the main context.',
    '',
    'Conversation window:',
    summarizeMessages(messages)
      .map(
        message =>
          `[${message.role}${message.toolName ? `:${message.toolName}` : ''}] ${message.contentPreview}`,
      )
      .join('\n'),
  ].join('\n')
}

function summarizeMessages(messages: QueryMessage[]): Array<{
  role: QueryMessage['role']
  toolName?: string
  contentPreview: string
}> {
  return messages.map(message => ({
    role: message.role,
    toolName: message.toolName,
    contentPreview: message.content.slice(0, 240),
  }))
}
