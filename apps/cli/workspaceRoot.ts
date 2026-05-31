import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function resolveCliWorkspaceRoot(): string {
  const configuredRoot = readConfiguredWorkspaceRoot()
  if (configuredRoot) {
    return configuredRoot
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return isBuiltCliDirectory(moduleDirectory)
    ? resolve(moduleDirectory, '..', '..', '..')
    : resolve(moduleDirectory, '..', '..')
}

function isBuiltCliDirectory(moduleDirectory: string): boolean {
  return normalizeWorkspacePath(moduleDirectory).endsWith('/dist/apps/cli')
}

export function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

export const CLI_WORKSPACE_ROOT = resolveCliWorkspaceRoot()
const NORMALIZED_CLI_WORKSPACE_ROOT = normalizeWorkspacePath(CLI_WORKSPACE_ROOT)

export function getDefaultMemoryFilePath(sessionId: string): string {
  return resolve(CLI_WORKSPACE_ROOT, 'memory', `${sessionId}.json`)
}

export function getDefaultWindowsMcpServiceConfigPath(): string {
  return (
    readConfiguredAbsolutePath(process.env.COMPUSER_WINDOWS_MCP_SERVICE_CONFIG_PATH) ??
    resolve(CLI_WORKSPACE_ROOT, 'memory', 'windows-mcp-service.json')
  )
}

export function isWithinCliWorkspace(candidatePath: string): boolean {
  const normalizedCandidate = normalizeWorkspacePath(candidatePath)
  return (
    normalizedCandidate === NORMALIZED_CLI_WORKSPACE_ROOT ||
    normalizedCandidate.startsWith(`${NORMALIZED_CLI_WORKSPACE_ROOT}/`)
  )
}

function readConfiguredWorkspaceRoot(): string | undefined {
  return readConfiguredAbsolutePath(process.env.COMPUSER_WORKSPACE_ROOT)
}

function readConfiguredAbsolutePath(value: string | undefined): string | undefined {
  if (!value || !value.trim()) {
    return undefined
  }

  return resolve(value.trim())
}
