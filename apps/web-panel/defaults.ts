import { resolve } from 'node:path'
import { CLI_WORKSPACE_ROOT } from '../cli/workspaceRoot.js'

export const PANEL_DEFAULT_SESSION_ID = 'local-web-panel-session'
export const PANEL_DEFAULT_PORT = 4317
export const PRODUCT_SCORECARD_RELATIVE_PATH = 'artifacts/scorecard/phase5-latest.json'
export const PANEL_PUBLIC_DIR = resolve(CLI_WORKSPACE_ROOT, 'apps', 'web-panel', 'public')
export const PANEL_UPLOADS_DIR = resolve(CLI_WORKSPACE_ROOT, 'memory', 'web-panel-uploads')
export const PRODUCT_SCORECARD_SUMMARY_PATH =
  readConfiguredAbsolutePath(process.env.COMPUSER_PRODUCT_SCORECARD_PATH) ??
  resolve(CLI_WORKSPACE_ROOT, PRODUCT_SCORECARD_RELATIVE_PATH)

function readConfiguredAbsolutePath(value: string | undefined): string | undefined {
  if (!value || !value.trim()) {
    return undefined
  }

  return resolve(value.trim())
}
