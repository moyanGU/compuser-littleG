import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import { BridgeWindowsMcpAdapter } from '../../packages/adapters/windows-mcp/WindowsMcpAdapter.js'
import type { WindowsMcpBridge } from '../../packages/adapters/windows-mcp/WindowsMcpBridge.js'
import { createWindowsMcpTools } from '../../packages/adapters/windows-mcp/WindowsTools.js'
import { InMemoryToolRegistry } from '../../packages/tools/Tool.js'
import {
  AllowAllPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'

async function main(): Promise<void> {
  await verifyWindowsToolNormalization()
  await verifyWindowsLabelToolNormalization()
  await verifyWindowsNamedElementToolNormalization()
  await verifyWindowsNamedElementAliasNormalization()
  await verifyWindowsTypeUsesStableInputAnchor()
  await verifyWindowsAppListMode()
  await verifyWindowsAppListModeUnsupportedFails()
  await verifyWindowsFocusActionVerificationFields()
  await verifyWindowsAppActionVerificationFields()
  await verifyBrowserDomCapability()
  await verifyOpenObserveActVerifyCapability()
  await verifyBrowserDomLowConfidenceFailsVerification()
  await verifyOpenObserveActVerifyRequiresTargetMatch()
  await verifyOpenOrFocusRequiresTargetConfirmation()
  await verifyOpenOrFocusRequiresLaunchConfirmation()
  await verifyOpenOrFocusShellRecoveryRequiresVerification()
  await verifyClipboardSetRequiresReadbackVerification()
  await verifyClipboardGetRequiresTextConfirmation()
  await verifyCrossAppTransferRequiresVerification()
  await verifyCrossAppTransferPasteRequiresVerification()
  await verifyCrossAppTransferUsesBrowserAddressBarForBrowserTargets()
  await verifySendFileToChatWindowSucceedsForWeChat()
  await verifySendFileToChatWindowRejectsUnsupportedTarget()
  await verifyCaptureAndLocateRequiresQueryMatch()
  await verifyCaptureAndLocateMatchesLocalizedNotepadAlias()
  console.log('Windows Phase 1 regression passed: 21/21')
}

async function verifyWindowsToolNormalization(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Scroll: {
      ok: true,
      summary: 'scroll ok',
    },
    Move: {
      ok: true,
      summary: 'move ok',
    },
    Notification: {
      ok: true,
      summary: 'notification ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const scroll = await runtime.execute(
    {
      toolName: 'windows.scroll',
      input: {
        direction: 'down',
        amount: 2,
      },
    },
    createToolContext(),
  )
  assert(scroll.ok, 'windows.scroll should succeed')

  const move = await runtime.execute(
    {
      toolName: 'windows.move_or_drag',
      input: {
        x: 120,
        y: 240,
        drag: false,
      },
    },
    createToolContext(),
  )
  assert(move.ok, 'windows.move_or_drag should succeed')

  const notification = await runtime.execute(
    {
      toolName: 'windows.notification',
      input: {
        title: 'Phase 1',
        message: 'notification smoke',
      },
    },
    createToolContext(),
  )
  assert(notification.ok, 'windows.notification should succeed')
}

async function verifyWindowsLabelToolNormalization(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Click: {
      ok: true,
      summary: 'click label ok',
    },
    Type: {
      ok: true,
      summary: 'type label ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const click = await runtime.execute(
    {
      toolName: 'windows.click_label',
      input: {
        label: 12,
      },
    },
    createToolContext(),
  )
  assert(click.ok, 'windows.click_label should succeed')

  const doubleClick = await runtime.execute(
    {
      toolName: 'windows.double_click_label',
      input: {
        label: 13,
      },
    },
    createToolContext(),
  )
  assert(doubleClick.ok, 'windows.double_click_label should succeed')

  const type = await runtime.execute(
    {
      toolName: 'windows.type_label',
      input: {
        label: 14,
        text: 'hello',
        clear: true,
        pressEnter: true,
      },
    },
    createToolContext(),
  )
  assert(type.ok, 'windows.type_label should succeed')

  const clickCalls = bridge.calls.filter(call => call.toolName === 'Click')
  assert(clickCalls.length === 2, 'label click tools should call Click twice')
  assert(
    clickCalls[0]?.args.label === 12 && clickCalls[0]?.args.clicks === 1,
    'windows.click_label should pass label and single click',
  )
  assert(
    clickCalls[1]?.args.label === 13 && clickCalls[1]?.args.clicks === 2,
    'windows.double_click_label should pass label and double clicks',
  )

  const typeCall = bridge.calls.find(call => call.toolName === 'Type')
  assert(typeCall?.args.label === 14, 'windows.type_label should pass label to Type')
  assert(typeCall?.args.text === 'hello', 'windows.type_label should pass text to Type')
  assert(typeCall?.args.clear === true, 'windows.type_label should pass clear flag')
  assert(
    typeCall?.args.press_enter === true,
    'windows.type_label should pass press_enter flag',
  )
}

async function verifyWindowsNamedElementToolNormalization(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: `Focused Window:
WeChat
Opened Windows:
WeChat
List of Interactive Elements:
# id|window|control_type|name|coords|metadata
7|Desktop|ListItem|Software|[100,100,180,132]|
12|Desktop|Button|WeChat|[210,100,278,132]|
18|WeChat|Button|Login|[420,620,520,658]|
21|WeChat|Edit|Phone|[380,520,560,550]|
UI Tree:
Button "Login"`,
    Click: {
      ok: true,
      summary: 'click named element ok',
    },
    Type: {
      ok: true,
      summary: 'type named element ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const findResult = await runtime.execute(
    {
      toolName: 'windows.find_element_by_name',
      input: {
        name: 'Login',
        windowTitle: 'WeChat',
      },
    },
    createToolContext(),
  )
  assert(findResult.ok, 'windows.find_element_by_name should find matching element')
  const foundElement = (findResult.data as {
    element?: { label?: number; controlType?: string; window?: string }
  }).element
  assert(foundElement?.label === 18, 'windows.find_element_by_name should return matched label')
  assert(foundElement?.controlType === 'Button', 'windows.find_element_by_name should preserve controlType')
  assert(foundElement?.window === 'WeChat', 'windows.find_element_by_name should preserve window title')

  const clickResult = await runtime.execute(
    {
      toolName: 'windows.click_element_by_name',
      input: {
        name: 'WeChat',
        windowTitle: 'Desktop',
        matchMode: 'exact',
      },
    },
    createToolContext(),
  )
  assert(clickResult.ok, 'windows.click_element_by_name should click matching element')
  const clickAction = clickResult.data as {
    verification?: { passed?: boolean }
    currentState?: string
    nextState?: string
    verifiedAnchor?: string
    recoveryPoint?: string
  }
  assert(
    clickAction.verification?.passed === true,
    'windows.click_element_by_name should verify post-action state',
  )
  assert(
    typeof clickAction.currentState === 'string' &&
      typeof clickAction.nextState === 'string' &&
      typeof clickAction.verifiedAnchor === 'string' &&
      typeof clickAction.recoveryPoint === 'string',
    'windows.click_element_by_name should expose transition fields',
  )

  const doubleClickResult = await runtime.execute(
    {
      toolName: 'windows.double_click_element_by_name',
      input: {
        name: 'Software',
        windowTitle: 'Desktop',
      },
    },
    createToolContext(),
  )
  assert(
    doubleClickResult.ok,
    'windows.double_click_element_by_name should double click matching element',
  )
  const doubleClickAction = doubleClickResult.data as {
    verification?: { passed?: boolean }
    currentState?: string
    nextState?: string
    verifiedAnchor?: string
    recoveryPoint?: string
  }
  assert(
    doubleClickAction.verification?.passed === true,
    'windows.double_click_element_by_name should verify post-action state',
  )
  assert(
    typeof doubleClickAction.currentState === 'string' &&
      typeof doubleClickAction.nextState === 'string' &&
      typeof doubleClickAction.verifiedAnchor === 'string' &&
      typeof doubleClickAction.recoveryPoint === 'string',
    'windows.double_click_element_by_name should expose transition fields',
  )

  const typeResult = await runtime.execute(
    {
      toolName: 'windows.type_element_by_name',
      input: {
        name: 'Phone',
        windowTitle: 'WeChat',
        text: '13800138000',
        clear: true,
      },
    },
    createToolContext(),
  )
  assert(typeResult.ok, 'windows.type_element_by_name should type into matching element')
  const typeAction = typeResult.data as {
    verification?: { passed?: boolean }
    currentState?: string
    nextState?: string
    verifiedAnchor?: string
    recoveryPoint?: string
  }
  assert(
    typeAction.verification?.passed === true,
    'windows.type_element_by_name should verify post-action state',
  )
  assert(
    typeof typeAction.currentState === 'string' &&
      typeof typeAction.nextState === 'string' &&
      typeof typeAction.verifiedAnchor === 'string' &&
      typeof typeAction.recoveryPoint === 'string',
    'windows.type_element_by_name should expose transition fields',
  )

  const clickCalls = bridge.calls.filter(call => call.toolName === 'Click')
  assert(clickCalls.length === 2, 'named element click tools should call Click twice')
  assert(
    clickCalls[0]?.args.label === 12 && clickCalls[0]?.args.clicks === 1,
    'windows.click_element_by_name should resolve matching label and single click',
  )
  assert(
    clickCalls[1]?.args.label === 7 && clickCalls[1]?.args.clicks === 2,
    'windows.double_click_element_by_name should resolve matching label and double click',
  )

  const typeCall = bridge.calls.find(call => call.toolName === 'Type')
  assert(typeCall?.args.label === 21, 'windows.type_element_by_name should resolve matching label')
  assert(
    typeCall?.args.text === '13800138000',
    'windows.type_element_by_name should pass the requested text',
  )
  assert(
    typeCall?.args.clear === true,
    'windows.type_element_by_name should pass through clear flag',
  )
}

async function verifyWindowsNamedElementAliasNormalization(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: `Focused Window:
软件
Opened Windows:
桌面
软件
WeChat
List of Interactive Elements:
# id|window|control_type|name|coords|metadata
3|桌面|ListItem|软件|[10,10,80,42]|
4|软件|ListItem|Weixin|[120,10,220,42]|
5|Weixin|Button|进入微信|[300,500,420,540]|
6|Weixin|Button|登录|[440,500,520,540]|
UI Tree:
ListItem "软件"
Button "进入微信"
Button "登录"`,
    Click: {
      ok: true,
      summary: 'click alias element ok',
    },
    Type: {
      ok: true,
      summary: 'type alias element ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const softwareResult = await runtime.execute(
    {
      toolName: 'windows.find_element_by_name',
      input: {
        name: '软件',
        matchMode: 'exact',
      },
    },
    createToolContext(),
  )
  assert(softwareResult.ok, 'windows.find_element_by_name should find 软件')

  const weixinResult = await runtime.execute(
    {
      toolName: 'windows.find_element_by_name',
      input: {
        name: '微信',
        windowTitle: '软件',
        matchMode: 'exact',
      },
    },
    createToolContext(),
  )
  assert(weixinResult.ok, 'windows.find_element_by_name should match Weixin alias for 微信')

  const enterWechatResult = await runtime.execute(
    {
      toolName: 'windows.click_element_by_name',
      input: {
        name: '进入微信',
        windowTitle: 'Weixin',
        matchMode: 'exact',
      },
    },
    createToolContext(),
  )
  assert(enterWechatResult.ok, 'windows.click_element_by_name should click 进入微信 alias')

  const loginResult = await runtime.execute(
    {
      toolName: 'windows.find_element_by_name',
      input: {
        name: '登录',
        windowTitle: 'Weixin',
        matchMode: 'exact',
      },
    },
    createToolContext(),
  )
  assert(loginResult.ok, 'windows.find_element_by_name should find 登录')
}

async function verifyWindowsTypeUsesStableInputAnchor(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: `Focused Window:
无标�?- 记事�?Opened Windows:
无标�?- 记事�?List of Interactive Elements:
# id|window|control_type|name|coords|metadata
1|无标�?- 记事本|Edit|编辑|[120,120,380,160]|
UI Tree:
Edit "编辑" [action: click]`,
    Type: {
      ok: true,
      summary: 'type stable input anchor ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const typeResult = await runtime.execute(
    {
      toolName: 'windows.type',
      input: {
        text: 'hello',
      },
    },
    createToolContext(),
  )
  assert(typeResult.ok, 'windows.type should use a stable input anchor')

  const typeCall = bridge.calls.find(call => call.toolName === 'Type')
  assert(
    typeCall?.args.label === 1 || Array.isArray(typeCall?.args.loc),
    'windows.type should call Type with label or loc',
  )
  assert(
    typeCall?.args.text === 'hello',
    'windows.type should pass the requested text',
  )
}

async function verifyBrowserDomCapability(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: {
      summary: 'dom snapshot ok',
      windows: ['Browser'],
      focusedWindow: 'Browser',
      dom: {
        nodes: 3,
      },
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.browser.inspect_dom',
      input: {},
    },
    createToolContext(),
  )
  assert(result.ok, 'browser DOM capability should succeed')
  const route = (result.data as { route?: string }).route
  assert(route === 'tool', 'browser DOM capability should use tool route')
  const verification = (result.data as {
    verification?: { passed?: boolean }
  }).verification
  assert(verification?.passed === true, 'browser DOM capability should include successful verification')
  const output = result.data as {
    output?: {
      observation?: {
        observationMode?: string
        anchors?: string[]
        confidence?: number
      }
    }
  }
  assert(
    output.output?.observation?.observationMode === 'dom',
    'browser DOM capability should preserve DOM observation mode',
  )
  assert(
    (output.output?.observation?.anchors?.length ?? 0) > 0,
    'browser DOM capability should surface observation anchors',
  )
}

async function verifyWindowsAppListMode(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'listed app windows',
      raw: {
        windows: ['Notepad', 'Browser'],
      },
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const result = await runtime.execute(
    {
      toolName: 'windows.app',
      input: {
        mode: 'list',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'windows.app list should succeed')
  assert(result.summary.includes('listed app windows'), 'windows.app list should preserve summary')
}

async function verifyWindowsAppListModeUnsupportedFails(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: false,
      summary: 'mode not supported',
      error: 'Input should be \'launch\', \'resize\' or \'switch\'',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const result = await runtime.execute(
    {
      toolName: 'windows.app',
      input: {
        mode: 'list',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'windows.app unsupported list mode should fail')
  assert(
    result.failureClass === 'missing_dependency',
    'windows.app unsupported list mode should surface missing_dependency',
  )
  assert(
    result.summary.includes('Windows-MCP does not support app list mode.'),
    'windows.app unsupported list mode should report explicit failure',
  )
}

async function verifyWindowsFocusActionVerificationFields(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'focus ok',
    },
    Snapshot: {
      summary: 'snapshot ok',
      windows: ['Notepad'],
      focusedWindow: 'Notepad',
      anchors: ['Notepad'],
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const result = await runtime.execute(
    {
      toolName: 'windows.focus_window',
      input: {
        windowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'windows.focus_window should succeed')
  const data = result.data as {
    currentState?: string
    nextState?: string
    verifiedAnchor?: string
    recoveryPoint?: string
    verification?: { passed?: boolean }
  }
  assert(data.verification?.passed === true, 'windows.focus_window should verify post-action state')
  assert(
    typeof data.currentState === 'string' &&
      typeof data.nextState === 'string' &&
      typeof data.verifiedAnchor === 'string' &&
      typeof data.recoveryPoint === 'string',
    'windows.focus_window should expose transition fields',
  )
}

async function verifyWindowsAppActionVerificationFields(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'snapshot ok',
      windows: ['Calculator'],
      focusedWindow: 'Calculator',
      anchors: ['Calculator'],
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())

  const result = await runtime.execute(
    {
      toolName: 'windows.app',
      input: {
        mode: 'switch',
        name: 'Calculator',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'windows.app switch should succeed')
  const data = result.data as {
    currentState?: string
    nextState?: string
    verifiedAnchor?: string
    recoveryPoint?: string
    verification?: { passed?: boolean }
  }
  assert(data.verification?.passed === true, 'windows.app switch should verify post-action state')
  assert(
    typeof data.currentState === 'string' &&
      typeof data.nextState === 'string' &&
      typeof data.verifiedAnchor === 'string' &&
      typeof data.recoveryPoint === 'string',
    'windows.app switch should expose transition fields',
  )
}

async function verifyOpenObserveActVerifyCapability(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'snapshot ok',
      windows: ['Notepad'],
      focusedWindow: 'Notepad',
      interactiveElements: [
        {
          label: 1,
          window: 'Notepad',
          controlType: 'Edit',
          name: '编辑',
          coords: '[120,120,380,160]',
        },
      ],
    },
    Clipboard: [
      {
        ok: true,
        summary: 'clipboard set ok',
        raw: {
          text: 'hello from regression',
        },
      },
      {
        ok: true,
        summary: 'clipboard get ok',
        raw: {
          text: 'hello from regression',
        },
      },
    ],
    Shortcut: {
      ok: true,
      summary: 'shortcut ok',
    },
    Screenshot: {
      summary: 'screenshot ok',
      windows: ['Notepad'],
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.open_observe_act_verify',
      input: {
        appName: 'Notepad',
        text: 'hello from regression',
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )
  assert(result.ok, 'open/observe/act/verify capability should succeed')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(verification?.passed === true, 'capability should verify success')
  const audit = result.data as {
    operations?: Array<{ target?: string }>
    recoveryUsed?: boolean
  }
  const operationTargets = (audit.operations ?? []).map(item => item.target)
  assert(
    operationTargets.includes('command.app.open_or_focus') &&
      operationTargets.includes('command.desktop.capture_and_locate') &&
      operationTargets.includes('skill.cross_app.transfer_text') &&
      operationTargets.includes('skill.desktop.observe'),
    'open/observe/act/verify capability should expose all four GUI stages in operations',
  )
  assert(audit.recoveryUsed === false, 'happy path should not mark recoveryUsed')
}
async function verifyBrowserDomLowConfidenceFailsVerification(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: {
      summary: 'dom snapshot too weak',
      windows: [],
      focusedWindow: undefined,
      dom: {
        nodes: 1,
      },
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.browser.inspect_dom',
      input: {},
    },
    createToolContext(),
  )

  assert(!result.ok, 'browser DOM capability should fail when observation confidence is too low')
  const verification = (result.data as {
    verification?: { passed?: boolean }
    chainState?: { chainStatus?: string }
  }).verification
  assert(verification?.passed === false, 'low-confidence browser observation should fail verification')
  const recoveryPoint = (result.data as { recoveryPoint?: string }).recoveryPoint
  assert(
    typeof recoveryPoint === 'string' && recoveryPoint.length > 0,
    'low-confidence browser observation should expose a recovery point',
  )
  const chainState = (result.data as {
    chainState?: { chainStatus?: string }
  }).chainState
  assert(
    chainState?.chainStatus === 'verified_failed',
    'low-confidence browser observation should be marked verified_failed',
  )
}

async function verifyOpenObserveActVerifyRequiresTargetMatch(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'snapshot ok',
      windows: ['WrongApp'],
      focusedWindow: 'WrongApp',
    },
    Clipboard: {
      ok: true,
      summary: 'clipboard ok',
    },
    Shortcut: {
      ok: true,
      summary: 'shortcut ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.open_observe_act_verify',
      input: {
        appName: 'Notepad',
        text: 'hello from regression',
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'open/observe/act/verify should fail when verification misses the target window')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
    chainState?: { chainStatus?: string }
  }).verification)
  assert(
    verification?.passed === false,
    'open/observe/act/verify should fail verification when target window is not observed',
  )
  const operations = ((result.data as {
    operations?: Array<{ target?: string; ok?: boolean }>
  }).operations) ?? []
  assert(
    operations.length === 1 &&
      operations[0]?.target === 'command.app.open_or_focus' &&
      operations[0]?.ok === false,
    'open/observe/act/verify target mismatch should now fail at the focus confirmation stage',
  )
}

async function verifyOpenOrFocusRequiresTargetConfirmation(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'snapshot mismatch',
      windows: ['Codex'],
      focusedWindow: 'Codex',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.app.open_or_focus',
      input: {
        appName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'open_or_focus should fail when target confirmation does not match')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'open_or_focus should fail verification when target confirmation is missing',
  )
}

async function verifyOpenOrFocusRequiresLaunchConfirmation(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'launch ok',
    },
    Snapshot: {
      summary: 'launch mismatch',
      windows: ['Codex'],
      focusedWindow: 'Codex',
    },
    Wait: {
      ok: true,
      summary: 'wait ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.app.open_or_focus',
      input: {
        appName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'open_or_focus should fail when launch is not confirmed afterward')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'open_or_focus should fail verification when launch confirmation is missing',
  )
  assert(
    result.failureClass === 'deterministic',
    'open_or_focus launch confirmation failure should be deterministic',
  )
}

async function verifyOpenOrFocusShellRecoveryRequiresVerification(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: false,
      summary: 'focus failed',
    },
    Shell: {
      ok: true,
      summary: 'shell launch ok',
    },
    Focus: {
      ok: true,
      summary: 'focus ok',
    },
    Snapshot: {
      summary: 'shell recovery mismatch',
      windows: ['Codex'],
      focusedWindow: 'Codex',
    },
    Wait: {
      ok: true,
      summary: 'wait ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.app.open_or_focus',
      input: {
        appName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'open_or_focus should fail when shell recovery is not verified')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'open_or_focus should fail verification when shell recovery confirmation is missing',
  )
}

async function verifyClipboardSetRequiresReadbackVerification(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Clipboard: {
      ok: true,
      summary: 'clipboard set ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.clipboard.read_write',
      input: {
        mode: 'set',
        text: 'hello',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'clipboard set should fail when read-back verification is missing')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'clipboard set should fail verification when read-back does not match',
  )
}

async function verifyClipboardGetRequiresTextConfirmation(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Clipboard: {
      ok: true,
      summary: 'clipboard get ok',
      raw: {},
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.clipboard.read_write',
      input: {
        mode: 'get',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'clipboard get should fail when no text is confirmed')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'clipboard get should fail verification when no text is read back',
  )
}

async function verifyCrossAppTransferRequiresVerification(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'snapshot mismatch',
      windows: ['Codex'],
      focusedWindow: 'Codex',
    },
    Clipboard: {
      ok: false,
      summary: 'clipboard unavailable',
      error: 'clipboard unavailable',
    },
    Type: {
      ok: true,
      summary: 'type ok',
    },
    Wait: {
      ok: true,
      summary: 'wait ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.transfer_text',
      input: {
        text: 'hello',
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'transfer_text should fail when typed text is not verified')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'transfer_text should fail verification when target confirmation is missing',
  )
  assert(
    result.failureClass === 'deterministic',
    'transfer_text verification failure should be deterministic',
  )
}

async function verifyCrossAppTransferPasteRequiresVerification(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'paste mismatch',
      windows: ['Codex'],
      focusedWindow: 'Codex',
    },
    Clipboard: {
      ok: true,
      summary: 'clipboard ok',
    },
    Shortcut: {
      ok: true,
      summary: 'shortcut ok',
    },
    Wait: {
      ok: true,
      summary: 'wait ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.transfer_text',
      input: {
        text: 'hello',
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'transfer_text should fail when clipboard paste is not verified')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === false,
    'transfer_text should fail verification when clipboard paste target confirmation is missing',
  )
}

async function verifyCrossAppTransferUsesBrowserAddressBarForBrowserTargets(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    App: {
      ok: true,
      summary: 'app ok',
    },
    Snapshot: {
      summary: 'browser snapshot',
      windows: ['Microsoft Edge'],
      focusedWindow: 'Microsoft Edge',
      anchors: ['Microsoft Edge'],
      confidence: 1,
    },
    Clipboard: [
      {
        ok: true,
        summary: 'clipboard set ok',
        raw: {
          text: 'https://example.com',
        },
      },
      {
        ok: true,
        summary: 'clipboard get ok',
        raw: {
          text: 'https://example.com',
        },
      },
    ],
    Shortcut: {
      ok: true,
      summary: 'shortcut ok',
    },
    Wait: {
      ok: true,
      summary: 'wait ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.transfer_text',
      input: {
        text: 'https://example.com',
        targetWindowTitle: 'Microsoft Edge',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'transfer_text should succeed for browser targets')
  const shortcuts = bridge.calls
    .filter(call => call.toolName === 'Shortcut')
    .map(call => call.args.shortcut)
  assert(
    shortcuts[0] === 'ctrl+l',
    'browser transfer should first focus the address bar with ctrl+l',
  )
  assert(
    shortcuts.includes('ctrl+v'),
    'browser transfer should still paste the clipboard payload',
  )
}

async function verifySendFileToChatWindowSucceedsForWeChat(): Promise<void> {
  const wechatSnapshot = {
    windows: ['WeChat'],
    focusedWindow: 'WeChat',
    anchors: ['WeChat'],
    confidence: 1,
    interactiveElements: [
      {
        label: 11,
        window: 'WeChat',
        controlType: 'Button',
        name: 'Upload File',
      },
    ],
  }
  const openDialogSnapshot = {
    windows: ['Open'],
    focusedWindow: 'Open',
    anchors: ['Open'],
    confidence: 1,
    interactiveElements: [
      {
        label: 21,
        window: 'Open',
        controlType: 'Edit',
        name: 'File name',
      },
      {
        label: 22,
        window: 'Open',
        controlType: 'Button',
        name: 'Open',
      },
    ],
  }
  const bridge = new FixtureWindowsBridge({
    FileSystem: {
      ok: true,
      summary: 'file info ok',
      raw: {
        path: 'C:\\Users\\me\\Videos\\clip.mp4',
        exists: true,
      },
    },
    App: {
      ok: true,
      summary: 'focus wechat ok',
    },
    Snapshot: [
      {
        summary: 'before focus wechat',
        ...wechatSnapshot,
      },
      {
        summary: 'after focus wechat',
        ...wechatSnapshot,
      },
      {
        summary: 'verify wechat available',
        ...wechatSnapshot,
      },
      {
        summary: 'before click upload file',
        ...wechatSnapshot,
      },
      {
        summary: 'after click upload file',
        ...openDialogSnapshot,
      },
      {
        summary: 'before wait after click',
        ...openDialogSnapshot,
      },
      {
        summary: 'snapshot after wait before type lookup',
        ...openDialogSnapshot,
      },
      {
        summary: 'before type file path',
        ...openDialogSnapshot,
      },
      {
        summary: 'after type file path',
        ...openDialogSnapshot,
      },
      {
        summary: 'before click open button',
        ...openDialogSnapshot,
      },
      {
        summary: 'after click open button',
        ...openDialogSnapshot,
      },
      {
        summary: 'before final wait',
        ...openDialogSnapshot,
      },
      {
        summary: 'after open click verification',
        ...openDialogSnapshot,
      },
      {
        summary: 'wechat returned after open click',
        windows: ['WeChat'],
        focusedWindow: 'WeChat',
        anchors: ['WeChat'],
        confidence: 1,
      },
      {
        summary: 'wechat attachment ready',
        windows: ['WeChat'],
        focusedWindow: 'WeChat',
        anchors: ['WeChat', 'clip.mp4'],
        confidence: 1,
        domSummary: 'clip.mp4 attached',
      },
      {
        summary: 'wechat attachment verified',
        windows: ['WeChat'],
        focusedWindow: 'WeChat',
        anchors: ['WeChat', 'clip.mp4'],
        confidence: 1,
        domSummary: 'clip.mp4 attached',
      },
    ],
    Click: {
      ok: true,
      summary: 'click ok',
    },
    Type: {
      ok: true,
      summary: 'type ok',
    },
    Shortcut: {
      ok: true,
      summary: 'shortcut ok',
    },
    Wait: {
      ok: true,
      summary: 'wait ok',
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.file.send_to_chat_window',
      input: {
        path: 'C:\\Users\\me\\Videos\\clip.mp4',
        targetWindowTitle: 'WeChat',
        send: true,
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'send_to_chat_window should succeed for WeChat attachment flow')
  const resultEnvelope = result as {
    output?: { attached?: boolean; sent?: boolean; fileName?: string }
    data?: unknown
  }
  const output = resultEnvelope.output
  const verification = (resultEnvelope.data as {
    verification?: { passed?: boolean }
  }).verification
  assert(
    output?.attached === true && output?.sent === true,
    'send_to_chat_window should mark the file as attached and sent',
  )
  assert(
    output?.fileName === 'clip.mp4',
    'send_to_chat_window should preserve the attached file name',
  )
  assert(
    verification?.passed === true,
    'send_to_chat_window should verify the WeChat attachment result',
  )

  const filesystemCall = bridge.calls.find(call => call.toolName === 'FileSystem')
  assert(
    filesystemCall?.args.mode === 'info' &&
      filesystemCall?.args.path === 'C:\\Users\\me\\Videos\\clip.mp4',
    'send_to_chat_window should inspect the requested file path before attaching it',
  )
  const typeCall = bridge.calls.find(call => call.toolName === 'Type')
  assert(
    typeCall?.args.label === 21 &&
      typeCall?.args.text === 'C:\\Users\\me\\Videos\\clip.mp4',
    'send_to_chat_window should type the absolute path into the file dialog input',
  )
  const shortcuts = bridge.calls
    .filter(call => call.toolName === 'Shortcut')
    .map(call => call.args.shortcut)
  assert(
    shortcuts.includes('enter'),
    'send_to_chat_window should send the attached file when send=true',
  )
}

async function verifySendFileToChatWindowFallsBackToExplorerPicker(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: {
      summary: 'explorer picker fallback',
      windows: ['微信'],
      focusedWindow: '微信',
      anchors: ['微信', '文件资源管理器', '地址', 'clip.mp4'],
      interactiveElements: [
        { controlType: '按钮', name: '文件', x: 10, y: 10, metadata: 'action: click' },
        { controlType: '编辑', name: '地址', x: 20, y: 20, metadata: 'action: click' },
        { controlType: '列表项目', name: 'clip.mp4', x: 30, y: 30, metadata: 'action: click' },
      ],
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.file.send_to_chat_window',
      input: {
        path: 'E:\\compuser\\compuser\\tmp\\wechat-send\\clip.mp4',
        targetWindowTitle: '微信',
        send: true,
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'send_to_chat_window should support explorer-style picker fallback')
  const typeCalls = bridge.calls.filter(call => call.toolName === 'Type')
  assert(
    typeCalls.some(
      call =>
        call.args.text === 'E:\\compuser\\compuser\\tmp\\wechat-send' &&
        (call.args.label === 20 || call.args.label === 21),
    ),
    'send_to_chat_window fallback should type the parent directory into the explorer address bar',
  )
  const clickCalls = bridge.calls.filter(call => call.toolName === 'Click')
  assert(
    clickCalls.some(call => call.args.label === 30),
    'send_to_chat_window fallback should select the requested file in explorer picker',
  )
}

async function verifySendFileToChatWindowRejectsUnsupportedTarget(): Promise<void> {
  const bridge = new FixtureWindowsBridge({})
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'skill.file.send_to_chat_window',
      input: {
        path: 'C:\\Users\\me\\Videos\\clip.mp4',
        targetWindowTitle: 'Slack',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'send_to_chat_window should reject unsupported non-WeChat targets')
  const verification = (result.data as {
    verification?: { passed?: boolean }
  }).verification
  assert(
    verification?.passed === false,
    'send_to_chat_window should fail verification for unsupported targets',
  )
  assert(
    bridge.calls.length === 0,
    'send_to_chat_window should fail fast before invoking tools for unsupported targets',
  )
}

async function verifyCaptureAndLocateRequiresQueryMatch(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: {
      summary: 'snapshot mismatch',
      windows: ['Codex'],
      focusedWindow: 'Codex',
      anchors: ['Codex'],
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.desktop.capture_and_locate',
      input: {
        query: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'capture_and_locate should fail when observation does not match query')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
    chainState?: { chainStatus?: string }
  }).verification)
  assert(
    verification?.passed === false,
    'capture_and_locate should fail verification when query does not match observation',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: string }).recoveryPoint
  assert(
    typeof recoveryPoint === 'string' && recoveryPoint.startsWith('focus:'),
    'capture_and_locate should expose a focus recovery point on mismatch',
  )
  const chainState = (result.data as {
    chainState?: { chainStatus?: string }
  }).chainState
  assert(
    chainState?.chainStatus === 'verified_failed',
    'capture_and_locate should mark query mismatch as verified_failed',
  )
}

async function verifyCaptureAndLocateMatchesLocalizedNotepadAlias(): Promise<void> {
  const bridge = new FixtureWindowsBridge({
    Snapshot: {
      summary: 'snapshot localized notepad',
      windows: ['无标题 - 记事本'],
      focusedWindow: '无标题 - 记事本',
      anchors: ['记事本 - 2 个运行窗口'],
    },
  })
  const adapter = new BridgeWindowsMcpAdapter(bridge)
  const registry = new InMemoryToolRegistry()
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createWindowsMcpTools(adapter)) {
    registry.register(tool)
  }
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }

  const result = await runtime.execute(
    {
      toolName: 'command.desktop.capture_and_locate',
      input: {
        query: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'capture_and_locate should match localized Notepad aliases')
  const verification = ((result.data as {
    verification?: { passed?: boolean }
  }).verification)
  assert(
    verification?.passed === true,
    'capture_and_locate should verify success for localized Notepad aliases',
  )
}

class FixtureWindowsBridge implements WindowsMcpBridge {
  readonly calls: Array<{
    toolName: string
    args: Record<string, unknown>
  }> = []
  private readonly clipboardResponses: unknown[]
  private readonly snapshotResponses: unknown[]

  constructor(private readonly fixtures: Record<string, unknown>) {
    this.clipboardResponses = Array.isArray(fixtures.Clipboard)
      ? [...fixtures.Clipboard]
      : []
    this.snapshotResponses = Array.isArray(fixtures.Snapshot)
      ? [...fixtures.Snapshot]
      : []
  }

  async call<TResponse = unknown>(request: {
    toolName: string
    args: Record<string, unknown>
  }): Promise<TResponse> {
    this.calls.push(request)

    if (request.toolName === 'Type') {
      const name = request.args.name
      if (
        name === 'File name' ||
        name === 'File name:' ||
        name === 'Address' ||
        name === '文件名' ||
        name === '文件名(N):' ||
        name === '地址' ||
        name === '编辑'
      ) {
        return {
          ok: false,
          summary: `Could not find UI element "${String(name)}" in the current snapshot.`,
          error: 'WINDOW_ELEMENT_NOT_FOUND',
          failureClass: 'deterministic',
        } as TResponse
      }
    }

    if (request.toolName === 'Clipboard' && this.clipboardResponses.length > 0) {
      return this.clipboardResponses.shift() as TResponse
    }

    if (request.toolName === 'Snapshot' && this.snapshotResponses.length > 0) {
      return this.snapshotResponses.shift() as TResponse
    }

    return (this.fixtures[request.toolName] ??
      { ok: true, summary: `${request.toolName} ok` }) as TResponse
  }
}

function createToolContext() {
  return {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: 'windows-phase1-regression',
    turnId: 'turn-1',
  }
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
