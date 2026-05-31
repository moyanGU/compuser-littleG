import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryFact } from '../context/ContextAssembler.js'

export interface MemoryStore {
  listFacts(): Promise<MemoryFact[]>
  appendFact(fact: MemoryFact): Promise<void>
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly facts: MemoryFact[] = []

  async listFacts(): Promise<MemoryFact[]> {
    return [...this.facts]
  }

  async appendFact(fact: MemoryFact): Promise<void> {
    upsertMemoryFact(this.facts, fact)
  }
}

export class FileMemoryStore implements MemoryStore {
  constructor(private readonly filePath: string) {}

  async listFacts(): Promise<MemoryFact[]> {
    return readFactsFromFile(this.filePath)
  }

  async appendFact(fact: MemoryFact): Promise<void> {
    const facts = await readFactsFromFile(this.filePath)
    upsertMemoryFact(facts, fact)
    await mkdir(dirname(this.filePath), { recursive: true })
    const nextContent = JSON.stringify(
      {
        facts,
      },
      null,
      2,
    )
    const tempPath = `${this.filePath}.tmp`
    await writeFile(
      tempPath,
      nextContent,
      'utf8',
    )
    await rename(tempPath, this.filePath)
  }
}

function upsertMemoryFact(target: MemoryFact[], fact: MemoryFact): void {
  if (fact.key) {
    const index = target.findIndex(existing => existing.key === fact.key)
    if (index >= 0) {
      if (fact.mergeStrategy === 'append') {
        const previous = target[index]
        target[index] = {
          ...fact,
          content: mergeFactContent(previous.content, fact.content),
        }
        return
      }

      target[index] = {
        ...fact,
        mergeStrategy: fact.mergeStrategy ?? 'replace',
      }
      return
    }
  }

  target.push({
    ...fact,
    mergeStrategy: fact.mergeStrategy ?? 'replace',
  })
}

async function readFactsFromFile(filePath: string): Promise<MemoryFact[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    if (!raw.trim()) {
      return []
    }
    const parsed = JSON.parse(raw) as {
      facts?: MemoryFact[]
    }

    if (!Array.isArray(parsed.facts)) {
      return []
    }

    return parsed.facts.filter(isMemoryFact)
  } catch (error) {
    if (isMissingFileError(error) || isJsonSyntaxError(error)) {
      return []
    }

    throw error
  }
}

function isMemoryFact(value: unknown): value is MemoryFact {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { category?: unknown }).category === 'string' &&
    typeof (value as { content?: unknown }).content === 'string' &&
    (
      (value as { key?: unknown }).key === undefined ||
      typeof (value as { key?: unknown }).key === 'string'
    ) &&
    (
      (value as { mergeStrategy?: unknown }).mergeStrategy === undefined ||
      (value as { mergeStrategy?: unknown }).mergeStrategy === 'replace' ||
      (value as { mergeStrategy?: unknown }).mergeStrategy === 'append'
    )
  )
}

function mergeFactContent(previous: string, next: string): string {
  const merged = [previous.trim(), next.trim()].filter(Boolean).join('\n')
  return merged.slice(-1_500)
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isJsonSyntaxError(error: unknown): error is SyntaxError {
  return error instanceof SyntaxError
}
