import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PowerShellCliBackendAdapter } from '../../packages/adapters/cli/CliBackendAdapter.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { StreamableHttpWindowsMcpBridge } from '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import { InMemoryToolRegistry } from '../../packages/tools/Tool.js'
import { createResultPointerTools } from '../../packages/tools/ResultPointerTools.js'
import { createWorkspaceTools } from '../../packages/tools/WorkspaceTools.js'
import {
  createPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'
import { ensureWindowsMcpReady } from './windowsMcpRuntime.js'

type SmokeOptions = {
  endpoint: string
  permissionMode: 'default' | 'auto' | 'confirm-high-risk' | 'read-only'
  windowsMcpManagedByParent: boolean
}

type ScenarioStatus =
  | 'pass'
  | 'skip'
  | 'verification_failed'
  | 'environment_unready'
  | 'transport_error'
  | 'provider_error'
  | 'permission_blocked'
  | 'missing_dependency'

type ScenarioRecord = {
  scenario: string
  status: ScenarioStatus
  detail: string
}

type LiveSmokeTargetSnapshot = {
  browserWindowTitle?: string
  codexWindowTitle?: string
  desktopChatWindowTitle?: string
  editorWindowTitle?: string
  confirmableWindowTitles: string[]
  ambiguityReasons: string[]
}

export async function runPhase4LiveSmokeWithOptions(
  options: SmokeOptions,
): Promise<void> {
  assertEndpoint(options.endpoint)
  assertPermissionMode(options.permissionMode)
  const windowsMcp = options.windowsMcpManagedByParent
    ? undefined
    : await ensureWindowsMcpReady({
        endpoint: options.endpoint,
        launchIfNeeded: true,
      })
  if (windowsMcp) {
    options.endpoint = windowsMcp.endpoint
  }

  try {
    const { runtime } = createPhase4LiveRuntime(options)
    const context = {
      cwd: CLI_WORKSPACE_ROOT,
      sessionId: 'phase4-live-smoke',
      turnId: 'turn-1',
    }

    await cleanupLiveSmokeEditorWindows(runtime, context)
    await cleanupLiveSmokeBrowserWindows(runtime, context)
    await prepareBrowserSmokeFixture(runtime, context)
    const dedicatedEditorWindow = await prepareDedicatedEditorWindow(runtime, context)

    let snapshotData = await refreshLiveSmokeSnapshot(runtime, context)
    let targetSnapshot = resolveLiveSmokeTargets(
      snapshotData,
      dedicatedEditorWindow.windowTitle,
      dedicatedEditorWindow.basename,
    )
    let retainedCodexWindowTitle = targetSnapshot.codexWindowTitle
    let retainedDesktopChatWindowTitle = targetSnapshot.desktopChatWindowTitle

    if (!targetSnapshot.desktopChatWindowTitle) {
      const refreshedWechatSnapshot = await tryActivateWeChatTransferOnlyTarget(
        runtime,
        context,
      )
      if (refreshedWechatSnapshot !== undefined) {
        snapshotData = refreshedWechatSnapshot
        targetSnapshot = resolveLiveSmokeTargets(
          snapshotData,
          dedicatedEditorWindow.windowTitle,
          dedicatedEditorWindow.basename,
        )
        retainedCodexWindowTitle =
          targetSnapshot.codexWindowTitle ?? retainedCodexWindowTitle
        retainedDesktopChatWindowTitle =
          targetSnapshot.desktopChatWindowTitle ?? retainedDesktopChatWindowTitle
      }
    }

    if (
      !targetSnapshot.editorWindowTitle ||
      !targetSnapshot.codexWindowTitle ||
      !targetSnapshot.browserWindowTitle ||
      targetSnapshot.confirmableWindowTitles.length < 2
    ) {
      await ensureLiveSmokeWindowTargets(runtime, context)
      snapshotData = await refreshLiveSmokeSnapshot(runtime, context)
      targetSnapshot = resolveLiveSmokeTargets(
        snapshotData,
        dedicatedEditorWindow.windowTitle,
        dedicatedEditorWindow.basename,
      )
      retainedCodexWindowTitle =
        targetSnapshot.codexWindowTitle ?? retainedCodexWindowTitle
      retainedDesktopChatWindowTitle =
        targetSnapshot.desktopChatWindowTitle ?? retainedDesktopChatWindowTitle
    }

    await stabilizeLiveSmokeTargets(runtime, context, {
      editorWindowTitle: targetSnapshot.editorWindowTitle,
      codexWindowTitle: targetSnapshot.codexWindowTitle,
      desktopChatWindowTitle: targetSnapshot.desktopChatWindowTitle,
    })
    const browserFocused = await focusBrowserForSmoke(runtime, context, snapshotData)
    if (!browserFocused) {
      const detail = buildTargetEnvironmentDetail(
        'browser target could not be focused safely',
        targetSnapshot,
      )
      console.log(
        `[skip] phase4-live-smoke browser-editor-chat-reply-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke browser-doc-desktop-deliver-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke file-browser-form-submit-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke browser-extract-transform-post-template environment_unready ${detail}`,
      )
      return
    }

    let editorWindowTitle = targetSnapshot.editorWindowTitle
    let codexWindowTitle = targetSnapshot.codexWindowTitle ?? retainedCodexWindowTitle
    let desktopChatWindowTitle =
      targetSnapshot.desktopChatWindowTitle ?? retainedDesktopChatWindowTitle
    let browserWindowTitle = targetSnapshot.browserWindowTitle
    let liveWindowTargets = targetSnapshot.confirmableWindowTitles

    const browserTemplateResult = await runtime.execute(
      {
        toolName: 'skill.browser.editor_chat_reply_template',
        input: {
          editorAppName: editorWindowTitle ?? 'Notepad',
          editorTargetWindowTitle: editorWindowTitle ?? 'Notepad',
          chatAppName: codexWindowTitle ?? 'Codex',
          chatTargetWindowTitle: codexWindowTitle ?? 'Codex',
        },
      },
      context,
    )
    const browserTemplateStableResult = await retryLiveSmokeTemplateOnce(
      runtime,
      context,
      snapshotData,
      browserTemplateResult,
      () =>
        runtime.execute(
          {
            toolName: 'skill.browser.editor_chat_reply_template',
            input: {
              editorAppName: editorWindowTitle ?? 'Notepad',
              editorTargetWindowTitle: editorWindowTitle ?? 'Notepad',
              chatAppName: codexWindowTitle ?? 'Codex',
              chatTargetWindowTitle: codexWindowTitle ?? 'Codex',
            },
          },
          context,
        ),
    )
    reportOptionalBrowserEditorChatReplyTemplateScenario(browserTemplateStableResult)

    const postBrowserTemplateSnapshot = await tryRefreshLiveSmokeSnapshot(runtime, context)
    if (postBrowserTemplateSnapshot !== undefined) {
      snapshotData = postBrowserTemplateSnapshot
      const refreshedTargetSnapshot = resolveLiveSmokeTargets(
        snapshotData,
        dedicatedEditorWindow.windowTitle,
        dedicatedEditorWindow.basename,
      )
      editorWindowTitle = refreshedTargetSnapshot.editorWindowTitle ?? editorWindowTitle
      codexWindowTitle = refreshedTargetSnapshot.codexWindowTitle ?? codexWindowTitle
      desktopChatWindowTitle =
        refreshedTargetSnapshot.desktopChatWindowTitle ?? desktopChatWindowTitle
      browserWindowTitle = refreshedTargetSnapshot.browserWindowTitle ?? browserWindowTitle
      retainedCodexWindowTitle = codexWindowTitle
      retainedDesktopChatWindowTitle = desktopChatWindowTitle
      if (refreshedTargetSnapshot.confirmableWindowTitles.length >= 2) {
        liveWindowTargets = refreshedTargetSnapshot.confirmableWindowTitles
      }
      targetSnapshot = refreshedTargetSnapshot
    }

    if (liveWindowTargets.length < 2) {
      liveWindowTargets = await ensureLiveSmokeWindowTargets(runtime, context)
      snapshotData = await refreshLiveSmokeSnapshot(runtime, context)
      targetSnapshot = resolveLiveSmokeTargets(
        snapshotData,
        dedicatedEditorWindow.windowTitle,
        dedicatedEditorWindow.basename,
      )
      retainedCodexWindowTitle =
        targetSnapshot.codexWindowTitle ?? retainedCodexWindowTitle
      retainedDesktopChatWindowTitle =
        targetSnapshot.desktopChatWindowTitle ?? retainedDesktopChatWindowTitle
      codexWindowTitle = targetSnapshot.codexWindowTitle ?? retainedCodexWindowTitle
      desktopChatWindowTitle =
        targetSnapshot.desktopChatWindowTitle ?? retainedDesktopChatWindowTitle
      liveWindowTargets = targetSnapshot.confirmableWindowTitles
    }

    if (liveWindowTargets.length < 2) {
      const detail = buildTargetEnvironmentDetail(
        'requires at least two distinct strong confirmable windows',
        targetSnapshot,
      )
      console.log(
        `[skip] phase4-live-smoke multi-window-compare-summarize-deliver-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke browser-doc-desktop-deliver-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke file-browser-form-submit-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke browser-extract-transform-post-template environment_unready ${detail}`,
      )
      return
    }

    const primaryDesktopTarget = codexWindowTitle ?? liveWindowTargets[0]
    const secondaryDesktopTarget =
      desktopChatWindowTitle ??
      editorWindowTitle ??
      liveWindowTargets.find(title => title !== primaryDesktopTarget) ??
      liveWindowTargets[1]

    if (!primaryDesktopTarget || !secondaryDesktopTarget) {
      const detail = buildTargetEnvironmentDetail(
        'requires at least two distinct confirmable windows',
        targetSnapshot,
      )
      console.log(
        `[skip] phase4-live-smoke multi-window-compare-summarize-deliver-template environment_unready ${detail}`,
      )
    } else {
      await stabilizeLiveSmokeTargets(runtime, context, {
        editorWindowTitle: secondaryDesktopTarget,
        codexWindowTitle: primaryDesktopTarget,
      })

      const compareResult = await runtime.execute(
        {
          toolName: 'skill.multi_window.compare_summarize_deliver_template',
          input: {
            primaryWindowTitle: primaryDesktopTarget,
            secondaryWindowTitle: secondaryDesktopTarget,
            routeQuery: chooseLiveRouteQuery(primaryDesktopTarget),
            targetAppName: primaryDesktopTarget,
            targetWindowTitle: primaryDesktopTarget,
            actionText: 'phase4 live smoke',
          },
        },
        context,
      )
      const compareStableResult = await retryLiveSmokeTemplateOnce(
        runtime,
        context,
        snapshotData,
        compareResult,
        () =>
          runtime.execute(
            {
              toolName: 'skill.multi_window.compare_summarize_deliver_template',
              input: {
                primaryWindowTitle: primaryDesktopTarget,
                secondaryWindowTitle: secondaryDesktopTarget,
                routeQuery: chooseLiveRouteQuery(primaryDesktopTarget),
                targetAppName: primaryDesktopTarget,
                targetWindowTitle: primaryDesktopTarget,
                actionText: 'phase4 live smoke',
              },
            },
            context,
          ),
      )
      reportOptionalMultiWindowCompareSummarizeDeliverTemplateScenario(
        compareStableResult,
        [primaryDesktopTarget, secondaryDesktopTarget],
      )

      const refreshedSnapshotData = compareStableResult.ok
        ? await refreshLiveSmokeSnapshot(runtime, context)
        : await tryRefreshLiveSmokeSnapshot(runtime, context)
      if (refreshedSnapshotData !== undefined) {
        snapshotData = refreshedSnapshotData
        const refreshedTargetSnapshot = resolveLiveSmokeTargets(
          snapshotData,
          dedicatedEditorWindow.windowTitle,
          dedicatedEditorWindow.basename,
        )
        editorWindowTitle = refreshedTargetSnapshot.editorWindowTitle ?? editorWindowTitle
        codexWindowTitle = refreshedTargetSnapshot.codexWindowTitle ?? codexWindowTitle
        desktopChatWindowTitle =
          refreshedTargetSnapshot.desktopChatWindowTitle ?? desktopChatWindowTitle
        browserWindowTitle = refreshedTargetSnapshot.browserWindowTitle ?? browserWindowTitle
        retainedCodexWindowTitle = codexWindowTitle
        retainedDesktopChatWindowTitle = desktopChatWindowTitle
        if (refreshedTargetSnapshot.confirmableWindowTitles.length >= 2) {
          liveWindowTargets = refreshedTargetSnapshot.confirmableWindowTitles
        }
        targetSnapshot = refreshedTargetSnapshot
      }
    }

    const browserRouteTargets = selectBrowserRouteTargets(
      liveWindowTargets,
      browserWindowTitle,
      codexWindowTitle ?? desktopChatWindowTitle ?? editorWindowTitle,
    )
    if (!browserRouteTargets) {
      const detail = buildTargetEnvironmentDetail(
        'requires browser and desktop targets',
        targetSnapshot,
      )
      console.log(
        `[skip] phase4-live-smoke browser-doc-desktop-deliver-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke file-browser-form-submit-template environment_unready ${detail}`,
      )
      console.log(
        `[skip] phase4-live-smoke browser-extract-transform-post-template environment_unready ${detail}`,
      )
      return
    }

    const desktopDeliveryTarget =
      codexWindowTitle ?? editorWindowTitle ?? desktopChatWindowTitle
    if (!desktopDeliveryTarget) {
      const detail = buildTargetEnvironmentDetail(
        'desktop delivery target did not resolve to Codex, a stable editor, or a WeChat-like chat window',
        targetSnapshot,
      )
      console.log(
        `[skip] phase4-live-smoke browser-doc-desktop-deliver-template environment_unready ${detail}`,
      )
    } else {
      const editorStageTarget =
        editorWindowTitle ?? browserRouteTargets.secondaryWindowTitle

      await focusBrowserForSmoke(runtime, context, snapshotData)
      const docTemplateResult = await runtime.execute(
        {
          toolName: 'skill.browser.doc_desktop_deliver_template',
          input: {
            editorAppName: 'Notepad',
            editorTargetWindowTitle: editorStageTarget,
            finalAppName: desktopDeliveryTarget,
            finalTargetWindowTitle: desktopDeliveryTarget,
          },
        },
        context,
      )
      const docTemplateStableResult = await retryLiveSmokeTemplateOnce(
        runtime,
        context,
        snapshotData,
        docTemplateResult,
        () =>
          runtime.execute(
            {
              toolName: 'skill.browser.doc_desktop_deliver_template',
              input: {
                editorAppName: 'Notepad',
                editorTargetWindowTitle: editorStageTarget,
                finalAppName: desktopDeliveryTarget,
                finalTargetWindowTitle: desktopDeliveryTarget,
              },
            },
            context,
          ),
      )
      reportOptionalBrowserDocDesktopDeliverTemplateScenario(
        docTemplateStableResult,
        desktopDeliveryTarget,
      )

    }

    const liveFixturePath = resolve(
      context.cwd,
      'tmp',
      'phase4-live-file-browser-form-submit.txt',
    )
    await mkdir(resolve(context.cwd, 'tmp'), { recursive: true })
    await writeFile(
      liveFixturePath,
      ['phase4 live smoke', 'submit this into the browser'].join('\n'),
      'utf8',
    )

    await focusBrowserForSmoke(runtime, context, snapshotData)
    const formBrowserTarget = browserRouteTargets.primaryWindowTitle
    const formTemplateResult = await runtime.execute(
      {
        toolName: 'skill.file.browser_form_submit_template',
        input: {
          path: liveFixturePath,
          browserWindowTitle: formBrowserTarget,
        },
      },
      context,
    )
    const formTemplateStableResult = await retryLiveSmokeTemplateOnce(
      runtime,
      context,
      snapshotData,
      formTemplateResult,
      () =>
        runtime.execute(
          {
            toolName: 'skill.file.browser_form_submit_template',
            input: {
              path: liveFixturePath,
              browserWindowTitle: formBrowserTarget,
            },
          },
          context,
        ),
    )
    reportOptionalFileBrowserFormSubmitTemplateScenario(
      formTemplateStableResult,
      formBrowserTarget,
    )

    await focusBrowserForSmoke(runtime, context, snapshotData)
    const extractTransferTarget =
      codexWindowTitle ?? editorWindowTitle ?? browserRouteTargets.secondaryWindowTitle
    const extractTemplateResult = await runtime.execute(
      {
        toolName: 'skill.browser.extract_transform_post_template',
        input: {
          targetWindowTitle: extractTransferTarget,
        },
      },
      context,
    )
    const extractTemplateStableResult = await retryLiveSmokeTemplateOnce(
      runtime,
      context,
      snapshotData,
      extractTemplateResult,
      () =>
        runtime.execute(
          {
            toolName: 'skill.browser.extract_transform_post_template',
            input: {
              targetWindowTitle: extractTransferTarget,
            },
          },
          context,
        ),
    )
    reportOptionalBrowserExtractTransformPostTemplateScenario(
      extractTemplateStableResult,
      extractTransferTarget,
    )
  } catch (error) {
    throw classifyWindowsSmokeError(error)
  } finally {
    await windowsMcp?.dispose()
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await runPhase4LiveSmokeWithOptions(options)
}

function parseArgs(argv: string[]): SmokeOptions {
  const endpoint =
    argv.find((value, index) => argv[index - 1] === '--endpoint') ??
    process.env.COMPUSER_WINDOWS_MCP_ENDPOINT ??
    DEFAULT_WINDOWS_MCP_ENDPOINT

  const permissionMode =
    (argv.find((value, index) => argv[index - 1] === '--permission-mode') as
      | SmokeOptions['permissionMode']
      | undefined) ??
    (process.env.COMPUSER_PERMISSION_MODE as SmokeOptions['permissionMode'] | undefined) ??
    'auto'

  return {
    endpoint,
    permissionMode,
    windowsMcpManagedByParent:
      process.env.COMPUSER_WINDOWS_MCP_MANAGED_BY_PARENT === '1' ||
      process.env.COMPUSER_WINDOWS_MCP_MANAGED_BY_PARENT?.toLowerCase() === 'true',
  }
}

function assertEndpoint(endpoint: string): void {
  if (!endpoint.trim()) {
    throw new Error('missing_dependency missing Windows-MCP endpoint')
  }
}

function assertPermissionMode(permissionMode: SmokeOptions['permissionMode']): void {
  if (permissionMode === 'read-only') {
    throw new Error('permission_blocked permission mode read-only does not allow phase4 template smoke actions')
  }
}

async function prepareBrowserSmokeFixture(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<void> {
  const fixturePath = resolve(context.cwd, 'tmp', 'phase4-live-browser-fixture.html')
  await mkdir(resolve(context.cwd, 'tmp'), { recursive: true })
  const fixtureHtml = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>compuser phase4 browser smoke</title></head>',
    '<body>',
    '<main>',
    '<h1>compuser phase4 browser smoke</h1>',
    '<p>Need reply in WeChat</p>',
    '<p>Route this follow-up to Notepad when testing delivery chains.</p>',
    '<form>',
    '<label for="message">Message</label>',
    '<textarea id="message" name="message" rows="6" cols="48"></textarea>',
    '<button type="submit">Submit</button>',
    '</form>',
        '</main>',
        '</body>',
        '</html>',
  ].join('')
  await writeFile(fixturePath, fixtureHtml, 'utf8')

  const fileUrl = `file:///${fixturePath.replace(/\\/g, '/')}`
  const launchCommands = [
    `Start-Process msedge.exe -ArgumentList '--app=${fileUrl}'`,
    `Start-Process chrome.exe -ArgumentList '--app=${fileUrl}'`,
    `Start-Process firefox.exe '${fileUrl}'`,
    `Start-Process explorer.exe '${fileUrl}'`,
  ]

  for (const command of launchCommands) {
    const result = await runtime.execute(
      {
        toolName: 'windows.shell',
        input: {
          command,
        },
      },
      context,
    )
    if (result.ok) {
      await runtime.execute(
        {
          toolName: 'windows.wait',
          input: { durationSeconds: 2 },
        },
        context,
      )
      if (await waitForBrowserSmokeFixtureWindow(runtime, context)) {
        return
      }
    }
  }
}

async function waitForBrowserSmokeFixtureWindow(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshotData = await tryRefreshLiveSmokeSnapshot(runtime, context)
    const fixtureWindowTitle = selectWindowTitleContaining(
      snapshotData,
      'compuser phase4 browser smoke',
    )
    if (fixtureWindowTitle) {
      await runtime.execute(
        {
          toolName: 'windows.focus_window',
          input: { windowTitle: fixtureWindowTitle },
        },
        context,
      )
      await runtime.execute(
        {
          toolName: 'windows.wait',
          input: { durationSeconds: 1 },
        },
        context,
      )
      return true
    }

    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 1 },
      },
      context,
    )
  }

  return false
}

async function cleanupLiveSmokeBrowserWindows(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<void> {
  await runtime.execute(
    {
      toolName: 'windows.shell',
      input: {
        command: [
          '$targets = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {',
          "  $_.MainWindowTitle -like '*compuser phase4 browser smoke*'",
          '}',
          '$targets += Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {',
          "  $_.MainWindowTitle -like '*compuser phase4 browser smoke*'",
          '}',
          '$targets += Get-Process firefox -ErrorAction SilentlyContinue | Where-Object {',
          "  $_.MainWindowTitle -like '*compuser phase4 browser smoke*'",
          '}',
          'if ($targets) {',
          '  $targets | Stop-Process -Force',
          '}',
        ].join('\n'),
      },
    },
    context,
  )

  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 1 },
    },
    context,
  )
}

async function cleanupLiveSmokeEditorWindows(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<void> {
  await runtime.execute(
    {
      toolName: 'windows.shell',
      input: {
        command: [
          '$notepadTargets = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object {',
          "  $_.MainWindowTitle -like '*phase4-live-reply-editor-*' -or",
          "  $_.MainWindowTitle -eq '无标题 - 记事本' -or",
          "  $_.MainWindowTitle -eq 'Untitled - Notepad'",
          '}',
          '$calcTargets = Get-Process CalculatorApp -ErrorAction SilentlyContinue',
          '$targets = @()',
          'if ($notepadTargets) { $targets += $notepadTargets }',
          'if ($calcTargets) { $targets += $calcTargets }',
          'if ($targets) {',
          '  $targets | Stop-Process -Force',
          '}',
        ].join('\n'),
      },
    },
    context,
  )

  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 1 },
    },
    context,
  )
}

async function prepareDedicatedEditorWindow(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<{
  windowTitle?: string
  basename: string
}> {
  const editorBasename = `phase4-live-reply-editor-${Date.now()}.txt`
  await mkdir(resolve(context.cwd, 'tmp'), { recursive: true })
  const editorPath = resolve(context.cwd, 'tmp', editorBasename)
  await writeFile(editorPath, 'phase4 live reply editor\n', 'utf8')

  const launchResult = await runtime.execute(
    {
      toolName: 'windows.shell',
      input: {
        command: `Start-Process notepad.exe '${editorPath.replace(/'/g, "''")}'`,
      },
    },
    context,
  )
  if (!launchResult.ok) {
    return {
      basename: editorBasename,
    }
  }

  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 1 },
    },
    context,
  )

  const snapshotData = await refreshLiveSmokeSnapshot(runtime, context)
  return {
    basename: editorBasename,
    windowTitle: selectWindowTitleContaining(snapshotData, editorBasename),
  }
}

async function resolvePossiblyStoredResult(
  runtime: ToolRuntime,
  result: {
    ok: boolean
    data?: unknown
    pointer?: string
  },
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown> {
  if (!result.pointer) {
    return result.data
  }

  let offset = 0
  let content = ''

  for (let index = 0; index < 32; index += 1) {
    const readBack = await runtime.execute(
      {
        toolName: 'artifacts.read_result',
        input: {
          pointer: result.pointer,
          maxChars: 20_000,
          offset,
        },
      },
      context,
    )

    assert(readBack.ok, 'verification_failed phase4 snapshot pointer read failed')

    const payload = readBack.data as {
      content?: unknown
      hasMore?: unknown
      nextOffset?: unknown
    } | undefined

    if (typeof payload?.content !== 'string') {
      throw new Error('verification_failed phase4 snapshot pointer content missing')
    }

    content += payload.content

    if (payload.hasMore !== true) {
      return parseNestedJsonString(content)
    }

    if (typeof payload.nextOffset !== 'number') {
      throw new Error('verification_failed phase4 snapshot pointer nextOffset missing')
    }

    offset = payload.nextOffset
  }

  throw new Error('verification_failed phase4 snapshot pointer read exceeded chunk budget')
}

async function refreshLiveSmokeSnapshot(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown> {
  const snapshot = await runtime.execute(
    {
      toolName: 'windows.snapshot',
      input: {},
    },
    context,
  )
  if (!snapshot.ok) {
    throw classifyPhase4RuntimeToolError('phase4 snapshot failed', snapshot)
  }
  return resolvePossiblyStoredResult(runtime, snapshot, context)
}

async function tryRefreshLiveSmokeSnapshot(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown | undefined> {
  try {
    return await refreshLiveSmokeSnapshot(runtime, context)
  } catch {
    return undefined
  }
}

function parseNestedJsonString(content: string): unknown {
  let current: unknown = content

  for (let index = 0; index < 2; index += 1) {
    if (typeof current !== 'string') {
      return current
    }

    try {
      current = JSON.parse(current) as unknown
    } catch {
      return current
    }
  }

  return current
}

async function tryActivateWeChatTransferOnlyTarget(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown | undefined> {
  const surfacedSnapshot = await trySurfaceWeChatWindow(runtime, context)
  if (surfacedSnapshot !== undefined) {
    return surfacedSnapshot
  }

  for (const windowTitle of ['微信', 'Weixin']) {
    const focusResult = await runtime.execute(
      {
        toolName: 'windows.focus_window',
        input: { windowTitle },
      },
      context,
    )
    if (!focusResult.ok) {
      continue
    }

    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 1 },
      },
      context,
    )

    const transferOnlyResult = await runtime.execute(
      {
        toolName: 'windows.click_element_by_name',
        input: {
          name: '仅传输文件',
          windowTitle,
          matchMode: 'exact',
        },
      },
      context,
    )
    if (!transferOnlyResult.ok) {
      continue
    }

    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 2 },
      },
      context,
    )

    return tryRefreshLiveSmokeSnapshot(runtime, context)
  }

  return undefined
}

async function trySurfaceWeChatWindow(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown | undefined> {
  const directSnapshot = await tryAcknowledgeAndEnterWeChat(runtime, context)
  if (directSnapshot !== undefined) {
    return directSnapshot
  }

  const softwareWindowTitle = '\u8f6f\u4ef6'
  const softwareFolderPath = `${process.env.USERPROFILE ?? 'C:\\Users\\Gu haipeng'}\\Desktop\\${softwareWindowTitle}`
  await runtime.execute(
    {
      toolName: 'windows.shortcut',
      input: { shortcut: 'win+d' },
    },
    context,
  )
  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 1 },
    },
    context,
  )
  await runtime.execute(
    {
      toolName: 'windows.shell',
      input: {
        command: `Start-Process explorer.exe '${softwareFolderPath.replace(/'/g, "''")}'`,
      },
    },
    context,
  )
  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 2 },
    },
    context,
  )
  await runtime.execute(
    {
      toolName: 'windows.focus_window',
      input: { windowTitle: softwareWindowTitle },
    },
    context,
  )
  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 1 },
    },
    context,
  )

  const launchWechatResult = await runtime.execute(
    {
      toolName: 'windows.double_click_element_by_name',
      input: {
        name: 'Weixin',
        windowTitle: softwareWindowTitle,
        matchMode: 'exact',
      },
    },
    context,
  )
  if (!launchWechatResult.ok) {
    return undefined
  }

  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 2 },
    },
    context,
  )

  return tryAcknowledgeAndEnterWeChat(runtime, context)
}

async function tryAcknowledgeAndEnterWeChat(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<unknown | undefined> {
  const wechatWindowTitle = '\u5fae\u4fe1'
  const acknowledgeResult = await runtime.execute(
    {
      toolName: 'windows.click_element_by_name',
      input: {
        name: '\u6211\u77e5\u9053\u4e86',
        matchMode: 'exact',
      },
    },
    context,
  )
  if (acknowledgeResult.ok) {
    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 2 },
      },
      context,
    )
  }

  const enterWechatResult = await runtime.execute(
    {
      toolName: 'windows.click_element_by_name',
      input: {
        name: '\u8fdb\u5165\u5fae\u4fe1',
        windowTitle: wechatWindowTitle,
        matchMode: 'exact',
      },
    },
    context,
  )
  if (enterWechatResult.ok) {
    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 3 },
      },
      context,
    )
  }

  for (const windowTitle of [wechatWindowTitle, 'Weixin']) {
    const focusResult = await runtime.execute(
      {
        toolName: 'windows.focus_window',
        input: { windowTitle },
      },
      context,
    )
    if (!focusResult.ok) {
      continue
    }
    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 1 },
      },
      context,
    )
    return tryRefreshLiveSmokeSnapshot(runtime, context)
  }

  return acknowledgeResult.ok || enterWechatResult.ok
    ? tryRefreshLiveSmokeSnapshot(runtime, context)
    : undefined
}

async function focusBrowserForSmoke(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  snapshotData?: unknown,
): Promise<boolean> {
  for (let pass = 0; pass < 2; pass += 1) {
    const passSnapshot =
      pass === 0 ? snapshotData : await tryRefreshLiveSmokeSnapshot(runtime, context)
    const candidateTitles = collectBrowserFocusCandidates(passSnapshot)
    for (const title of candidateTitles) {
      const result = await runtime.execute(
        {
          toolName: 'windows.focus_window',
          input: {
            windowTitle: title,
          },
        },
        context,
      )
      if (result.ok) {
        await runtime.execute(
          {
            toolName: 'windows.wait',
            input: { durationSeconds: 1 },
          },
          context,
        )

        const refreshedSnapshot = await tryRefreshLiveSmokeSnapshot(runtime, context)
        if (isFocusedBrowserSnapshot(refreshedSnapshot, title)) {
          return true
        }
      }
    }

    if (await waitForBrowserSmokeFixtureWindow(runtime, context)) {
      const refreshedSnapshot = await tryRefreshLiveSmokeSnapshot(runtime, context)
      if (isFocusedBrowserSnapshot(refreshedSnapshot, 'compuser phase4 browser smoke')) {
        return true
      }
    }
  }

  return false
}

function isFocusedBrowserSnapshot(
  snapshotData: unknown,
  expectedTitle?: string,
): boolean {
  if (typeof snapshotData !== 'object' || snapshotData === null) {
    return false
  }

  const candidate = snapshotData as {
    focusedWindow?: unknown
  }
  const focusedWindow =
    typeof candidate.focusedWindow === 'string'
      ? candidate.focusedWindow.replace(/\s+/g, ' ').trim()
      : undefined
  if (!focusedWindow || !looksLikeBrowserWindow(focusedWindow)) {
    return false
  }

  if (!expectedTitle) {
    return true
  }

  const normalizedFocused = focusedWindow.toLowerCase()
  const normalizedExpected = expectedTitle.replace(/\s+/g, ' ').trim().toLowerCase()
  return (
    normalizedFocused.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedFocused) ||
    /compuser phase4 browser smoke/i.test(focusedWindow)
  )
}

async function stabilizeLiveSmokeTargets(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  targets: {
    editorWindowTitle?: string
    codexWindowTitle?: string
    desktopChatWindowTitle?: string
  },
): Promise<void> {
  for (const windowTitle of [
    targets.editorWindowTitle,
    targets.codexWindowTitle,
    targets.desktopChatWindowTitle,
  ]) {
    if (!windowTitle) {
      continue
    }

    const focusResult = await runtime.execute(
      {
        toolName: 'windows.focus_window',
        input: {
          windowTitle,
        },
      },
      context,
    )
    if (!focusResult.ok) {
      continue
    }

    await runtime.execute(
      {
        toolName: 'windows.wait',
        input: { durationSeconds: 1 },
      },
      context,
    )
  }
}

function collectBrowserFocusCandidates(snapshotData: unknown): string[] {
  if (typeof snapshotData !== 'object' || snapshotData === null) {
    return ['compuser phase4 browser smoke', 'Microsoft Edge', 'Google Chrome', 'Firefox']
  }

  const candidate = snapshotData as {
    focusedWindow?: unknown
    windows?: unknown
    anchors?: unknown
  }
  const values = [
    'compuser phase4 browser smoke',
    typeof candidate.focusedWindow === 'string' ? candidate.focusedWindow : undefined,
    ...(Array.isArray(candidate.windows)
      ? candidate.windows.filter((value): value is string => typeof value === 'string')
      : []),
    ...(Array.isArray(candidate.anchors)
      ? candidate.anchors.filter((value): value is string => typeof value === 'string')
      : []),
    'Microsoft Edge',
    'Google Chrome',
    'Firefox',
  ]

  const results: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    if (!/(edge|chrome|firefox|browser|compuser phase4 browser smoke)/i.test(normalized)) {
      continue
    }
    seen.add(normalized)
    results.push(normalized)
  }

  return results
}

function selectEditorWindowTitle(data: unknown): string | undefined {
  return readLiveSmokeWindowTitles(data).find(title =>
    /(notepad|记事本|wordpad|editor|note|无标题)/i.test(title),
  )
}

function selectChatWindowTitle(data: unknown): string | undefined {
  return readLiveSmokeWindowTitles(data).find(title => /codex/i.test(title))
}

function selectPreferredDesktopChatWindowTitle(data: unknown): string | undefined {
  const primary = selectDesktopChatWindowTitle(data)
  const candidates = dedupeStrings([
    primary,
    ...readLiveSmokeWindowTitles(data).filter(isDesktopChatWindowCandidate),
  ])
  return [...candidates].sort(
    (left, right) => scoreDesktopChatWindowTitle(right) - scoreDesktopChatWindowTitle(left),
  )[0]
}

function selectDesktopChatWindowTitle(data: unknown): string | undefined {
  return readLiveSmokeWindowTitles(data).find(title =>
    /(wechat|weixin|微信|企业微信|wecom|wxwork|文件传输助手)/i.test(title),
  )
}

function selectBrowserWindowTitle(data: unknown): string | undefined {
  return (
    readLiveSmokeWindowTitles(data).find(title =>
      /compuser phase4 browser smoke/i.test(title),
    ) ??
    readLiveSmokeWindowTitles(data).find(title =>
      /(edge|chrome|firefox|browser)/i.test(title),
    )
  )
}

async function ensureLiveSmokeWindowTargets(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<string[]> {
  for (const command of ['Start-Process notepad.exe', 'Start-Process calc.exe']) {
    await runtime.execute(
      {
        toolName: 'windows.shell',
        input: { command },
      },
      context,
    )
  }

  for (const appName of ['Notepad', 'Calculator']) {
    await runtime.execute(
      {
        toolName: 'command.app.open_or_focus',
        input: { appName },
      },
      context,
    )
  }

  const refreshedSnapshot = await runtime.execute(
    {
      toolName: 'windows.snapshot',
      input: {},
    },
    context,
  )
  if (!refreshedSnapshot.ok) {
    return []
  }

  const refreshedData = await resolvePossiblyStoredResult(runtime, refreshedSnapshot, context)
  return selectDistinctLiveSmokeWindows(refreshedData)
}

function selectDistinctLiveSmokeWindows(data: unknown): string[] {
  const values = prioritizeLiveSmokeWindowTitles(readLiveSmokeWindowTitles(data))
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (
      !isUsableLiveWindowTarget(normalized) ||
      !isStrongConfirmableWindowTitle(normalized) ||
      seen.has(normalized)
    ) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= 2) {
      break
    }
  }

  return result
}

function readLiveSmokeWindowTitles(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const candidate = data as {
    focusedWindow?: unknown
    windows?: unknown
  }

  return dedupeStrings([
    typeof candidate.focusedWindow === 'string' ? candidate.focusedWindow : undefined,
    ...(Array.isArray(candidate.windows)
      ? candidate.windows.filter((value): value is string => typeof value === 'string')
      : []),
    ...readStrictTaskbarWindowTitles(data),
  ])
}

function readTaskbarWindowTitles(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const candidate = data as { summary?: unknown }
  if (typeof candidate.summary !== 'string') {
    return []
  }

  const matches = [...candidate.summary.matchAll(/(?:按钮|菜单项目)\s+"([^"]+?)"/g)]
    .map(match => match[1]?.replace(/\s+-\s+\d+\s+个运行窗口$/u, '').trim())
    .filter((value): value is string => Boolean(value))

  return matches
}

function isUsableLiveWindowTarget(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return (
    !normalized.includes('no windows found') &&
    !normalized.includes('taskbar') &&
    !normalized.includes('start menu') &&
    !normalized.includes('开始')
  )
}

function chooseLiveRouteQuery(windowTitle: string): string {
  const normalized = windowTitle.replace(/\s+/g, ' ').trim()
  const segments = normalized.split(/[\s\-_|:()]+/).filter(Boolean)
  const preferred = segments.find(segment => segment.length >= 4)
  return preferred ?? normalized.slice(0, Math.min(8, normalized.length))
}

function selectBrowserRouteTargets(
  windowTitles: string[],
  browserWindowTitle?: string,
  textWindowTitle?: string,
): {
  primaryWindowTitle: string
  secondaryWindowTitle: string
  routeQuery: string
} | undefined {
  const secondaryWindowTitle =
    textWindowTitle ??
    windowTitles.find(isTextTransferWindowTitle) ??
    windowTitles[1]
  if (!secondaryWindowTitle) {
    return undefined
  }

  const primaryWindowTitle =
    browserWindowTitle ??
    windowTitles.find(
      windowTitle =>
        windowTitle !== secondaryWindowTitle && looksLikeBrowserWindow(windowTitle),
    ) ??
    windowTitles.find(windowTitle => windowTitle !== secondaryWindowTitle) ??
    windowTitles[0]
  if (!primaryWindowTitle) {
    return undefined
  }

  if (primaryWindowTitle === secondaryWindowTitle) {
    return undefined
  }

  return {
    primaryWindowTitle,
    secondaryWindowTitle,
    routeQuery: chooseLiveRouteQuery(secondaryWindowTitle),
  }
}

function isTextTransferWindowTitle(windowTitle: string): boolean {
  return (
    isStableEditorWindowTitle(windowTitle) ||
    /(wechat|weixin|微信|企业微信|wecom|wxwork|文件传输助手)/i.test(windowTitle)
  )
}

function looksLikeBrowserWindow(windowTitle: string): boolean {
  return /(edge|chrome|firefox|browser|compuser phase4 browser smoke)/i.test(windowTitle)
}

function isEditorWindowTitle(windowTitle: string): boolean {
  return /(notepad|wordpad|editor|note|记事本|无标题)/i.test(windowTitle)
}

function prioritizeLiveSmokeWindowTitles(values: string[]): string[] {
  return [...values].sort(
    (left, right) => scoreLiveSmokeWindowTitle(right) - scoreLiveSmokeWindowTitle(left),
  )
}

function scoreLiveSmokeWindowTitle(value: string): number {
  if (/(wechat|weixin|微信|企业微信|wecom|wxwork|文件传输助手)/i.test(value)) {
    return 5
  }
  if (isStableEditorWindowTitle(value)) {
    return 4
  }
  if (/codex/i.test(value)) {
    return 3
  }
  if (looksLikeBrowserWindow(value)) {
    return 2
  }
  if (/powershell|calculator|calc|explorer|task manager|resource monitor/i.test(value)) {
    return 0
  }
  return 1
}

function isDesktopChatWindowCandidate(value: string): boolean {
  return /(wechat|weixin|wecom|wxwork|微信|企业微信|文件传输助手)/i.test(value)
}

function scoreDesktopChatWindowTitle(value: string): number {
  const normalized = value.replace(/\s+/g, ' ').trim()
  let score = 0

  if (/^(weixin|wechat|wecom|wxwork)$/i.test(normalized)) {
    score += 20
  }
  if (/^(微信|企业微信|文件传输助手)$/u.test(normalized)) {
    score += 24
  }
  if (!/\s-\s/.test(normalized)) {
    score += 12
  } else {
    score -= 8
  }
  if (/\d/.test(normalized)) {
    score -= 2
  }

  return score - normalized.length * 0.01
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = typeof value === 'string'
      ? value.replace(/^\*+\s*/u, '').replace(/\s+/g, ' ').trim()
      : ''
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function selectStableEditorWindowTitle(data: unknown): string | undefined {
  return readLiveSmokeWindowTitles(data).find(isStableEditorWindowTitle)
}

function resolveLiveSmokeTargets(
  data: unknown,
  dedicatedEditorWindowTitle: string | undefined,
  dedicatedEditorBasename: string,
): LiveSmokeTargetSnapshot {
  const editorWindowTitle =
    dedicatedEditorWindowTitle ??
    selectWindowTitleContaining(data, dedicatedEditorBasename) ??
    selectStableEditorWindowTitle(data)
  const codexWindowTitle = selectChatWindowTitle(data)
  const desktopChatWindowTitle = selectPreferredDesktopChatWindowTitle(data)
  const browserWindowTitle = selectBrowserWindowTitle(data)
  const confirmableWindowTitles = selectDistinctLiveSmokeWindows(data)
  const ambiguityReasons: string[] = []

  if (!browserWindowTitle) {
    ambiguityReasons.push('browser window not found')
  }
  if (!codexWindowTitle) {
    ambiguityReasons.push('Codex window not found')
  }
  if (!desktopChatWindowTitle) {
    ambiguityReasons.push('WeChat-like desktop target not found')
  }
  if (!editorWindowTitle) {
    ambiguityReasons.push('editor window not found')
  }
  if (confirmableWindowTitles.length < 2) {
    ambiguityReasons.push('fewer than two strong confirmable windows')
  }

  return {
    browserWindowTitle,
    codexWindowTitle,
    desktopChatWindowTitle,
    editorWindowTitle,
    confirmableWindowTitles,
    ambiguityReasons,
  }
}

function selectWindowTitleContaining(
  data: unknown,
  fragment: string,
): string | undefined {
  const normalizedFragment = fragment.trim().toLowerCase()
  if (!normalizedFragment) {
    return undefined
  }

  return readLiveSmokeWindowTitles(data).find(title =>
    title.toLowerCase().includes(normalizedFragment),
  )
}

function isStableEditorWindowTitle(windowTitle: string): boolean {
  return /(notepad|记事本|wordpad|editor|note|无标题)/i.test(windowTitle)
}

function readStrictTaskbarWindowTitles(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const candidate = data as { summary?: unknown }
  if (typeof candidate.summary !== 'string') {
    return []
  }

  const matches = [
    ...candidate.summary.matchAll(
      /(?:按钮|菜单项目|button|menu item|taskbar(?: button)?|window)\s+"([^"\r\n]{2,120})"/gi,
    ),
  ]

  return matches
    .map(match => normalizeStrictTaskbarWindowTitle(match[1]))
    .filter((value): value is string => Boolean(value))
    .filter(isStrictTaskbarWindowTitle)
}

function normalizeStrictTaskbarWindowTitle(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return undefined
  }

  return normalized
    .replace(/\s+-\s+\d+\s+(running windows?|个运行窗口)$/i, '')
    .trim()
}

function isStrictTaskbarWindowTitle(value: string): boolean {
  return /(edge|chrome|firefox|browser|codex|powershell|notepad|记事本|calculator|calc|explorer|compuser|wechat|weixin|微信|wecom|wxwork|文件传输助手)/i.test(
    value,
  )
}

function selectPreferredEditorWindowTitle(data: unknown): string | undefined {
  return readLiveSmokeWindowTitles(data).find(isPreferredEditorWindowTitle)
}

function isPreferredEditorWindowTitle(windowTitle: string): boolean {
  return /(notepad|记事本|wordpad|editor|note|无标题)/i.test(windowTitle)
}

function readLikelyTaskbarWindowTitles(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const candidate = data as { summary?: unknown }
  if (typeof candidate.summary !== 'string') {
    return []
  }

  return [...candidate.summary.matchAll(/"([^"\r\n]{2,120})"/g)]
    .map(match => normalizeTaskbarWindowTitle(match[1]))
    .filter((value): value is string => Boolean(value))
    .filter(isLikelyTaskbarWindowTitle)
}

function normalizeTaskbarWindowTitle(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return undefined
  }

  return normalized
    .replace(/\s+-\s+\d+\s+(running windows?|个运行窗口)$/i, '')
    .trim()
}

function isLikelyTaskbarWindowTitle(value: string): boolean {
  return /(edge|chrome|firefox|browser|codex|powershell|notepad|记事本|calculator|calc|explorer|compuser|wechat|weixin|微信|wecom|wxwork|文件传输助手)/i.test(
    value,
  )
}

function isStrongConfirmableWindowTitle(windowTitle: string): boolean {
  return (
    looksLikeBrowserWindow(windowTitle) ||
    /codex/i.test(windowTitle) ||
    /(wechat|weixin|微信|企业微信|wecom|wxwork|文件传输助手)/i.test(windowTitle) ||
    isStableEditorWindowTitle(windowTitle)
  )
}

async function retryLiveSmokeTemplateOnce(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  snapshotData: unknown,
  result: { ok: boolean; data?: unknown; summary: string },
  run: () => Promise<{ ok: boolean; data?: unknown; summary: string }>,
): Promise<{ ok: boolean; data?: unknown; summary: string }> {
  if (!shouldRetryLiveSmokeTemplate(result)) {
    return result
  }

  await stabilizeLiveSmokeRetry(runtime, context, snapshotData)
  return await run()
}

function shouldRetryLiveSmokeTemplate(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  return (
    isOptionalBrowserEnvironmentUnready(result) ||
    isOptionalBrowserExtractEnvironmentUnready(result) ||
    isOptionalMultiWindowEnvironmentUnready(result) ||
    isOptionalTransientExecutionFailure(result)
  )
}

async function stabilizeLiveSmokeRetry(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  snapshotData: unknown,
): Promise<void> {
  await focusBrowserForSmoke(runtime, context, snapshotData)
  await runtime.execute(
    {
      toolName: 'windows.wait',
      input: { durationSeconds: 1 },
    },
    context,
  )
}

function isOptionalBrowserEnvironmentUnready(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok || typeof result.data !== 'object' || result.data === null) {
    return false
  }

  const candidate = result.data as {
    verification?: unknown
    chainState?: unknown
    verificationEvidence?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown; details?: unknown })
      : undefined
  const chainState =
    typeof candidate.chainState === 'object' && candidate.chainState !== null
      ? (candidate.chainState as { chainStatus?: unknown })
      : undefined
  const evidence = Array.isArray(candidate.verificationEvidence)
    ? candidate.verificationEvidence.filter((value): value is string => typeof value === 'string')
    : []

  return (
    verification?.passed === false &&
    chainState?.chainStatus === 'verified_failed' &&
    typeof verification.details === 'string' &&
    (
      verification.details.includes('no stable text payload could be extracted') ||
      verification.details.includes('target window could not be confirmed') ||
      verification.details.includes('focus') ||
      verification.details.includes('browser text') ||
      verification.details.includes('no stable extractable text')
    ) &&
    evidence.some(item =>
      item.startsWith('focused=') ||
      item.startsWith('chatTarget=') ||
      item.startsWith('finalTarget=') ||
      item.startsWith('stageTarget=') ||
      item.startsWith('target=')
    )
  )
}

function isOptionalMultiWindowEnvironmentUnready(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok || typeof result.data !== 'object' || result.data === null) {
    return false
  }

  const candidate = result.data as {
    verification?: unknown
    chainState?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown; details?: unknown })
      : undefined
  const chainState =
    typeof candidate.chainState === 'object' && candidate.chainState !== null
      ? (candidate.chainState as { chainStatus?: unknown })
      : undefined

  return (
    verification?.passed === false &&
    chainState?.chainStatus === 'verified_failed' &&
    typeof verification.details === 'string' &&
    (
      verification.details.includes('no distinct confirmable windows') ||
      verification.details.includes('target window could not be confirmed') ||
      verification.details.includes('focus')
    )
  )
}

function isOptionalBrowserReplyChainFailed(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok || typeof result.data !== 'object' || result.data === null) {
    return false
  }

  const candidate = result.data as {
    failureReason?: unknown
    verification?: unknown
  }
  const verification =
    typeof candidate.verification === 'object' && candidate.verification !== null
      ? (candidate.verification as { passed?: unknown })
      : undefined

  return (
    candidate.failureReason === 'execution_failed' &&
    verification?.passed === false &&
    (
      result.summary.includes('browser.editor_chat_stage_and_deliver_verify') ||
      result.summary.toLowerCase().includes('reply delivery failed')
    )
  )
}

function createPhase4LiveRuntime(options: SmokeOptions): {
  runtime: ToolRuntime
  registry: InMemoryToolRegistry
} {
  const registry = new InMemoryToolRegistry()
  const adapter = new BridgeWindowsMcpAdapter(
    new StreamableHttpWindowsMcpBridge(options.endpoint),
  )
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  for (const tool of createResultPointerTools(CLI_WORKSPACE_ROOT)) {
    registry.register(tool)
  }
  for (const tool of createWorkspaceTools({ workspaceRoot: CLI_WORKSPACE_ROOT })) {
    registry.register(tool)
  }

  const runtime = new ToolRuntime(
    registry,
    createPermissionChecker(registry, options.permissionMode),
  )
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
    cliAdapter: new PowerShellCliBackendAdapter(),
  })) {
    registry.register(tool)
  }

  return {
    runtime,
    registry,
  }
}

function reportOptionalBrowserEditorChatReplyTemplateScenario(result: {
  ok: boolean
  data?: unknown
  summary: string
}): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed browser editor chat reply template verification failed',
    )
    assertOperationPresent(
      result.data,
      'skill.browser.editor_chat_stage_and_deliver_verify',
      'verification_failed browser editor chat reply template base chain missing',
    )
    assertEvidencePresent(
      result.data,
      'template=browser-editor-chat-reply',
      'verification_failed browser editor chat reply template marker missing',
    )
    assertRoutingPolicyDefault(
      result.data,
      'verification_failed browser editor chat reply template routing policy mismatch',
    )
    console.log('[pass] phase4-live-smoke browser-editor-chat-reply-template')
    return
  }

  if (isOptionalBrowserEnvironmentUnready(result) || isOptionalBrowserReplyChainFailed(result)) {
    console.log(
      `[skip] phase4-live-smoke browser-editor-chat-reply-template environment_unready ${result.summary}`,
    )
    return
  }

  console.log(
    `[skip] phase4-live-smoke browser-editor-chat-reply-template execution_failed ${result.summary}`,
  )
}

function reportOptionalBrowserDocDesktopDeliverTemplateScenario(
  result: { ok: boolean; data?: unknown; summary: string },
  expectedTarget: string,
): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed browser doc desktop deliver template verification failed',
    )
    assertOperationPresent(
      result.data,
      'skill.browser.editor_stage_and_deliver',
      'verification_failed browser doc desktop deliver template base chain missing',
    )
    assertEvidencePresent(
      result.data,
      'template=browser-doc-desktop-deliver',
      'verification_failed browser doc desktop deliver template marker missing',
    )
    assertSubmitActionPresent(
      result.data,
      expectedTarget,
      'verification_failed browser doc desktop deliver template submit action missing',
    )
    assertSelectedTarget(
      result.data,
      expectedTarget,
      'verification_failed browser doc desktop deliver template selected unexpected target',
    )
    assertRoutingPolicyDefault(
      result.data,
      'verification_failed browser doc desktop deliver template routing policy mismatch',
    )
    console.log(
      `[pass] phase4-live-smoke browser-doc-desktop-deliver-template -> ${expectedTarget}`,
    )
    return
  }

  if (isOptionalBrowserEnvironmentUnready(result)) {
    console.log(
      `[skip] phase4-live-smoke browser-doc-desktop-deliver-template environment_unready ${result.summary}`,
    )
    return
  }

  console.log(
    `[skip] phase4-live-smoke browser-doc-desktop-deliver-template execution_failed ${result.summary}`,
  )
}

function reportOptionalFileBrowserFormSubmitTemplateScenario(
  result: { ok: boolean; data?: unknown; summary: string },
  expectedTarget: string,
): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed file browser form submit template verification failed',
    )
    assertOperationPresent(
      result.data,
      'skill.file_read_transform_transfer',
      'verification_failed file browser form submit template base chain missing',
    )
    assertEvidencePresent(
      result.data,
      'template=file-browser-form-submit',
      'verification_failed file browser form submit template marker missing',
    )
    assertSelectedOrCurrentTarget(
      result.data,
      expectedTarget,
      'verification_failed file browser form submit template selected unexpected target',
    )
    assertRoutingPolicyDefault(
      result.data,
      'verification_failed file browser form submit template routing policy mismatch',
    )
    console.log(`[pass] phase4-live-smoke file-browser-form-submit-template -> ${expectedTarget}`)
    return
  }

  if (isOptionalBrowserEnvironmentUnready(result)) {
    console.log(
      `[skip] phase4-live-smoke file-browser-form-submit-template environment_unready ${result.summary}`,
    )
    return
  }

  console.log(
    `[skip] phase4-live-smoke file-browser-form-submit-template execution_failed ${result.summary}`,
  )
}

function reportOptionalMultiWindowCompareSummarizeDeliverTemplateScenario(
  result: { ok: boolean; data?: unknown; summary: string },
  allowedTargets: string[],
): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed multi window compare summarize deliver template verification failed',
    )
    assertOperationPresent(
      result.data,
      'skill.multi_window.observe_route_deliver_verify',
      'verification_failed multi window compare summarize deliver template base chain missing',
    )
    assertEvidencePresent(
      result.data,
      'template=multi-window-compare-summarize-deliver',
      'verification_failed multi window compare summarize deliver template marker missing',
    )
    assertSubmitActionPresent(
      result.data,
      allowedTargets[0] ?? '',
      'verification_failed multi window compare summarize deliver template submit action missing',
    )
    assertSelectedTargetInSet(
      result.data,
      allowedTargets,
      'verification_failed multi window compare summarize deliver template selected unexpected target',
    )
    assertRoutingPolicyDefault(
      result.data,
      'verification_failed multi window compare summarize deliver template routing policy mismatch',
    )
    console.log(
      `[pass] phase4-live-smoke multi-window-compare-summarize-deliver-template -> ${allowedTargets.join(' | ')}`,
    )
    return
  }

  if (isOptionalMultiWindowEnvironmentUnready(result)) {
    console.log(
      `[skip] phase4-live-smoke multi-window-compare-summarize-deliver-template environment_unready ${result.summary}`,
    )
    return
  }

  console.log(
    `[skip] phase4-live-smoke multi-window-compare-summarize-deliver-template execution_failed ${result.summary}`,
  )
}

function reportOptionalBrowserExtractTransformPostTemplateScenario(
  result: { ok: boolean; data?: unknown; summary: string },
  expectedTarget: string,
): void {
  if (result.ok) {
    assertVerificationPassed(
      result.data,
      'verification_failed browser extract transform post template verification failed',
    )
    assertOperationPresent(
      result.data,
      'skill.browser.extract_then_transfer',
      'verification_failed browser extract transform post template base chain missing',
    )
    assertEvidencePresent(
      result.data,
      'template=browser-extract-transform-post',
      'verification_failed browser extract transform post template marker missing',
    )
    assertSubmitActionPresent(
      result.data,
      expectedTarget,
      'verification_failed browser extract transform post template submit action missing',
    )
    assertSelectedOrCurrentTarget(
      result.data,
      expectedTarget,
      'verification_failed browser extract transform post template selected unexpected target',
    )
    assertRoutingPolicyDefault(
      result.data,
      'verification_failed browser extract transform post template routing policy mismatch',
    )
    console.log(
      `[pass] phase4-live-smoke browser-extract-transform-post-template -> ${expectedTarget}`,
    )
    return
  }

  if (isOptionalBrowserExtractEnvironmentUnready(result)) {
    console.log(
      `[skip] phase4-live-smoke browser-extract-transform-post-template environment_unready ${result.summary}`,
    )
    return
  }

  console.log(
    `[skip] phase4-live-smoke browser-extract-transform-post-template execution_failed ${result.summary}`,
  )
}

function assertVerificationPassed(data: unknown, errorMessage: string): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    throw new Error(errorMessage)
  }

  if ((verification as { passed?: unknown }).passed !== true) {
    throw new Error(errorMessage)
  }
}

function isOptionalBrowserExtractEnvironmentUnready(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (isOptionalBrowserEnvironmentUnready(result)) {
    return true
  }

  return result.summary.includes('no transferable text was extracted')
}

function isOptionalTransientExecutionFailure(result: {
  ok: boolean
  data?: unknown
  summary: string
}): boolean {
  if (result.ok) {
    return false
  }

  return (
    result.summary.includes('Failed to inspect the browser before transfer.') ||
    result.summary.includes('Failed to stage browser content into') ||
    result.summary.includes('editor chain failed for') ||
    result.summary.includes('Failed to observe primary target Codex.') ||
    result.summary.includes('transfer into Codex failed') ||
    result.summary.includes('delivery into Codex failed') ||
    result.summary.includes('compuser phase4 browser smoke') ||
    result.summary.includes('transfer into 微信 failed') ||
    result.summary.includes('delivery into 微信 failed')
  )
}

function buildTargetEnvironmentDetail(
  baseReason: string,
  snapshot: LiveSmokeTargetSnapshot,
): string {
  const parts = [
    baseReason,
    `browser=${snapshot.browserWindowTitle ?? 'n/a'}`,
    `codex=${snapshot.codexWindowTitle ?? 'n/a'}`,
    `desktopChat=${snapshot.desktopChatWindowTitle ?? 'n/a'}`,
    `editor=${snapshot.editorWindowTitle ?? 'n/a'}`,
    `confirmable=${snapshot.confirmableWindowTitles.join(' | ') || 'none'}`,
  ]

  if (snapshot.ambiguityReasons.length > 0) {
    parts.push(`reasons=${snapshot.ambiguityReasons.join('; ')}`)
  }

  return parts.join(' ; ')
}

function assertOperationPresent(
  data: unknown,
  target: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const operations = (data as { operations?: unknown }).operations
  if (!Array.isArray(operations)) {
    throw new Error(errorMessage)
  }

  const found = operations.some(
    operation =>
      typeof operation === 'object' &&
      operation !== null &&
      (operation as { target?: unknown }).target === target,
  )

  if (!found) {
    throw new Error(errorMessage)
  }
}

function assertEvidencePresent(
  data: unknown,
  marker: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  if (!Array.isArray(evidence)) {
    throw new Error(errorMessage)
  }

  const found = evidence.some(item => typeof item === 'string' && item.includes(marker))
  if (!found) {
    throw new Error(errorMessage)
  }
}

function assertSubmitActionPresent(
  data: unknown,
  expectedTarget: string,
  errorMessage: string,
): void {
  if (!requiresEnterSubmit(expectedTarget)) {
    return
  }

  assertEvidencePresent(data, 'submitAction=enter', errorMessage)
}

function requiresEnterSubmit(targetWindowTitle: string): boolean {
  return /(wechat|weixin|wecom|wxwork|文件传输助手|微信)/i.test(targetWindowTitle)
}

function assertRoutingPolicyDefault(data: unknown, errorMessage: string): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const routingPolicy = (data as { routingPolicy?: unknown }).routingPolicy
  if (
    !Array.isArray(routingPolicy) ||
    routingPolicy.join('|') !==
      ['backend-first', 'browser-dom-first', 'desktop-observe-fallback', 'gui-last'].join('|')
  ) {
    throw new Error(errorMessage)
  }
}

function assertSelectedTarget(
  data: unknown,
  expectedTarget: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) {
    throw new Error(errorMessage)
  }

  if ((output as { selectedWindowTitle?: unknown }).selectedWindowTitle !== expectedTarget) {
    throw new Error(errorMessage)
  }
}

function assertSelectedTargetInSet(
  data: unknown,
  allowedTargets: string[],
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  const chainState = (data as { chainState?: unknown }).chainState
  const directTargetWindowTitle = (data as { targetWindowTitle?: unknown }).targetWindowTitle
  const directCurrentTarget = (data as { currentTarget?: unknown }).currentTarget
  const normalizeTarget = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : undefined
  const expectedTargets = allowedTargets.map(normalizeTarget).filter(Boolean)
  const selectedWindowTitle =
    typeof output === 'object' && output !== null
      ? ((output as { selectedWindowTitle?: unknown }).selectedWindowTitle ??
          (output as { targetWindowTitle?: unknown }).targetWindowTitle)
      : undefined
  const currentTarget =
    typeof chainState === 'object' && chainState !== null
      ? (chainState as { currentTarget?: unknown }).currentTarget
      : undefined

  const candidates = [
    selectedWindowTitle,
    currentTarget,
    directTargetWindowTitle,
    directCurrentTarget,
  ].map(normalizeTarget)

  if (
    expectedTargets.length === 0 ||
    !candidates.some(candidate => candidate && expectedTargets.includes(candidate))
  ) {
    throw new Error(errorMessage)
  }
}

function assertSelectedOrCurrentTarget(
  data: unknown,
  expectedTarget: string,
  errorMessage: string,
): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(errorMessage)
  }

  const output = (data as { output?: unknown }).output
  const chainState = (data as { chainState?: unknown }).chainState
  const directTargetWindowTitle = (data as { targetWindowTitle?: unknown }).targetWindowTitle
  const directCurrentTarget = (data as { currentTarget?: unknown }).currentTarget
  const normalizeTarget = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : undefined
  const expected = normalizeTarget(expectedTarget)
  const selectedWindowTitle =
    typeof output === 'object' && output !== null
      ? ((output as { selectedWindowTitle?: unknown }).selectedWindowTitle ??
          (output as { targetWindowTitle?: unknown }).targetWindowTitle)
      : undefined
  const currentTarget =
    typeof chainState === 'object' && chainState !== null
      ? (chainState as { currentTarget?: unknown }).currentTarget
      : undefined

  const candidates = [
    selectedWindowTitle,
    currentTarget,
    directTargetWindowTitle,
    directCurrentTarget,
  ].map(normalizeTarget)
  if (!expected || !candidates.some(candidate => candidate === expected)) {
    throw new Error(errorMessage)
  }
}

function classifyWindowsSmokeError(error: unknown): Error {
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith('missing_dependency ') ||
      message.startsWith('transport_error ') ||
      message.startsWith('permission_blocked ') ||
      message.startsWith('environment_unready ') ||
      message.startsWith('verification_failed ')
    ) {
      return error
    }
    if (message.includes('TOOL_PERMISSION')) {
      return new Error(`permission_blocked ${message}`)
    }
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('HTTP') ||
      message.includes('fetch')
    ) {
      return new Error(`transport_error ${message}`)
    }
    return new Error(`provider_error ${message}`)
  }

  return new Error(`provider_error ${String(error)}`)
}

function classifyPhase4RuntimeToolError(
  contextMessage: string,
  result: {
    ok: boolean
    summary: string
    error?: string
    failureClass?: string
  },
): Error {
  const detail = result.error?.trim() || result.summary.trim() || contextMessage

  if (result.failureClass === 'missing_dependency') {
    return new Error(`missing_dependency ${contextMessage}: ${detail}`)
  }

  if (detail.includes('TOOL_PERMISSION')) {
    return new Error(`permission_blocked ${contextMessage}: ${detail}`)
  }

  if (
    result.failureClass === 'transient' ||
    detail.includes('ECONNREFUSED') ||
    detail.includes('fetch') ||
    detail.includes('HTTP')
  ) {
    return new Error(`transport_error ${contextMessage}: ${detail}`)
  }

  return new Error(`provider_error ${contextMessage}: ${detail}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const isDirectPhase4LiveSmokeEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectPhase4LiveSmokeEntry) {
  void main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
