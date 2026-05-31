import type { MemoryFact } from '../context/ContextAssembler.js'
import type { QueryMessage } from '../../core/QueryEngine.js'

const WINDOWS_PATH_PATTERN = /[a-zA-Z]:\\[^\s"'`，。；：！？（）【】《》<>|]+/g

export function extractSessionMemoryFacts(message: QueryMessage): MemoryFact[] {
  const facts: MemoryFact[] = []

  if (message.role === 'tool') {
    facts.push(...extractToolFacts(message))
    return dedupeFacts(facts)
  }

  facts.push(...extractPathFacts(message.content))

  if (message.role !== 'user') {
    return dedupeFacts(facts)
  }

  const normalized = normalizeText(message.content)
  const lower = normalized.toLowerCase()

  if (/(中文|汉语|chinese)/i.test(normalized)) {
    facts.push({
      key: 'preference.response_language',
      category: 'preference',
      content: 'User prefers Chinese responses.',
      mergeStrategy: 'replace',
    })
  } else if (/(英文|english)/i.test(normalized)) {
    facts.push({
      key: 'preference.response_language',
      category: 'preference',
      content: 'User prefers English responses.',
      mergeStrategy: 'replace',
    })
  }

  if (mentionsExecutionPreference(lower)) {
    facts.push({
      key: 'preference.execution_path',
      category: 'preference',
      content: 'Prefer backend-first execution using CLI/API before GUI automation.',
      mergeStrategy: 'replace',
    })
  }

  const constraintFact = extractConstraintFact(normalized)
  if (constraintFact) {
    facts.push(constraintFact)
  }

  return dedupeFacts(facts)
}

function extractPathFacts(content: string): MemoryFact[] {
  const matches = content.match(WINDOWS_PATH_PATTERN) ?? []
  const normalizedPaths = [...new Set(matches.map(normalizeWindowsPath))].slice(-5)
  if (normalizedPaths.length === 0) {
    return []
  }

  return [
    {
      key: 'project.recent_paths',
      category: 'project',
      content: normalizedPaths.join('\n'),
      mergeStrategy: 'replace',
    },
    {
      key: 'project.structure',
      category: 'project',
      content: shortenFactContent(
        `Recent project paths: ${normalizedPaths.join(', ')}`,
      ),
      mergeStrategy: 'replace',
    },
  ]
}

function extractToolFacts(message: QueryMessage): MemoryFact[] {
  const payload = parseToolPayload(message.content)
  if (!payload) {
    return []
  }

  const facts: MemoryFact[] = []
  if (typeof payload.pointer === 'string' && payload.pointer.trim() !== '') {
    facts.push(...extractPathFacts(payload.pointer))
  }

  for (const text of collectStringValues(payload.data)) {
    facts.push(...extractPathFacts(text))
  }

  return facts
}

function mentionsExecutionPreference(normalized: string): boolean {
  const hasPriorityWord = /(优先|先走|尽量|不要gui|不优先gui)/i.test(normalized)
  const hasBackendWord = /(cli|api|backend|后端)/i.test(normalized)
  const hasGuiWord = /(gui|截图|点击|桌面自动化|屏幕)/i.test(normalized)

  return (hasPriorityWord && hasBackendWord) || (hasPriorityWord && hasGuiWord)
}

function extractConstraintFact(normalized: string): MemoryFact | undefined {
  if (/(严格遵守|必须遵守|必须|只能|不要|禁止)/i.test(normalized)) {
    return {
      key: 'constraint.active',
      category: 'constraint',
      content: shortenFactContent(normalized),
      mergeStrategy: 'replace',
    }
  }

  return undefined
}

function dedupeFacts(facts: MemoryFact[]): MemoryFact[] {
  const byKey = new Map<string, MemoryFact>()
  const withoutKey: MemoryFact[] = []

  for (const fact of facts) {
    if (fact.key) {
      byKey.set(fact.key, fact)
      continue
    }

    withoutKey.push(fact)
  }

  return [...byKey.values(), ...withoutKey]
}

function parseToolPayload(content: string): {
  toolName?: string
  ok?: boolean
  summary?: string
  error?: string
  failureClass?: string
  pointer?: string
  data?: unknown
} | null {
  try {
    const parsed = JSON.parse(content) as {
      toolName?: unknown
      ok?: unknown
      summary?: unknown
      error?: unknown
      failureClass?: unknown
      pointer?: unknown
      data?: unknown
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
      data: parsed.data,
    }
  } catch {
    return null
  }
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 2) {
    return []
  }

  if (typeof value === 'string') {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectStringValues(item, depth + 1)).slice(0, 10)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value)
      .flatMap(item => collectStringValues(item, depth + 1))
      .slice(0, 10)
  }

  return []
}

function normalizeText(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

function shortenFactContent(content: string): string {
  return normalizeText(content).slice(0, 200)
}

function normalizeWindowsPath(path: string): string {
  const normalized = path.replace(/\\\\/g, '\\')
  if (/^[a-zA-Z]:\\$/.test(normalized)) {
    return normalized
  }

  return normalized.replace(/\\+$/g, '')
}
