import type { AnyToolDefinition, ToolDefinition } from '../../tools/Tool.js'
import {
  findDesktopInteractiveElement,
  isDesktopObservationReliable,
  resolveDesktopObservationAnchor,
  type WindowsMcpAdapter,
  type DesktopActionResult,
  type DesktopSnapshot,
} from './WindowsMcpAdapter.js'

export function createWindowsMcpTools(
  adapter: WindowsMcpAdapter,
): AnyToolDefinition[] {
  const screenshotTool: ToolDefinition<undefined | Record<string, never>> = {
    name: 'windows.screenshot',
    availability: 'core',
    description: 'Capture a fast Windows desktop screenshot summary.',
    searchHints: ['windows', 'desktop', 'screenshot', 'observe'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    maxResultChars: 2_000,
    resultPolicy: {
      inlineMaxChars: 2_000,
      storeRaw: true,
      readBackTool: 'artifacts.read_result',
    },
    inputSchema: {
      description: 'windows screenshot input',
    },
    async execute() {
      const data = await adapter.screenshot()
      const observationReliable = isDesktopObservationReliable(data)
      return {
        ok: observationReliable,
        summary: observationReliable
          ? data.summary
          : `Windows screenshot observation was insufficient. ${data.summary}`,
        data,
        error: observationReliable ? undefined : 'WINDOW_SCREENSHOT_OBSERVATION_INSUFFICIENT',
        failureClass: data.failureClass ?? (observationReliable ? undefined : 'deterministic'),
      }
    },
  }

  const snapshotTool: ToolDefinition<{
    useDom?: boolean
    useVision?: boolean
  }> = {
    name: 'windows.snapshot',
    availability: 'core',
    description: 'Capture a structured Windows desktop snapshot.',
    searchHints: ['windows', 'desktop', 'snapshot', 'ui', 'dom'],
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
      description: 'windows snapshot input',
      properties: {
        useDom: { type: 'boolean' },
        useVision: { type: 'boolean' },
      },
    },
    async execute(input) {
      const data = await adapter.snapshot({
        useDom: input?.useDom === true,
        useVision: input?.useVision === true,
      })
      const observationReliable = isDesktopObservationReliable(data)
      return {
        ok: observationReliable,
        summary: observationReliable
          ? data.summary
          : `Windows snapshot observation was insufficient. ${data.summary}`,
        data,
        error: observationReliable ? undefined : 'WINDOW_SNAPSHOT_OBSERVATION_INSUFFICIENT',
        failureClass: data.failureClass ?? (observationReliable ? undefined : 'deterministic'),
      }
    },
  }

  const focusWindowTool: ToolDefinition<{ windowTitle: string }> = {
    name: 'windows.focus_window',
    availability: 'core',
    description: 'Focus a target window by title.',
    searchHints: ['windows', 'focus', 'switch', 'window'],
    riskLevel: 'medium',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'focus window input',
      properties: {
        windowTitle: { type: 'string' },
      },
      required: ['windowTitle'],
    },
    async execute(input) {
      const data = await adapter.focusWindow(input.windowTitle)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_FOCUS_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const clickTool: ToolDefinition<{ x: number; y: number }> = {
    name: 'windows.click',
    availability: 'core',
    description: 'Click a screen coordinate.',
    searchHints: ['windows', 'mouse', 'click', 'coordinate'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'click input',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
    },
    async execute(input) {
      const data = await adapter.click(input.x, input.y)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_CLICK_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const clickLabelTool: ToolDefinition<{
    label: number
    button?: 'left' | 'right' | 'middle'
  }> = {
    name: 'windows.click_label',
    availability: 'discoverable',
    description: 'Click a UI element by snapshot label id.',
    searchHints: ['windows', 'click', 'label', 'element', 'ui tree'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'click label input',
      properties: {
        label: { type: 'number' },
        button: { type: 'string' },
      },
      required: ['label'],
    },
    async execute(input) {
      const data = await adapter.clickLabel(input.label, {
        button: input.button,
        clicks: 1,
      })
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_CLICK_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const doubleClickLabelTool: ToolDefinition<{
    label: number
    button?: 'left' | 'right' | 'middle'
  }> = {
    name: 'windows.double_click_label',
    availability: 'discoverable',
    description: 'Double click a UI element by snapshot label id.',
    searchHints: ['windows', 'double click', 'label', 'element', 'ui tree'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'double click label input',
      properties: {
        label: { type: 'number' },
        button: { type: 'string' },
      },
      required: ['label'],
    },
    async execute(input) {
      const data = await adapter.clickLabel(input.label, {
        button: input.button,
        clicks: 2,
      })
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_CLICK_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const typeTool: ToolDefinition<{ text: string }> = {
    name: 'windows.type',
    availability: 'core',
    description: 'Type text into the currently focused target.',
    searchHints: ['windows', 'type', 'text', 'keyboard'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'type input',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    async execute(input) {
      const data = await adapter.type(input.text)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_TYPE_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const typeLabelTool: ToolDefinition<{
    label: number
    text: string
    clear?: boolean
    pressEnter?: boolean
  }> = {
    name: 'windows.type_label',
    availability: 'discoverable',
    description: 'Type text into a UI element by snapshot label id.',
    searchHints: ['windows', 'type', 'label', 'input', 'element', 'ui tree'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'type label input',
      properties: {
        label: { type: 'number' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
        pressEnter: { type: 'boolean' },
      },
      required: ['label', 'text'],
    },
    async execute(input) {
      const data = await adapter.typeLabel(input.label, input.text, {
        clear: input.clear,
        pressEnter: input.pressEnter,
      })
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_TYPE_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const findElementByNameTool: ToolDefinition<{
    name: string
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
  }> = {
    name: 'windows.find_element_by_name',
    availability: 'discoverable',
    description: 'Find a snapshot UI element by visible name and return its label id.',
    searchHints: ['windows', 'find', 'element', 'label', 'name', 'ui tree'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'find element by name input',
      properties: {
        name: { type: 'string' },
        windowTitle: { type: 'string' },
        controlType: { type: 'string' },
        matchMode: { type: 'string' },
      },
      required: ['name'],
    },
    async execute(input) {
      const snapshot = await adapter.snapshot()
      const element = findDesktopInteractiveElement(snapshot, {
        name: input.name,
        windowTitle: input.windowTitle,
        controlType: input.controlType,
        matchMode: input.matchMode,
      })

      return {
        ok: Boolean(element),
        summary: element
          ? `Found UI element "${element.name}" with label ${String(element.label)}.`
          : `Could not find UI element "${input.name}" in the current snapshot.`,
        data: element
          ? {
              element,
              observation: snapshot,
            }
          : {
              observation: snapshot,
            },
        error: element ? undefined : 'WINDOW_ELEMENT_NOT_FOUND',
        failureClass: element ? undefined : 'deterministic',
      }
    },
  }

  const clickElementByNameTool: ToolDefinition<{
    name: string
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
    button?: 'left' | 'right' | 'middle'
  }> = {
    name: 'windows.click_element_by_name',
    availability: 'discoverable',
    description: 'Find a snapshot UI element by visible name and click it.',
    searchHints: ['windows', 'click', 'element', 'name', 'label', 'ui tree'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'click element by name input',
      properties: {
        name: { type: 'string' },
        windowTitle: { type: 'string' },
        controlType: { type: 'string' },
        matchMode: { type: 'string' },
        button: { type: 'string' },
      },
      required: ['name'],
    },
    async execute(input) {
      const snapshot = await adapter.snapshot()
      const element = findDesktopInteractiveElement(snapshot, {
        name: input.name,
        windowTitle: input.windowTitle,
        controlType: input.controlType,
        matchMode: input.matchMode,
      })

      if (!element) {
        return {
          ok: false,
          summary: `Could not find UI element "${input.name}" in the current snapshot.`,
          data: { observation: snapshot },
          error: 'WINDOW_ELEMENT_NOT_FOUND',
          failureClass: 'deterministic' as const,
        }
      }

      const data =
        typeof element.label === 'number'
          ? await adapter.clickLabel(element.label, {
              button: input.button,
              clicks: 1,
            })
          : element.x !== undefined && element.y !== undefined
            ? await adapter.clickCoordinate(element.x, element.y, {
                button: input.button,
                clicks: 1,
              })
            : {
                ok: false,
                summary: `UI element "${element.name}" was found, but it has neither label nor coordinates.`,
                failureClass: 'deterministic' as const,
              }
      const verified = await verifyNamedElementAction({
        adapter,
        actionResult: data,
        beforeSnapshot: snapshot,
        targetName: element.name,
      })
      return {
        ok: verified.ok,
        summary: verified.ok
          ? `Clicked UI element "${element.name}" via ${
              typeof element.label === 'number'
                ? `label ${String(element.label)}`
                : `coordinate (${String(element.x)}, ${String(element.y)})`
            }.`
          : verified.summary,
        data: {
          ...verified,
          element,
          observation: snapshot,
        },
        error: verified.ok ? undefined : 'WINDOW_CLICK_FAILED',
        failureClass: verified.failureClass ?? (verified.ok ? undefined : 'deterministic'),
      }
    },
  }

  const doubleClickElementByNameTool: ToolDefinition<{
    name: string
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
    button?: 'left' | 'right' | 'middle'
  }> = {
    name: 'windows.double_click_element_by_name',
    availability: 'discoverable',
    description: 'Find a snapshot UI element by visible name and double click it.',
    searchHints: ['windows', 'double click', 'element', 'name', 'label', 'ui tree'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'double click element by name input',
      properties: {
        name: { type: 'string' },
        windowTitle: { type: 'string' },
        controlType: { type: 'string' },
        matchMode: { type: 'string' },
        button: { type: 'string' },
      },
      required: ['name'],
    },
    async execute(input) {
      const snapshot = await adapter.snapshot()
      const element = findDesktopInteractiveElement(snapshot, {
        name: input.name,
        windowTitle: input.windowTitle,
        controlType: input.controlType,
        matchMode: input.matchMode,
      })

      if (!element) {
        return {
          ok: false,
          summary: `Could not find UI element "${input.name}" in the current snapshot.`,
          data: { observation: snapshot },
          error: 'WINDOW_ELEMENT_NOT_FOUND',
          failureClass: 'deterministic' as const,
        }
      }

      const data =
        typeof element.label === 'number'
          ? await adapter.clickLabel(element.label, {
              button: input.button,
              clicks: 2,
            })
          : element.x !== undefined && element.y !== undefined
            ? await adapter.clickCoordinate(element.x, element.y, {
                button: input.button,
                clicks: 2,
              })
            : {
                ok: false,
                summary: `UI element "${element.name}" was found, but it has neither label nor coordinates.`,
                failureClass: 'deterministic' as const,
              }
      const verified = await verifyNamedElementAction({
        adapter,
        actionResult: data,
        beforeSnapshot: snapshot,
        targetName: element.name,
      })
      return {
        ok: verified.ok,
        summary: verified.ok
          ? `Double clicked UI element "${element.name}" via ${
              typeof element.label === 'number'
                ? `label ${String(element.label)}`
                : `coordinate (${String(element.x)}, ${String(element.y)})`
            }.`
          : verified.summary,
        data: {
          ...verified,
          element,
          observation: snapshot,
        },
        error: verified.ok ? undefined : 'WINDOW_CLICK_FAILED',
        failureClass: verified.failureClass ?? (verified.ok ? undefined : 'deterministic'),
      }
    },
  }

  const typeElementByNameTool: ToolDefinition<{
    name: string
    text: string
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
    clear?: boolean
    pressEnter?: boolean
  }> = {
    name: 'windows.type_element_by_name',
    availability: 'discoverable',
    description: 'Find a snapshot UI element by visible name and type into it.',
    searchHints: ['windows', 'type', 'element', 'name', 'label', 'input', 'ui tree'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'type element by name input',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        windowTitle: { type: 'string' },
        controlType: { type: 'string' },
        matchMode: { type: 'string' },
        clear: { type: 'boolean' },
        pressEnter: { type: 'boolean' },
      },
      required: ['name', 'text'],
    },
    async execute(input) {
      const snapshot = await adapter.snapshot()
      const element = findDesktopInteractiveElement(snapshot, {
        name: input.name,
        windowTitle: input.windowTitle,
        controlType: input.controlType,
        matchMode: input.matchMode,
      })

      if (!element) {
        return {
          ok: false,
          summary: `Could not find UI element "${input.name}" in the current snapshot.`,
          data: { observation: snapshot },
          error: 'WINDOW_ELEMENT_NOT_FOUND',
          failureClass: 'deterministic' as const,
        }
      }

      const data =
        typeof element.label === 'number'
          ? await adapter.typeLabel(element.label, input.text, {
              clear: input.clear,
              pressEnter: input.pressEnter,
            })
          : element.x !== undefined && element.y !== undefined
            ? await adapter.clickCoordinate(element.x, element.y, {
                clicks: 1,
              }).then(async clickResult => {
                if (!clickResult.ok) {
                  return clickResult
                }

                return adapter.type(input.text)
              })
            : {
                ok: false,
                summary: `UI element "${element.name}" was found, but it has neither label nor coordinates.`,
                failureClass: 'deterministic' as const,
              }
      const verified = await verifyNamedElementAction({
        adapter,
        actionResult: data,
        beforeSnapshot: snapshot,
        targetName: element.name,
      })
      return {
        ok: verified.ok,
        summary: verified.ok
          ? `Typed into UI element "${element.name}" via ${
              typeof element.label === 'number'
                ? `label ${String(element.label)}`
                : `coordinate (${String(element.x)}, ${String(element.y)})`
            }.`
          : verified.summary,
        data: {
          ...verified,
          element,
          observation: snapshot,
        },
        error: verified.ok ? undefined : 'WINDOW_TYPE_FAILED',
        failureClass: verified.failureClass ?? (verified.ok ? undefined : 'deterministic'),
      }
    },
  }

  const shortcutTool: ToolDefinition<{ shortcut: string }> = {
    name: 'windows.shortcut',
    availability: 'core',
    description: 'Execute a keyboard shortcut.',
    searchHints: ['windows', 'shortcut', 'keyboard', 'hotkey'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'shortcut input',
      properties: {
        shortcut: { type: 'string' },
      },
      required: ['shortcut'],
    },
    async execute(input) {
      const data = await adapter.shortcut(input.shortcut)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_SHORTCUT_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const scrollTool: ToolDefinition<{
    direction: 'up' | 'down' | 'left' | 'right'
    amount?: number
    x?: number
    y?: number
  }> = {
    name: 'windows.scroll',
    availability: 'discoverable',
    description: 'Scroll vertically or horizontally, optionally at a coordinate.',
    searchHints: ['windows', 'scroll', 'page', 'list', 'viewport'],
    riskLevel: 'medium',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'scroll input',
      properties: {
        direction: { type: 'string' },
        amount: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['direction'],
    },
    async execute(input) {
      const data = await adapter.scroll(input)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_SCROLL_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const moveOrDragTool: ToolDefinition<{
    x: number
    y: number
    drag?: boolean
  }> = {
    name: 'windows.move_or_drag',
    availability: 'discoverable',
    description: 'Move the cursor or drag to a target coordinate.',
    searchHints: ['windows', 'move', 'drag', 'cursor', 'mouse'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'move or drag input',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        drag: { type: 'boolean' },
      },
      required: ['x', 'y'],
    },
    async execute(input) {
      const data = await adapter.moveOrDrag(input)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_MOVE_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const waitTool: ToolDefinition<{ durationSeconds: number }> = {
    name: 'windows.wait',
    availability: 'core',
    description: 'Pause for a short duration.',
    searchHints: ['windows', 'wait', 'pause', 'sleep'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: 'wait input',
      properties: {
        durationSeconds: { type: 'number' },
      },
      required: ['durationSeconds'],
    },
    async execute(input) {
      const data = await adapter.wait(input.durationSeconds)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        failureClass: data.failureClass,
      }
    },
  }

  const clipboardTool: ToolDefinition<{ mode: 'get' | 'set'; text?: string }> = {
    name: 'windows.clipboard',
    availability: 'core',
    description: 'Read or write the Windows clipboard.',
    searchHints: ['windows', 'clipboard', 'copy', 'paste'],
    riskLevel: 'medium',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'clipboard input',
      properties: {
        mode: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['mode'],
    },
    async execute(input) {
      const data = await adapter.clipboard(input.mode, input.text)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_CLIPBOARD_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const appTool: ToolDefinition<{
    mode: 'launch' | 'switch' | 'resize' | 'list'
    name?: string
    windowLocation?: [number, number]
    windowSize?: [number, number]
  }> = {
    name: 'windows.app',
    availability: 'discoverable',
    description: 'Launch, list, switch, or resize application windows.',
    searchHints: ['windows', 'app', 'launch', 'list', 'switch', 'resize'],
    riskLevel: 'medium',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'app input',
      properties: {
        mode: { type: 'string' },
        name: { type: 'string' },
        windowLocation: { type: 'array' },
        windowSize: { type: 'array' },
      },
      required: ['mode'],
    },
    async execute(input) {
      const data = await adapter.app(
        input.mode,
        input.name,
        input.windowLocation,
        input.windowSize,
      )
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_APP_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const shellTool: ToolDefinition<{ command: string; timeout?: number }> = {
    name: 'windows.shell',
    availability: 'discoverable',
    description: 'Run a PowerShell command via Windows-MCP.',
    searchHints: ['windows', 'shell', 'powershell', 'command'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'shell input',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['command'],
    },
    async execute(input) {
      const data = await adapter.shell(input.command, input.timeout)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_SHELL_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const filesystemTool: ToolDefinition<{
    mode: 'read' | 'write' | 'copy' | 'move' | 'delete' | 'list' | 'search' | 'info'
    path?: string
    targetPath?: string
    content?: string
    pattern?: string
  }> = {
    name: 'windows.filesystem',
    availability: 'discoverable',
    description: 'Run file system operations through Windows-MCP.',
    searchHints: ['windows', 'filesystem', 'files', 'directory', 'path'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'filesystem input',
      properties: {
        mode: { type: 'string' },
        path: { type: 'string' },
        targetPath: { type: 'string' },
        content: { type: 'string' },
        pattern: { type: 'string' },
      },
      required: ['mode'],
    },
    async execute(input) {
      const data = await adapter.filesystem(input)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_FILESYSTEM_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const processTool: ToolDefinition<{
    mode: 'list' | 'kill'
    name?: string
    pid?: number
    sortBy?: 'memory' | 'cpu' | 'name'
    limit?: number
    force?: boolean
  }> = {
    name: 'windows.process',
    availability: 'discoverable',
    description: 'List or kill Windows processes.',
    searchHints: ['windows', 'process', 'task manager', 'kill'],
    riskLevel: 'high',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'process input',
      properties: {
        mode: { type: 'string' },
        name: { type: 'string' },
        pid: { type: 'number' },
        sortBy: { type: 'string' },
        limit: { type: 'number' },
        force: { type: 'boolean' },
      },
      required: ['mode'],
    },
    async execute(input) {
      const data = await adapter.process(input)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_PROCESS_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  const notificationTool: ToolDefinition<{
    title: string
    message: string
  }> = {
    name: 'windows.notification',
    availability: 'discoverable',
    description: 'Send a Windows toast notification.',
    searchHints: ['windows', 'notification', 'toast', 'message'],
    riskLevel: 'medium',
    executionMode: 'sync',
    concurrencySafe: false,
    inputSchema: {
      description: 'notification input',
      properties: {
        title: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['title', 'message'],
    },
    async execute(input) {
      const data = await adapter.notification(input.title, input.message)
      return {
        ok: data.ok,
        summary: data.summary,
        data,
        error: data.ok ? undefined : 'WINDOW_NOTIFICATION_FAILED',
        failureClass: data.failureClass ?? (data.ok ? undefined : 'deterministic'),
      }
    },
  }

  return [
    screenshotTool,
    snapshotTool,
    focusWindowTool,
    clickTool,
    clickLabelTool,
    doubleClickLabelTool,
    typeTool,
    typeLabelTool,
    findElementByNameTool,
    clickElementByNameTool,
    doubleClickElementByNameTool,
    typeElementByNameTool,
    shortcutTool,
    scrollTool,
    moveOrDragTool,
    waitTool,
    clipboardTool,
    appTool,
    shellTool,
    filesystemTool,
    processTool,
    notificationTool,
  ]
}

async function verifyNamedElementAction(input: {
  adapter: WindowsMcpAdapter
  actionResult: DesktopActionResult
  beforeSnapshot: DesktopSnapshot
  targetName: string
}): Promise<DesktopActionResult> {
  if (!input.actionResult.ok) {
    return input.actionResult
  }

  const afterSnapshot = await input.adapter.snapshot()
  const verifiedAnchor = resolveDesktopObservationAnchor(afterSnapshot)
  const currentState = resolveDesktopObservationAnchor(input.beforeSnapshot) ?? 'unknown'
  const nextState = verifiedAnchor ?? 'unknown'
  const recoveryPoint =
    afterSnapshot.recoveryPoint ??
    input.beforeSnapshot.recoveryPoint ??
    (currentState !== 'unknown' ? `focus:${currentState}` : 'observe:snapshot')
  const verificationPassed = isDesktopObservationReliable(afterSnapshot) && Boolean(verifiedAnchor)

  return {
    ...input.actionResult,
    ok: verificationPassed,
    summary: verificationPassed
      ? input.actionResult.summary
      : `Post-action verification failed for UI element "${input.targetName}".`,
    failureClass: verificationPassed
      ? input.actionResult.failureClass
      : input.actionResult.failureClass ?? 'deterministic',
    currentState,
    nextState,
    verifiedAnchor,
    recoveryPoint,
    verifiedObservation: afterSnapshot,
    verification: {
      passed: verificationPassed,
      details: verificationPassed
        ? 'Post-action snapshot confirmed the desktop transition.'
        : 'Post-action snapshot was not reliable enough to confirm the transition.',
    },
  }
}
