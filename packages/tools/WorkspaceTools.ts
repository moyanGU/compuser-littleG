import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { AnyToolDefinition, ToolDefinition, ToolResult } from './Tool.js'

export function createWorkspaceTools(options: {
  workspaceRoot: string
}): AnyToolDefinition[] {
  const workspaceRoot = resolve(options.workspaceRoot)

  const globTool: ToolDefinition<{
    pattern: string
    path?: string
    limit?: number
  }> = {
    name: 'workspace.glob',
    availability: 'core',
    description: 'List workspace paths that match a glob pattern.',
    searchHints: ['workspace', 'glob', 'list', 'files', 'tree'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    maxResultChars: 4_000,
    resultPolicy: {
      inlineMaxChars: 4_000,
      storeRaw: true,
      readBackTool: 'artifacts.read_result',
    },
    inputSchema: {
      description: 'workspace glob input',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['pattern'],
    },
    async execute(input) {
      const pattern = input.pattern?.trim()
      if (!pattern) {
        return schemaError('workspace.glob', 'pattern is required.')
      }

      const limit = clampNumber(input.limit, 200, 1, 2_000)
      const baseDir = resolveWorkspacePath(
        workspaceRoot,
        input.path?.trim() || '.',
      )
      const normalizedPattern = normalizeGlobPattern(pattern)
      const matcher = globToRegex(normalizedPattern)

      const matches: string[] = []
      for await (const relativePath of walkWorkspace(baseDir, workspaceRoot)) {
        if (matches.length >= limit) {
          break
        }
        if (matcher.test(relativePath)) {
          matches.push(relativePath)
        }
      }

      return {
        ok: true,
        summary: `Matched ${matches.length} workspace paths.`,
        data: {
          root: baseDir,
          pattern: normalizedPattern,
          matches,
        },
      }
    },
  }

  const readTextTool: ToolDefinition<{
    path: string
    offset?: number
    limit?: number
  }> = {
    name: 'workspace.read_text',
    availability: 'core',
    description: 'Read lines from a text file inside the workspace.',
    searchHints: ['workspace', 'read', 'file', 'text', 'lines'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    maxResultChars: 6_000,
    resultPolicy: {
      inlineMaxChars: 6_000,
      storeRaw: true,
      readBackTool: 'artifacts.read_result',
    },
    inputSchema: {
      description: 'workspace read text input',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['path'],
    },
    async execute(input) {
      const filePath = input.path?.trim()
      if (!filePath) {
        return schemaError('workspace.read_text', 'path is required.')
      }

      const resolvedPath = resolveWorkspacePath(workspaceRoot, filePath)
      const offset = clampNumber(input.offset, 1, 1, 100_000)
      const limit = clampNumber(input.limit, 80, 1, 2_000)

      try {
        const raw = await readFile(resolvedPath, 'utf8')
        const lines = raw.split(/\r?\n/)
        const startIndex = Math.max(0, Math.min(lines.length, offset - 1))
        const endIndex = Math.min(lines.length, startIndex + limit)
        const chunk = lines.slice(startIndex, endIndex)

        return {
          ok: true,
          summary: `Read ${chunk.length} lines from ${resolvedPath}.`,
          data: {
            path: resolvedPath,
            startLine: offset,
            endLine: offset + chunk.length - 1,
            lines: chunk,
            totalLines: lines.length,
            truncated: endIndex < lines.length,
          },
        }
      } catch (error) {
        return fileIoFailureResult('workspace.read_text', resolvedPath, error)
      }
    },
  }

  const grepTool: ToolDefinition<{
    query: string
    path?: string
    includePattern?: string
    limit?: number
    caseSensitive?: boolean
  }> = {
    name: 'workspace.grep',
    availability: 'core',
    description: 'Search text inside workspace files.',
    searchHints: ['workspace', 'grep', 'search', 'text', 'query'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    maxResultChars: 6_000,
    resultPolicy: {
      inlineMaxChars: 6_000,
      storeRaw: true,
      readBackTool: 'artifacts.read_result',
    },
    inputSchema: {
      description: 'workspace grep input',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        includePattern: { type: 'string' },
        limit: { type: 'number' },
        caseSensitive: { type: 'boolean' },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = input.query?.toString() ?? ''
      if (!query.trim()) {
        return schemaError('workspace.grep', 'query is required.')
      }

      const limit = clampNumber(input.limit, 40, 1, 500)
      const includePattern = normalizeGlobPattern(input.includePattern ?? '**/*')
      const matcher = globToRegex(includePattern)
      const baseDir = resolveWorkspacePath(
        workspaceRoot,
        input.path?.trim() || '.',
      )

      const needle = input.caseSensitive ? query : query.toLowerCase()
      const matches: Array<{
        path: string
        lineNumber: number
        line: string
      }> = []

      for await (const relativePath of walkWorkspace(baseDir, workspaceRoot)) {
        if (matches.length >= limit) {
          break
        }
        if (!matcher.test(relativePath)) {
          continue
        }

        const absolutePath = resolve(workspaceRoot, relativePath)
        let raw: string
        try {
          raw = await readFile(absolutePath, 'utf8')
        } catch {
          continue
        }

        const lines = raw.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          if (matches.length >= limit) {
            break
          }
          const haystack = input.caseSensitive
            ? lines[index]
            : lines[index].toLowerCase()
          if (haystack.includes(needle)) {
            matches.push({
              path: absolutePath,
              lineNumber: index + 1,
              line: lines[index].slice(0, 240),
            })
          }
        }
      }

      return {
        ok: true,
        summary: `Found ${matches.length} text matches in the workspace.`,
        data: {
          root: baseDir,
          query,
          includePattern,
          matches,
        },
      }
    },
  }

  const writeTextTool: ToolDefinition<{
    path: string
    content: string
    overwrite?: boolean
    createDirs?: boolean
  }> = {
    name: 'workspace.write_text',
    availability: 'discoverable',
    description: 'Write a text file inside the workspace.',
    searchHints: ['workspace', 'write', 'create', 'save', 'file'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    permissionProfile: {
      grantScopes: ['once', 'tool', 'risk'],
      classifier: 'review-required',
    },
    inputSchema: {
      description: 'workspace write text input',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
        createDirs: { type: 'boolean' },
      },
      required: ['path', 'content'],
    },
    async execute(input) {
      const filePath = input.path?.trim()
      if (!filePath) {
        return schemaError('workspace.write_text', 'path is required.')
      }

      const resolvedPath = resolveWorkspacePath(workspaceRoot, filePath)
      const overwrite = input.overwrite !== false
      const createDirs = input.createDirs !== false

      try {
        if (!overwrite) {
          await stat(resolvedPath)
          return {
            ok: false,
            summary: `Target file already exists and overwrite=false: ${resolvedPath}`,
            error: 'WORKSPACE_FILE_EXISTS',
            failureClass: 'deterministic',
          }
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          return fileIoFailureResult('workspace.write_text', resolvedPath, error)
        }
      }

      try {
        if (createDirs) {
          await mkdir(dirname(resolvedPath), { recursive: true })
        }
        await writeFile(resolvedPath, input.content ?? '', 'utf8')
        return {
          ok: true,
          summary: `Wrote text file ${resolvedPath}.`,
          data: {
            path: resolvedPath,
            bytes: Buffer.byteLength(input.content ?? '', 'utf8'),
          },
        }
      } catch (error) {
        return fileIoFailureResult('workspace.write_text', resolvedPath, error)
      }
    },
  }

  const replaceTextTool: ToolDefinition<{
    path: string
    search: string
    replace: string
    all?: boolean
  }> = {
    name: 'workspace.replace_text',
    availability: 'discoverable',
    description: 'Replace text inside a workspace file.',
    searchHints: ['workspace', 'replace', 'edit', 'search', 'text'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    permissionProfile: {
      grantScopes: ['once', 'tool', 'risk'],
      classifier: 'review-required',
    },
    inputSchema: {
      description: 'workspace replace text input',
      properties: {
        path: { type: 'string' },
        search: { type: 'string' },
        replace: { type: 'string' },
        all: { type: 'boolean' },
      },
      required: ['path', 'search', 'replace'],
    },
    async execute(input) {
      const filePath = input.path?.trim()
      const search = input.search ?? ''
      const replace = input.replace ?? ''
      if (!filePath) {
        return schemaError('workspace.replace_text', 'path is required.')
      }
      if (!search) {
        return schemaError('workspace.replace_text', 'search must not be empty.')
      }

      const resolvedPath = resolveWorkspacePath(workspaceRoot, filePath)
      const replaceAll = input.all !== false

      try {
        const raw = await readFile(resolvedPath, 'utf8')
        const { updated, count } = replaceText(raw, search, replace, replaceAll)
        if (count === 0) {
          return {
            ok: false,
            summary: `Text to replace was not found: ${search}`,
            error: 'WORKSPACE_TEXT_NOT_FOUND',
            failureClass: 'deterministic',
          }
        }
        await writeFile(resolvedPath, updated, 'utf8')
        return {
          ok: true,
          summary: `Replaced text in ${resolvedPath}; count=${count}.`,
          data: {
            path: resolvedPath,
            count,
          },
        }
      } catch (error) {
        return fileIoFailureResult('workspace.replace_text', resolvedPath, error)
      }
    },
  }

  return [globTool, readTextTool, grepTool, writeTextTool, replaceTextTool]
}

function resolveWorkspacePath(workspaceRoot: string, targetPath: string): string {
  const trimmed = targetPath.trim()
  const resolved = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(workspaceRoot, trimmed)

  const normalizedRoot = ensureTrailingSeparator(workspaceRoot.toLowerCase())
  const normalizedTarget = resolved.toLowerCase()
  if (
    normalizedTarget !== workspaceRoot.toLowerCase() &&
    !normalizedTarget.startsWith(normalizedRoot)
  ) {
    throw new Error(`Path is outside workspace root: ${resolved}`)
  }
  return resolved
}

async function* walkWorkspace(
  baseDir: string,
  workspaceRoot: string,
): AsyncGenerator<string> {
  const stack: string[] = [baseDir]
  const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'artifacts'])

  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Array<{ name: string; fullPath: string; isDir: boolean }>
    try {
      const dirents = await readdir(current, { withFileTypes: true })
      entries = dirents.map(dirent => ({
        name: dirent.name,
        fullPath: resolve(current, dirent.name),
        isDir: dirent.isDirectory(),
      }))
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDir) {
        if (ignoredDirs.has(entry.name.toLowerCase())) {
          continue
        }
        stack.push(entry.fullPath)
        continue
      }

      const relative = resolve(entry.fullPath)
        .slice(ensureTrailingSeparator(workspaceRoot).length)
        .replace(/\\/g, '/')
      yield relative
    }
  }
}

function normalizeGlobPattern(pattern: string): string {
  const trimmed = pattern.trim()
  if (!trimmed) {
    return '**/*'
  }

  return trimmed.replace(/\\/g, '/')
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let escaped = ''

  for (let index = 0; index < normalized.length; index += 1) {
    const ch = normalized[index]
    const next = normalized[index + 1]

    if (ch === '*' && next === '*') {
      const after = normalized[index + 2]
      if (after === '/') {
        escaped += '(?:.*/)?'
        index += 2
        continue
      }
      escaped += '.*'
      index += 1
      continue
    }

    if (ch === '*') {
      escaped += '[^/]*'
      continue
    }

    if (ch === '?') {
      escaped += '[^/]'
      continue
    }

    if ('\\.[]{}()+-^$|'.includes(ch)) {
      escaped += `\\${ch}`
      continue
    }

    escaped += ch
  }

  return new RegExp(`^${escaped}$`, 'i')
}

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(min, Math.min(max, Math.floor(value)))
}

function replaceText(
  raw: string,
  search: string,
  replacement: string,
  replaceAll: boolean,
): { updated: string; count: number } {
  if (!replaceAll) {
    const index = raw.indexOf(search)
    if (index < 0) {
      return { updated: raw, count: 0 }
    }
    return {
      updated: raw.slice(0, index) + replacement + raw.slice(index + search.length),
      count: 1,
    }
  }

  let updated = raw
  let count = 0
  let index = updated.indexOf(search)
  while (index >= 0) {
    updated =
      updated.slice(0, index) + replacement + updated.slice(index + search.length)
    count += 1
    index = updated.indexOf(search, index + replacement.length)
    if (count > 10_000) {
      break
    }
  }

  return { updated, count }
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith('\\') || value.endsWith('/') ? value : `${value}\\`
}

function schemaError(toolName: string, message: string): ToolResult {
  return {
    ok: false,
    summary: `${toolName} schema validation failed.`,
    error: `TOOL_SCHEMA_ERROR: ${message}`,
    failureClass: 'deterministic',
  }
}

function fileIoFailureResult(
  toolName: string,
  target: string,
  error: unknown,
): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  const failureClass = isMissingFileError(error) ? 'missing_dependency' : 'deterministic'
  return {
    ok: false,
    summary: `${toolName} failed for ${target}.`,
    error: message,
    failureClass,
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
