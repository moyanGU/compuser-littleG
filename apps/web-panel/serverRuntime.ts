import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  getDefaultWindowsMcpServiceConfigPath,
  CLI_WORKSPACE_ROOT,
} from '../cli/workspaceRoot.js'
import { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { createEmptyPanelState } from './panelState.js'
import { buildRecommendedTemplateViews } from './templateRecommendations.js'
import { createSessionOrchestrator } from './sessionOrchestration.js'
import { createTemplateLaunchFlow } from './templateLaunchFlow.js'
import { createSystemProductFlow } from './systemProductFlow.js'
import { createSessionControlFlow } from './sessionControlFlow.js'
import { createTaskDecisionFlow } from './taskDecisionFlow.js'
import type { SessionRecord } from './sessionStore.js'
import type { WebPanelServerOptions } from './serverOptions.js'
import type {
  ProductGovernanceView,
  ScorecardSummaryView,
  WindowsMcpStatusView,
} from './panelTypes.js'

export interface WebPanelRuntimeDependencies {
  readWindowsMcpStatus: (
    windowsMcpService: WindowsMcpService,
  ) => Promise<WindowsMcpStatusView>
  readScorecardSummary: () => Promise<ScorecardSummaryView | undefined>
  buildGovernanceView: () => ProductGovernanceView
  mapRestartStatus: (
    status: Awaited<ReturnType<WindowsMcpService['restart']>>,
  ) => WindowsMcpStatusView
  panelDefaultSessionId: string
  uploadsDir: string
  sessions?: Map<string, SessionRecord>
}

export interface WebPanelRuntime {
  sessions: Map<string, SessionRecord>
  windowsMcpService: WindowsMcpService
  sessionOrchestrator: ReturnType<typeof createSessionOrchestrator>
  taskDecisionFlow: ReturnType<typeof createTaskDecisionFlow>
  templateLaunchFlow: ReturnType<typeof createTemplateLaunchFlow>
  systemProductFlow: ReturnType<typeof createSystemProductFlow>
  sessionControlFlow: ReturnType<typeof createSessionControlFlow>
}

export async function createWebPanelRuntime(
  options: WebPanelServerOptions,
  deps: WebPanelRuntimeDependencies,
): Promise<WebPanelRuntime> {
  const sessions = deps.sessions ?? new Map<string, SessionRecord>()
  const windowsMcpService = new WindowsMcpService({
    configPath: getDefaultWindowsMcpServiceConfigPath(),
    endpointUrl: options.windowsMcpEndpoint,
  })
  const sessionOrchestrator = createSessionOrchestrator({
    sessions,
    windowsMcpService,
    permissionMode: options.permissionMode,
    readWindowsMcpStatus: deps.readWindowsMcpStatus,
    readScorecardSummary: deps.readScorecardSummary,
    buildGovernanceView: deps.buildGovernanceView,
  })
  const templateLaunchFlow = createTemplateLaunchFlow({
    sessions,
    windowsMcpService,
    permissionMode: options.permissionMode,
    readWindowsMcpStatus: deps.readWindowsMcpStatus,
    readScorecardSummary: deps.readScorecardSummary,
    buildGovernanceView: deps.buildGovernanceView,
    startTask(sessionId, task, launchedTemplateId) {
      return sessionOrchestrator.startTask(
        sessionId,
        task,
        {
          windowsMcpEndpoint: options.windowsMcpEndpoint,
          permissionMode: options.permissionMode,
          modelProvider: options.defaultModelProvider,
          modelBaseUrl: options.modelBaseUrl,
          modelApiKey: options.modelApiKey,
          modelName: options.modelName,
          modelTemperature: options.modelTemperature,
          modelMaxTokens: options.modelMaxTokens,
          modelTimeoutMs: options.modelTimeoutMs,
          modelStream: options.modelStream,
          modelMaxRetries: options.modelMaxRetries,
          modelRetryDelayMs: options.modelRetryDelayMs,
          modelCompatibilityMode: options.modelCompatibilityMode,
        },
        launchedTemplateId,
      )
    },
  })
  const taskDecisionFlow = createTaskDecisionFlow({
    sessions,
    windowsMcpService,
    permissionMode: options.permissionMode,
    readWindowsMcpStatus: deps.readWindowsMcpStatus,
    readScorecardSummary: deps.readScorecardSummary,
    buildGovernanceView: deps.buildGovernanceView,
    startTask(sessionId, task, launchedTemplateId) {
      return sessionOrchestrator.startTask(
        sessionId,
        task,
        {
          windowsMcpEndpoint: options.windowsMcpEndpoint,
          permissionMode: options.permissionMode,
          modelProvider: options.defaultModelProvider,
          modelBaseUrl: options.modelBaseUrl,
          modelApiKey: options.modelApiKey,
          modelName: options.modelName,
          modelTemperature: options.modelTemperature,
          modelMaxTokens: options.modelMaxTokens,
          modelTimeoutMs: options.modelTimeoutMs,
          modelStream: options.modelStream,
          modelMaxRetries: options.modelMaxRetries,
          modelRetryDelayMs: options.modelRetryDelayMs,
          modelCompatibilityMode: options.modelCompatibilityMode,
        },
        launchedTemplateId,
      )
    },
  })
  const systemProductFlow = createSystemProductFlow({
    sessions,
    windowsMcpService,
    permissionMode: options.permissionMode,
    readWindowsMcpStatus: deps.readWindowsMcpStatus,
    readScorecardSummary: deps.readScorecardSummary,
    buildGovernanceView: deps.buildGovernanceView,
    mapRestartStatus: deps.mapRestartStatus,
  })
  const sessionControlFlow = createSessionControlFlow({
    sessions,
  })

  await mkdir(resolve(CLI_WORKSPACE_ROOT, 'memory'), { recursive: true })
  await mkdir(deps.uploadsDir, { recursive: true })

  const initialStatus = await deps.readWindowsMcpStatus(windowsMcpService)
  const initialState = createEmptyPanelState(initialStatus)
  const scorecardSummary = await deps.readScorecardSummary()
  sessions.set(deps.panelDefaultSessionId, {
    sessionId: deps.panelDefaultSessionId,
    state: {
      ...initialState,
      sessionId: deps.panelDefaultSessionId,
      recommendedTemplates: buildRecommendedTemplateViews(
        initialStatus,
        options.permissionMode,
        scorecardSummary,
      ),
      scorecardSummary,
      governance: deps.buildGovernanceView(),
    },
    timeline: initialState.timeline,
  })

  return {
    sessions,
    windowsMcpService,
    sessionOrchestrator,
    taskDecisionFlow,
    templateLaunchFlow,
    systemProductFlow,
    sessionControlFlow,
  }
}
