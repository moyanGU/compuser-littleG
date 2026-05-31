import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { OpenAICompatibleRequestError } from '../../packages/core/ModelClient.js'
import type { PermissionMode } from '../../packages/security/PermissionPolicy.js'
import { FileMemoryStore } from '../../packages/harness/memory/MemoryStore.js'
import { getDefaultMemoryFilePath } from '../cli/workspaceRoot.js'
import {
  createCliApp,
  createCliModelOptions,
  type CliModelProvider,
} from '../cli/cliApp.js'
import {
  buildExecutingPanelState,
  buildPanelStateFromRun,
  createEmptyPanelState,
} from './panelState.js'
import type {
  ProductGovernanceView,
  ScorecardSummaryView,
  WindowsMcpStatusView,
} from './panelTypes.js'
import { createPanelPermissionPrompt } from './permissionPrompt.js'
import type { SessionRecord } from './sessionStore.js'
import { buildRecommendedTemplateViews } from './templateRecommendations.js'

export interface SessionTaskStartOptions {
  windowsMcpEndpoint?: string
  permissionMode: PermissionMode
  modelProvider: CliModelProvider
  modelBaseUrl?: string
  modelApiKey?: string
  modelName?: string
  modelTemperature?: number
  modelMaxTokens?: number
  modelTimeoutMs?: number
  modelStream?: boolean
  modelMaxRetries?: number
  modelRetryDelayMs?: number
  modelCompatibilityMode?: 'strict' | 'openai' | 'ollama' | 'generic'
}

export interface SessionOrchestratorDependencies {
  sessions: Map<string, SessionRecord>
  windowsMcpService: WindowsMcpService
  permissionMode: PermissionMode
  readWindowsMcpStatus: (
    windowsMcpService: WindowsMcpService,
  ) => Promise<WindowsMcpStatusView>
  readScorecardSummary: () => Promise<ScorecardSummaryView | undefined>
  buildGovernanceView: () => ProductGovernanceView
}

export function createSessionOrchestrator(
  deps: SessionOrchestratorDependencies,
) {
  async function startTask(
    sessionId: string,
    task: string,
    options: SessionTaskStartOptions,
    launchedTemplateId?: string,
  ): Promise<SessionRecord> {
    const previous = deps.sessions.get(sessionId)
    const windowsMcpStatus = await deps.readWindowsMcpStatus(
      deps.windowsMcpService,
    )
    const scorecardSummary = await deps.readScorecardSummary()
    const governance = deps.buildGovernanceView()
    const recommendedTemplates = buildRecommendedTemplateViews(
      windowsMcpStatus,
      options.permissionMode,
      scorecardSummary,
    )
    const placeholder = previous ?? {
      sessionId,
      state: {
        ...createEmptyPanelState(windowsMcpStatus),
        sessionId,
        recommendedTemplates,
        scorecardSummary,
        governance,
      },
      timeline: [],
    }

    if (placeholder.currentRun) {
      throw new Error('A task is already running in this session.')
    }

    const abortController = new AbortController()
    placeholder.abortController = abortController
    placeholder.task = task
    placeholder.pendingDecision = undefined
    placeholder.state = buildExecutingPanelState({
      baseState: {
        ...placeholder.state,
        sessionId,
        submittedTask: task,
        launchedTemplateId,
        currentStage: 'observing',
        stageLabel: '正在准备执行',
        finalText: undefined,
        stopReason: undefined,
        pendingPermission: undefined,
        recommendedTemplates,
        scorecardSummary,
        governance,
        windowsMcpStatus,
      },
      submittedTask: task,
      launchedTemplateId,
      stageLabel: '正在准备执行',
    })
    placeholder.timeline = [
      {
        title: '任务已启动',
        detail: launchedTemplateId ? `${launchedTemplateId}: ${task}` : task,
        status: 'info',
      },
    ]
    placeholder.state.timeline = placeholder.timeline
    if (placeholder.state.debug) {
      placeholder.state.debug.timeline = placeholder.timeline
    }
    deps.sessions.set(sessionId, placeholder)

    placeholder.currentRun = runTask(
      sessionId,
      task,
      options,
      abortController,
      launchedTemplateId,
    )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        const record = deps.sessions.get(sessionId)
        if (!record) {
          return
        }

        record.currentRun = undefined
        record.abortController = undefined
        record.state = {
          ...record.state,
          isRunning: false,
          emergencyStopAvailable: false,
          updatedAt: new Date().toISOString(),
        }
      })

    return placeholder
  }

  async function runTask(
    sessionId: string,
    task: string,
    options: SessionTaskStartOptions,
    abortController: AbortController,
    launchedTemplateId?: string,
  ) {
    const previous = deps.sessions.get(sessionId)
    const windowsMcpStatus = await deps.readWindowsMcpStatus(
      deps.windowsMcpService,
    )
    const scorecardSummary = await deps.readScorecardSummary()
    const governance = deps.buildGovernanceView()
    const recommendedTemplates = buildRecommendedTemplateViews(
      windowsMcpStatus,
      options.permissionMode,
      scorecardSummary,
    )
    const placeholder = previous ?? {
      sessionId,
      state: {
        ...createEmptyPanelState(windowsMcpStatus),
        sessionId,
        recommendedTemplates,
        scorecardSummary,
        governance,
      },
      timeline: [],
    }

    placeholder.task = task
    placeholder.state = buildExecutingPanelState({
      baseState: {
        ...placeholder.state,
        sessionId,
        submittedTask: task,
        launchedTemplateId,
        currentStage: 'observing',
        stageLabel: '正在执行',
        finalText: undefined,
        stopReason: undefined,
        pendingPermission: undefined,
        recommendedTemplates,
        scorecardSummary,
        governance,
        windowsMcpStatus,
      },
      submittedTask: task,
      launchedTemplateId,
      stageLabel: '正在执行',
    })
    placeholder.timeline = [
      {
        title: '任务已提交',
        detail: launchedTemplateId ? `${launchedTemplateId}: ${task}` : task,
        status: 'info',
      },
    ]
    placeholder.state.timeline = placeholder.timeline
    if (placeholder.state.debug) {
      placeholder.state.debug.timeline = placeholder.timeline
    }
    deps.sessions.set(sessionId, placeholder)

    const permissionPrompt = createPanelPermissionPrompt({
      sessionId,
      getSession: currentSessionId => deps.sessions.get(currentSessionId),
    })

    try {
      const app = createCliApp({
        sessionId,
        windowsMcpEndpoint: options.windowsMcpEndpoint,
        windowsMcpService: deps.windowsMcpService,
        permissionMode: options.permissionMode,
        permissionPrompt,
        memoryFilePath: getDefaultMemoryFilePath(sessionId),
        model: createCliModelOptions({
          provider: options.modelProvider,
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
        }),
        maxContextMessages: 12,
        executionSignal: abortController.signal,
      })
      const result = await app.submitUserMessage(task)
      const memoryStore = new FileMemoryStore(getDefaultMemoryFilePath(sessionId))
      const memoryFacts = await memoryStore.listFacts()
      const refreshedWindowsMcpStatus = await deps.readWindowsMcpStatus(
        deps.windowsMcpService,
      )
      const refreshedRecommendedTemplates = buildRecommendedTemplateViews(
        refreshedWindowsMcpStatus,
        options.permissionMode,
        scorecardSummary,
      )
      const state = buildPanelStateFromRun({
        task,
        result,
        memoryFacts,
        windowsMcpStatus: refreshedWindowsMcpStatus,
        options: {
          ...options,
          recommendedTemplates: refreshedRecommendedTemplates,
          scorecardSummary,
          governance,
        },
      })
      const mergedState = {
        ...state,
        sessionId,
        launchedTemplateId,
        view: 'result' as const,
        isRunning: false,
        emergencyStopAvailable: false,
        timeline: [...placeholder.timeline, ...state.timeline].slice(-40),
      }
      if (mergedState.debug) {
        mergedState.debug.timeline = mergedState.timeline
      }
      deps.sessions.set(sessionId, {
        sessionId,
        task,
        state: mergedState,
        timeline: mergedState.timeline,
      })

      return {
        sessionId,
        state: mergedState,
      }
    } catch (error) {
      const refreshedWindowsMcpStatus = await deps.readWindowsMcpStatus(
        deps.windowsMcpService,
      )
      const failureSummary = formatPanelTaskFailure(error)
      const timeline = [
        ...placeholder.timeline,
        {
          title: '任务失败',
          detail: failureSummary,
          status: 'danger' as const,
        },
      ].slice(-40)
      const failureState = {
        ...placeholder.state,
        sessionId,
        launchedTemplateId,
        view: 'result' as const,
        currentStage: 'execution_failed',
        stageLabel: '执行中途卡住了',
        isRunning: false,
        emergencyStopAvailable: false,
        finalText: failureSummary,
        stopReason: classifyPanelTaskFailure(error),
        result: {
          kind: 'failure' as const,
          title: '任务没有完成',
          summary: failureSummary,
          nextActionText: '先看失败原因，再决定是补环境还是调整任务。',
        },
        pendingPermission: undefined,
        windowsMcpStatus: refreshedWindowsMcpStatus,
        timeline,
        updatedAt: new Date().toISOString(),
      }
      if (failureState.debug) {
        failureState.debug.timeline = timeline
      }
      deps.sessions.set(sessionId, {
        ...placeholder,
        sessionId,
        task,
        state: failureState,
        timeline,
      })
      throw error
    }
  }

  async function refreshSessionState(sessionId: string): Promise<SessionRecord> {
    const existing = deps.sessions.get(sessionId)
    const windowsMcpStatus = await deps.readWindowsMcpStatus(
      deps.windowsMcpService,
    )
    const scorecardSummary = await deps.readScorecardSummary()
    const governance = deps.buildGovernanceView()
    const recommendedTemplates = buildRecommendedTemplateViews(
      windowsMcpStatus,
      deps.permissionMode,
      scorecardSummary,
    )

    if (!existing) {
      const created = {
        sessionId,
        state: {
          ...createEmptyPanelState(windowsMcpStatus),
          sessionId,
          recommendedTemplates,
          scorecardSummary,
          governance,
        },
        timeline: [],
      }
      deps.sessions.set(sessionId, created)
      return created
    }

    existing.state = {
      ...existing.state,
      recommendedTemplates,
      scorecardSummary,
      governance,
      windowsMcpStatus,
      updatedAt: new Date().toISOString(),
    }
    if (existing.state.debug) {
      existing.state.debug.scorecardSummary = scorecardSummary
      existing.state.debug.governance = governance
    }
    return existing
  }

  return {
    startTask,
    refreshSessionState,
  }
}

function classifyPanelTaskFailure(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.startsWith('missing_dependency ')
  ) {
    return 'missing_dependency'
  }

  if (
    error instanceof Error &&
    error.message.startsWith('transport_error ')
  ) {
    return 'transport_error'
  }

  if (error instanceof OpenAICompatibleRequestError) {
    return classifyOpenAICompatibleFailure(error)
  }

  return 'execution_failed'
}

function formatPanelTaskFailure(error: unknown): string {
  if (error instanceof OpenAICompatibleRequestError) {
    const failureClass = classifyOpenAICompatibleFailure(error)
    return `${failureClass} code=${error.code} retryable=${error.retryable} status=${error.status ?? 'n/a'} message=${error.message}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function classifyOpenAICompatibleFailure(
  error: OpenAICompatibleRequestError,
): 'transport_error' | 'provider_error' {
  if (error.code === 'network_error' || error.code === 'timeout') {
    return 'transport_error'
  }

  return 'provider_error'
}
