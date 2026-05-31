import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import { DEFAULT_WINDOWS_MCP_ENDPOINT } from '../../packages/adapters/windows-mcp/WindowsMcpDefaults.js'
import { StreamableHttpWindowsMcpBridge } from '../../packages/adapters/windows-mcp/StreamableHttpWindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryToolRegistry } from '../../packages/tools/Tool.js'
import { AllowAllPermissionChecker, ToolRuntime } from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'
import { ensureWindowsMcpReady } from './windowsMcpRuntime.js'

async function main(): Promise<void> {
  const windowsMcp = await ensureWindowsMcpReady({
    endpoint: process.env.COMPUSER_WINDOWS_MCP_ENDPOINT ?? DEFAULT_WINDOWS_MCP_ENDPOINT,
    launchIfNeeded: true,
  })

  try {
    const registry = new InMemoryToolRegistry()
    const adapter = new BridgeWindowsMcpAdapter(
      new StreamableHttpWindowsMcpBridge(windowsMcp.endpoint),
    )
    for (const tool of createWindowsMcpTools(adapter)) {
      registry.register(tool)
    }

    const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
    const context = {
      cwd: CLI_WORKSPACE_ROOT,
      sessionId: 'windows-wechat-live-smoke',
      turnId: 'turn-1',
    }
    const softwareFolderPath = `${process.env.USERPROFILE ?? 'C:\\Users\\Gu haipeng'}\\Desktop\\软件`

    const enterWechatProbe = await probe(runtime, context, 'windows.find_element_by_name', {
      name: '\u8fdb\u5165\u5fae\u4fe1',
      windowTitle: '\u5fae\u4fe1',
      matchMode: 'exact',
    })
    const cancelGateProbe = await probe(runtime, context, 'windows.find_element_by_name', {
      name: '\u53d6\u6d88',
      windowTitle: '\u5fae\u4fe1',
      matchMode: 'exact',
    })
    const acknowledgeBeforeLaunch = await probe(
      runtime,
      context,
      'windows.find_element_by_name',
      {
        name: '\u6211\u77e5\u9053\u4e86',
        matchMode: 'exact',
      },
    )

    let launchPath = 'reuse-existing-wechat-state'
    let currentState = 'preflight'
    let nextState = 'unknown'
    let verifiedAnchor = ''
    let recoveryPoint = 'observe:wechat-gate'
    const stableLoginSupport = 'manual_confirmation_required'
    const manualConfirmationScope = 'stable-login'
    const manualConfirmationReason =
      'Stable WeChat login still requires user confirmation on the current machine.'

    if (!enterWechatProbe.ok && !cancelGateProbe.ok && !acknowledgeBeforeLaunch.ok) {
      launchPath = 'desktop-folder-launch'
      currentState = 'desktop'
      const showDesktopShortcut = await run(runtime, context, 'windows.shortcut', {
        shortcut: 'win+d',
      })
      await wait(runtime, context, 1)
      await snapshot(runtime, context)

      await launchSoftwareFolderFromExplorer(runtime, context, softwareFolderPath)
      await wait(runtime, context, 2)
      const focusSoftwareResult = await probe(runtime, context, 'windows.focus_window', {
        windowTitle: '\u8f6f\u4ef6',
      })
      if (!focusSoftwareResult.ok) {
        await launchSoftwareFolderFromExplorer(runtime, context, softwareFolderPath)
        await wait(runtime, context, 2)
      } else {
        await wait(runtime, context, 1)
      }
      const softwareSnapshot = await snapshot(runtime, context)
      verifiedAnchor = softwareSnapshot.summary
      currentState = 'software-opened'
      nextState = 'wechat-launch'
      recoveryPoint = 'focus:软件'

      await run(runtime, context, 'windows.double_click_element_by_name', {
        name: 'Weixin',
        windowTitle: '\u8f6f\u4ef6',
        matchMode: 'exact',
      })
      await wait(runtime, context, 2)
      const weixinLaunchSnapshot = await snapshot(runtime, context)
      verifiedAnchor = weixinLaunchSnapshot.summary
      currentState = 'wechat-launch'
      nextState = 'wechat-gate'
      recoveryPoint = 'focus:微信'
    }

    const acknowledgeBeforeEnter = await probe(runtime, context, 'windows.find_element_by_name', {
      name: '\u6211\u77e5\u9053\u4e86',
      matchMode: 'exact',
    })
    if (acknowledgeBeforeEnter.ok) {
      await run(runtime, context, 'windows.click_element_by_name', {
        name: '\u6211\u77e5\u9053\u4e86',
        matchMode: 'exact',
      })
      await wait(runtime, context, 2)
      currentState = 'wechat-gate'
      nextState = 'wechat-ready'
      recoveryPoint = 'observe:wechat-gate'
    }

    const enterWechatReady = await probe(runtime, context, 'windows.find_element_by_name', {
      name: '\u8fdb\u5165\u5fae\u4fe1',
      windowTitle: '\u5fae\u4fe1',
      matchMode: 'exact',
    })
    if (enterWechatReady.ok) {
      await run(runtime, context, 'windows.click_element_by_name', {
        name: '\u8fdb\u5165\u5fae\u4fe1',
        windowTitle: '\u5fae\u4fe1',
        matchMode: 'exact',
      })
      await wait(runtime, context, 3)
      currentState = 'wechat-ready'
      nextState = 'wechat-main'
      recoveryPoint = 'observe:wechat-ready'
    }

    let afterEnter = await snapshot(runtime, context)

    const acknowledgeProbe = await probe(runtime, context, 'windows.find_element_by_name', {
      name: '\u6211\u77e5\u9053\u4e86',
      matchMode: 'exact',
    })
    if (acknowledgeProbe.ok) {
      await run(runtime, context, 'windows.click_element_by_name', {
        name: '\u6211\u77e5\u9053\u4e86',
        matchMode: 'exact',
      })
      await wait(runtime, context, 2)
      afterEnter = await snapshot(runtime, context)
      verifiedAnchor = afterEnter.summary
      currentState = 'wechat-gate-acknowledged'
      nextState = 'wechat-ready'
    }

    const loginProbe = await probe(runtime, context, 'windows.find_element_by_name', {
      name: '\u767b\u5f55',
      windowTitle: '\u5fae\u4fe1',
      matchMode: 'exact',
    })

    let branch = acknowledgeProbe.ok ? 'acknowledged' : 'entered'
    let finalSummary = afterEnter.summary

    if (loginProbe.ok) {
      branch = acknowledgeProbe.ok ? 'acknowledged-login' : 'login'
      await run(runtime, context, 'windows.click_element_by_name', {
        name: '\u767b\u5f55',
        windowTitle: '\u5fae\u4fe1',
        matchMode: 'exact',
      })
      await wait(runtime, context, 2)
      finalSummary = (await snapshot(runtime, context)).summary
      currentState = 'wechat-login-submitted'
      nextState = 'manual-login-confirmation'
      recoveryPoint = 'observe:wechat-login'
    } else {
      const switchAccountProbe = await probe(
        runtime,
        context,
        'windows.find_element_by_name',
        {
          name: '\u5207\u6362\u8d26\u53f7',
          windowTitle: '\u5fae\u4fe1',
          matchMode: 'exact',
        },
      )

      if (switchAccountProbe.ok) {
        branch = acknowledgeProbe.ok ? 'acknowledged-switch-account' : 'switch-account'
        await run(runtime, context, 'windows.click_element_by_name', {
          name: '\u5207\u6362\u8d26\u53f7',
          windowTitle: '\u5fae\u4fe1',
          matchMode: 'exact',
        })
        await wait(runtime, context, 2)
        finalSummary = (await snapshot(runtime, context)).summary
        currentState = 'wechat-switch-account'
        nextState = 'wechat-login'
        recoveryPoint = 'observe:wechat-switch-account'
      } else {
        const cancelProbe = await probe(runtime, context, 'windows.find_element_by_name', {
          name: '\u53d6\u6d88',
          windowTitle: '\u5fae\u4fe1',
          matchMode: 'exact',
        })

        if (cancelProbe.ok) {
          branch = acknowledgeProbe.ok ? 'acknowledged-cancel-gate' : 'cancel-gate'
          currentState = 'wechat-gate'
          nextState = 'wechat-ready'
          recoveryPoint = 'observe:wechat-gate'
        } else {
          branch = acknowledgeProbe.ok
            ? 'acknowledged-manual-confirmation-required'
            : 'manual-confirmation-required'
          currentState = 'wechat-manual-confirmation-required'
          nextState = 'manual-login-confirmation'
          recoveryPoint = 'observe:wechat-gate'
        }
      }
    }

    const gateSignals = collectWeChatGateSignals([
      afterEnter.summary,
      finalSummary,
      verifiedAnchor,
    ])
    const environmentStatus = classifyWeChatEnvironmentStatus({
      currentState,
      gateSignals,
      finalSummary,
    })

    console.log(
      JSON.stringify(
        {
          launchPath,
          currentState,
          nextState,
          verifiedAnchor,
          recoveryPoint,
          stableLoginSupport,
          manualConfirmationRequired: true,
          manualConfirmationScope,
          manualConfirmationReason,
          environmentStatus,
          gateSignals,
          afterEnterSummary: afterEnter.summary,
          branch,
          acknowledgeResult: acknowledgeProbe,
          enterWechatReady,
          loginProbe,
          finalSummary,
        },
        null,
        2,
      ),
    )
  } finally {
    await windowsMcp.dispose()
  }
}

async function run(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; summary: string }> {
  const result = await runtime.execute({ toolName, input }, context)
  assert(result.ok, `verification_failed ${toolName} failed: ${result.summary}`)
  return { ok: result.ok, summary: result.summary }
}

async function probe(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; summary: string }> {
  const result = await runtime.execute({ toolName, input }, context)
  return { ok: result.ok, summary: result.summary }
}

async function wait(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  durationSeconds: number,
): Promise<void> {
  const result = await runtime.execute(
    { toolName: 'windows.wait', input: { durationSeconds } },
    context,
  )
  assert(result.ok, `verification_failed wait failed: ${result.summary}`)
}

async function snapshot(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
): Promise<{ summary: string }> {
  const result = await runtime.execute(
    { toolName: 'windows.snapshot', input: {} },
    context,
  )
  assert(result.ok, `verification_failed snapshot failed: ${result.summary}`)
  return { summary: result.summary }
}

function collectWeChatGateSignals(summaries: Array<string | undefined>): string[] {
  const combined = summaries.filter((value): value is string => typeof value === 'string').join('\n')
  const signals: string[] = []

  if (combined.includes('二维码')) {
    signals.push('qrcode_gate')
  }
  if (combined.includes('仅传输文件')) {
    signals.push('file_transfer_only')
  }
  if (combined.includes('网络代理设置')) {
    signals.push('proxy_settings')
  }
  if (combined.includes('网络不可用')) {
    signals.push('network_unavailable')
  }
  if (combined.includes('窗口身份不明确')) {
    signals.push('window_identity_ambiguous')
  }
  if (combined.includes('我知道了') || combined.includes('进入微信') || combined.includes('登录')) {
    signals.push('manual_confirmation_prompt')
  }

  return [...new Set(signals)]
}

function classifyWeChatEnvironmentStatus(input: {
  currentState: string
  gateSignals: string[]
  finalSummary: string
}): 'manual_confirmation_required' | 'environment_unready' | 'ready' {
  if (
    input.gateSignals.includes('network_unavailable') ||
    input.gateSignals.includes('window_identity_ambiguous')
  ) {
    return 'environment_unready'
  }

  if (
    input.currentState === 'wechat-manual-confirmation-required' ||
    input.currentState === 'wechat-login-submitted' ||
    input.currentState === 'wechat-gate-acknowledged' ||
    input.gateSignals.includes('qrcode_gate') ||
    input.gateSignals.includes('file_transfer_only') ||
    input.gateSignals.includes('proxy_settings') ||
    input.gateSignals.includes('manual_confirmation_prompt') ||
    input.finalSummary.includes('微信')
  ) {
    return 'manual_confirmation_required'
  }

  return 'ready'
}

async function launchSoftwareFolderFromExplorer(
  runtime: ToolRuntime,
  context: {
    cwd: string
    sessionId: string
    turnId: string
  },
  softwareFolderPath: string,
): Promise<void> {
  const result = await runtime.execute(
    {
      toolName: 'windows.shell',
      input: {
        command: `Start-Process explorer.exe '${softwareFolderPath.replace(/'/g, "''")}'`,
      },
    },
    context,
  )
  assert(result.ok, `verification_failed explorer launch failed: ${result.summary}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
