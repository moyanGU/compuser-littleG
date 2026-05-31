import type { ToolFailureClass } from '../../tools/Tool.js'
import type { WindowsMcpBridge } from './WindowsMcpBridge.js'

export interface DesktopSnapshot {
  summary: string
  windows: string[]
  focusedWindow?: string
  interactiveElements?: DesktopInteractiveElement[]
  anchors?: string[]
  windowAnchor?: string
  domAnchor?: string
  confidence?: number
  focusedTargetConfidence?: number
  domSummary?: string
  observationMode?: 'snapshot' | 'screenshot' | 'dom'
  recoveryPoint?: string
  raw?: unknown
  failureClass?: ToolFailureClass
}

export interface DesktopInteractiveElement {
  label?: number
  window?: string
  controlType?: string
  name: string
  coords?: string
  metadata?: string
  x?: number
  y?: number
}

export interface DesktopActionResult {
  ok: boolean
  summary: string
  raw?: unknown
  failureClass?: ToolFailureClass
  currentState?: string
  nextState?: string
  verifiedAnchor?: string
  recoveryPoint?: string
  verifiedObservation?: DesktopSnapshot
  verification?: {
    passed: boolean
    details?: string
  }
}

export function resolveDesktopObservationAnchor(
  snapshot: DesktopSnapshot | undefined,
): string | undefined {
  if (!snapshot) {
    return undefined
  }

  return (
    snapshot.windowAnchor ??
    snapshot.domAnchor ??
    snapshot.anchors?.[0] ??
    snapshot.focusedWindow ??
    snapshot.windows[0]
  )
}

export function isDesktopObservationReliable(
  snapshot: DesktopSnapshot | undefined,
): boolean {
  if (!snapshot) {
    return false
  }

  return (
    (snapshot.confidence ?? 0) >= 0.5 &&
    Boolean(resolveDesktopObservationAnchor(snapshot)) &&
    ((snapshot.anchors?.length ?? 0) > 0 || snapshot.windows.length > 0)
  )
}

export function findDesktopInteractiveElement(
  snapshot: DesktopSnapshot | undefined,
  input: {
    name: string
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
  },
): DesktopInteractiveElement | undefined {
  if (!snapshot?.interactiveElements?.length) {
    return undefined
  }

  const normalizedName = normalizeInteractiveElementText(input.name)
  const normalizedNameAliases = buildInteractiveElementNameAliases(input.name)
  if (!normalizedName || normalizedNameAliases.length === 0) {
    return undefined
  }

  const normalizedWindowTitle = normalizeInteractiveElementText(input.windowTitle)
  const normalizedWindowTitleAliases = buildInteractiveElementNameAliases(input.windowTitle)
  const normalizedControlType = normalizeInteractiveElementText(input.controlType)
  const normalizedControlTypeAliases = buildInteractiveElementControlTypeAliases(
    input.controlType,
  )
  const matchMode = input.matchMode ?? 'exact'
  const prefersInputAnchor = isStableInputControlName(normalizedName)

  let bestMatch: DesktopInteractiveElement | undefined
  let bestScore = -1

  for (const element of snapshot.interactiveElements) {
    if (
      normalizedWindowTitle &&
      element.window &&
      !matchesInteractiveElementText(
        element.window,
        normalizedWindowTitle,
        normalizedWindowTitleAliases,
        'contains',
      )
    ) {
      continue
    }

    if (
      normalizedControlType &&
      !matchesInteractiveElementText(
        element.controlType,
        normalizedControlType,
        normalizedControlTypeAliases,
        'contains',
      )
    ) {
      continue
    }

    const score = scoreInteractiveElementNameMatch(
      normalizeInteractiveElementText(element.name),
      normalizedName,
      normalizedNameAliases,
      matchMode,
    ) + (prefersInputAnchor && isStableInputControlName(element.name) ? 20 : 0)
    if (score <= bestScore) {
      continue
    }

    bestMatch = element
    bestScore = score
  }

  return bestScore > 0 ? bestMatch : undefined
}

export interface WindowsMcpAdapter {
  screenshot(): Promise<DesktopSnapshot>
  snapshot(options?: {
    useDom?: boolean
    useVision?: boolean
  }): Promise<DesktopSnapshot>
  focusWindow(windowTitle: string): Promise<DesktopActionResult>
  click(x: number, y: number): Promise<DesktopActionResult>
  clickCoordinate(
    x: number,
    y: number,
    options?: {
      button?: 'left' | 'right' | 'middle'
      clicks?: number
    },
  ): Promise<DesktopActionResult>
  clickLabel(
    label: number,
    options?: {
      button?: 'left' | 'right' | 'middle'
      clicks?: number
    },
  ): Promise<DesktopActionResult>
  type(text: string): Promise<DesktopActionResult>
  typeLabel(
    label: number,
    text: string,
    options?: {
      clear?: boolean
      caretPosition?: 'start' | 'idle' | 'end'
      pressEnter?: boolean
    },
  ): Promise<DesktopActionResult>
  shortcut(shortcut: string): Promise<DesktopActionResult>
  scroll(input: {
    direction: 'up' | 'down' | 'left' | 'right'
    amount?: number
    x?: number
    y?: number
  }): Promise<DesktopActionResult>
  moveOrDrag(input: {
    x: number
    y: number
    drag?: boolean
  }): Promise<DesktopActionResult>
  wait(durationSeconds: number): Promise<DesktopActionResult>
  clipboard(mode: 'get' | 'set', text?: string): Promise<DesktopActionResult>
  app(
    mode: 'launch' | 'switch' | 'resize' | 'list',
    name?: string,
    windowLocation?: [number, number],
    windowSize?: [number, number],
  ): Promise<DesktopActionResult>
  shell(command: string, timeout?: number): Promise<DesktopActionResult>
  filesystem(input: {
    mode: 'read' | 'write' | 'copy' | 'move' | 'delete' | 'list' | 'search' | 'info'
    path?: string
    targetPath?: string
    content?: string
    pattern?: string
  }): Promise<DesktopActionResult>
  process(input: {
    mode: 'list' | 'kill'
    name?: string
    pid?: number
    sortBy?: 'memory' | 'cpu' | 'name'
    limit?: number
    force?: boolean
  }): Promise<DesktopActionResult>
  notification(title: string, message: string): Promise<DesktopActionResult>
}

export class BridgeWindowsMcpAdapter implements WindowsMcpAdapter {
  constructor(private readonly bridge: WindowsMcpBridge) {}

  async screenshot(): Promise<DesktopSnapshot> {
    const raw = await this.bridge.call({
      toolName: 'Screenshot',
      args: {},
    })
    return this.normalizeSnapshot(raw, 'screenshot')
  }

  async snapshot(options?: {
    useDom?: boolean
    useVision?: boolean
  }): Promise<DesktopSnapshot> {
    const raw = await this.bridge.call({
      toolName: 'Snapshot',
      args: {
        ...(options?.useDom ? { use_dom: true } : {}),
        ...(options?.useVision ? { use_vision: true } : {}),
      },
    })
    return this.normalizeSnapshot(raw, options?.useDom ? 'dom' : 'snapshot')
  }

  async focusWindow(windowTitle: string): Promise<DesktopActionResult> {
    const fallbackSummary = `Focus window: ${windowTitle}`
    const before = await this.tryReliableSnapshot()
    const candidates = [windowTitle, ...buildInteractiveElementNameAliases(windowTitle)].filter(
      (value, index, values) => value && values.indexOf(value) === index,
    )

    let lastResult: DesktopActionResult | undefined
    for (const candidate of candidates) {
      const raw = await this.bridge.call({
        toolName: 'App',
        args: {
          mode: 'switch',
          name: candidate,
        },
      })
      const result = this.normalizeActionResult(raw, fallbackSummary)
      const verified = await this.verifyFocusedWindow(windowTitle, result, before)
      if (verified.ok) {
        return verified
      }
      lastResult = verified
    }

    const snapshot = before ?? (await this.tryReliableSnapshot())
    const interactiveTarget = snapshot
      ? findDesktopInteractiveElement(snapshot, {
          name: windowTitle,
          matchMode: 'contains',
        })
      : undefined
    if (interactiveTarget) {
      const raw =
        typeof interactiveTarget.label === 'number'
          ? await this.bridge.call({
              toolName: 'Click',
              args: {
                label: interactiveTarget.label,
              },
            })
          : typeof interactiveTarget.x === 'number' &&
              typeof interactiveTarget.y === 'number'
            ? await this.bridge.call({
                toolName: 'Click',
                args: {
                  loc: [interactiveTarget.x, interactiveTarget.y],
                },
              })
            : undefined
      if (raw !== undefined) {
        const result = this.normalizeActionResult(raw, fallbackSummary)
        const verified = await this.verifyFocusedWindow(windowTitle, result, before)
        if (verified.ok) {
          return verified
        }
        lastResult = verified
      }
    }

    return (
      lastResult ?? {
        ok: false,
        summary: `Application ${windowTitle} not found.`,
        failureClass: 'deterministic',
      }
    )
  }

  async click(x: number, y: number): Promise<DesktopActionResult> {
    return this.clickCoordinate(x, y)
  }

  async clickCoordinate(
    x: number,
    y: number,
    options?: {
      button?: 'left' | 'right' | 'middle'
      clicks?: number
    },
  ): Promise<DesktopActionResult> {
    return this.withOptionalVerification(`Click coordinate (${x}, ${y})`, async () => {
      return this.bridge.call({
        toolName: 'Click',
        args: {
          loc: [x, y],
          ...(options?.button ? { button: options.button } : {}),
          ...(typeof options?.clicks === 'number' ? { clicks: options.clicks } : {}),
        },
      })
    })
  }

  async clickLabel(
    label: number,
    options?: {
      button?: 'left' | 'right' | 'middle'
      clicks?: number
    },
  ): Promise<DesktopActionResult> {
    return this.withOptionalVerification(`Click label ${String(label)}`, async () => {
      return this.bridge.call({
        toolName: 'Click',
        args: {
          label,
          ...(options?.button ? { button: options.button } : {}),
          ...(typeof options?.clicks === 'number' ? { clicks: options.clicks } : {}),
        },
      })
    })
  }

  async type(text: string): Promise<DesktopActionResult> {
    const before = await this.tryReliableSnapshot()
    const inputTarget = before
      ? findDesktopInteractiveElement(before, {
          name: '编辑',
          controlType: 'Edit',
          matchMode: 'contains',
        }) ??
        findDesktopInteractiveElement(before, {
          name: '编辑',
          controlType: 'TextBox',
          matchMode: 'contains',
        }) ??
        findDesktopInteractiveElement(before, {
          name: '编辑',
          controlType: 'Input',
          matchMode: 'contains',
        })
      : undefined

    if (!inputTarget) {
      return {
        ok: false,
        summary: 'Could not find a stable input anchor for typing.',
        failureClass: 'deterministic',
        recoveryPoint: before?.recoveryPoint ?? 'observe:snapshot',
        verifiedObservation: before,
        verification: {
          passed: false,
          details: 'No edit/textbox input anchor was available in the current snapshot.',
        },
      }
    }

    const raw =
      typeof inputTarget.label === 'number'
        ? await this.bridge.call({
            toolName: 'Type',
            args: {
              label: inputTarget.label,
              text,
            },
          })
        : inputTarget.x !== undefined && inputTarget.y !== undefined
          ? await this.bridge.call({
              toolName: 'Type',
              args: {
                loc: [inputTarget.x, inputTarget.y],
                text,
              },
            })
          : {
              ok: false,
              summary: `Stable input anchor "${inputTarget.name}" has no label or coordinates.`,
              failureClass: 'deterministic' as const,
            }

    const normalized = this.normalizeActionResult(raw, `Type text: ${text}`)
    const after = await this.tryReliableSnapshot()
    if (!after) {
      if (before) {
        return {
          ...normalized,
          ok: false,
          summary: normalized.ok
            ? `${normalized.summary} Post-action verification failed.`
            : normalized.summary,
          failureClass: normalized.failureClass ?? 'deterministic',
          currentState: resolveActionState(before),
          nextState: 'unknown',
          verifiedAnchor: resolveDesktopObservationAnchor(before),
          recoveryPoint: before.recoveryPoint ?? 'observe:snapshot',
          verifiedObservation: before,
          verification: {
            passed: false,
            details: normalized.ok
              ? 'Could not confirm the post-typing desktop state.'
              : 'Typing failed before a safe post-action verification could be completed.',
          },
        }
      }

      return {
        ...normalized,
        ok: false,
        summary: normalized.ok
          ? `${normalized.summary} Post-action verification failed.`
          : normalized.summary,
        failureClass: normalized.failureClass ?? 'deterministic',
        currentState: 'unknown',
        nextState: 'unknown',
        verifiedAnchor: undefined,
        recoveryPoint: 'observe:snapshot',
        verification: {
          passed: false,
          details: normalized.ok
            ? 'Could not confirm the post-typing desktop state.'
            : 'Typing failed before a safe post-action verification could be completed.',
        },
      }
    }

    return this.enrichActionResult(normalized, before ?? after, after)
  }

  async typeLabel(
    label: number,
    text: string,
    options?: {
      clear?: boolean
      caretPosition?: 'start' | 'idle' | 'end'
      pressEnter?: boolean
    },
  ): Promise<DesktopActionResult> {
    return this.withOptionalVerification(`Type text into label ${String(label)}`, async () => {
      return this.bridge.call({
        toolName: 'Type',
        args: {
          label,
          text,
          ...(typeof options?.clear === 'boolean' ? { clear: options.clear } : {}),
          ...(options?.caretPosition ? { caret_position: options.caretPosition } : {}),
          ...(typeof options?.pressEnter === 'boolean'
            ? { press_enter: options.pressEnter }
            : {}),
        },
      })
    })
  }

  async shortcut(shortcut: string): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Shortcut',
      args: {
        shortcut,
      },
    })
    return this.normalizeActionResult(raw, `Pressed shortcut: ${shortcut}`)
  }

  async scroll(input: {
    direction: 'up' | 'down' | 'left' | 'right'
    amount?: number
    x?: number
    y?: number
  }): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Scroll',
      args: {
        direction: input.direction,
        wheel_times: input.amount ?? 1,
        ...(input.x !== undefined && input.y !== undefined
          ? { loc: [input.x, input.y] }
          : {}),
        type:
          input.direction === 'left' || input.direction === 'right'
            ? 'horizontal'
            : 'vertical',
      },
    })
    return this.normalizeActionResult(raw, `Scroll ${input.direction}`)
  }

  async moveOrDrag(input: {
    x: number
    y: number
    drag?: boolean
  }): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Move',
      args: {
        loc: [input.x, input.y],
        drag: input.drag === true,
      },
    })
    return this.normalizeActionResult(
      raw,
      input.drag === true ? 'Dragged cursor to target.' : 'Moved cursor to target.',
    )
  }

  async wait(durationSeconds: number): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Wait',
      args: {
        duration: durationSeconds,
      },
    })
    return this.normalizeActionResult(raw, `Waited ${durationSeconds} seconds`)
  }

  async clipboard(
    mode: 'get' | 'set',
    text?: string,
  ): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Clipboard',
      args: {
        mode,
        ...(text !== undefined ? { text } : {}),
      },
    })
    return this.normalizeActionResult(raw, `Clipboard ${mode}`)
  }

  async app(
    mode: 'launch' | 'switch' | 'resize' | 'list',
    name?: string,
    windowLocation?: [number, number],
    windowSize?: [number, number],
  ): Promise<DesktopActionResult> {
    if (mode === 'list') {
      try {
        const raw = await this.bridge.call({
          toolName: 'App',
          args: {
            mode,
          },
        })
        if (isUnsupportedAppListPayload(raw)) {
          return {
            ok: false,
            summary: 'Windows-MCP does not support app list mode.',
            raw,
            failureClass: 'missing_dependency',
          }
        }
        return this.normalizeActionResult(raw, 'Listed app windows')
      } catch (error) {
        if (!isUnsupportedAppListModeError(error)) {
          throw error
        }

        return {
          ok: false,
          summary: 'Windows-MCP does not support app list mode.',
          raw: error instanceof Error ? error.message : String(error),
          failureClass: 'missing_dependency',
        }
      }
    }

    return this.withOptionalVerification(`App mode=${mode}`, async () => {
      return this.bridge.call({
        toolName: 'App',
        args: {
          mode,
          ...(name ? { name } : {}),
          ...(windowLocation ? { window_loc: windowLocation } : {}),
          ...(windowSize ? { window_size: windowSize } : {}),
        },
      })
    })
  }

  async shell(command: string, timeout?: number): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'PowerShell',
      args: {
        command,
        ...(timeout !== undefined ? { timeout } : {}),
      },
    })
    return this.normalizeActionResult(raw, 'PowerShell command executed')
  }

  async filesystem(input: {
    mode: 'read' | 'write' | 'copy' | 'move' | 'delete' | 'list' | 'search' | 'info'
    path?: string
    targetPath?: string
    content?: string
    pattern?: string
  }): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'FileSystem',
      args: {
        mode: input.mode,
        ...(input.path ? { path: input.path } : {}),
        ...(input.targetPath ? { target_path: input.targetPath } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.pattern ? { pattern: input.pattern } : {}),
      },
    })
    return this.normalizeActionResult(raw, `FileSystem mode=${input.mode}`)
  }

  async process(input: {
    mode: 'list' | 'kill'
    name?: string
    pid?: number
    sortBy?: 'memory' | 'cpu' | 'name'
    limit?: number
    force?: boolean
  }): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Process',
      args: {
        mode: input.mode,
        ...(input.name ? { name: input.name } : {}),
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(input.sortBy ? { sort_by: input.sortBy } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
      },
    })
    return this.normalizeActionResult(raw, `Process mode=${input.mode}`)
  }

  async notification(
    title: string,
    message: string,
  ): Promise<DesktopActionResult> {
    const raw = await this.bridge.call({
      toolName: 'Notification',
      args: {
        title,
        message,
      },
    })
    return this.normalizeActionResult(raw, 'Notification sent')
  }

  private normalizeSnapshot(
    raw: unknown,
    observationMode: DesktopSnapshot['observationMode'],
  ): DesktopSnapshot {
    const parsedTextSnapshot = parseTextSnapshotPayload(raw)
    if (parsedTextSnapshot) {
      return enrichSnapshot(parsedTextSnapshot, observationMode)
    }

    if (isDesktopSnapshot(raw)) {
      return enrichSnapshot(raw, observationMode)
    }

    if (typeof raw === 'string') {
      return enrichSnapshot({
        summary: raw,
        windows: [],
        raw,
        failureClass: raw.toLowerCase().includes('error') ? 'deterministic' : undefined,
      }, observationMode)
    }

    if (Array.isArray(raw)) {
      return enrichSnapshot({
        summary: raw.map(value => String(value)).join('\n'),
        windows: [],
        raw,
      }, observationMode)
    }

    return enrichSnapshot({
      summary: 'Windows-MCP returned an unrecognized snapshot payload.',
      windows: [],
      raw,
      failureClass: 'deterministic',
    }, observationMode)
  }

  private normalizeActionResult(
    raw: unknown,
    fallbackSummary: string,
  ): DesktopActionResult {
    if (isDesktopActionResult(raw)) {
      return raw
    }

    if (typeof raw === 'string') {
      const looksLikeError = isActionErrorText(raw)
      return {
        ok: !looksLikeError,
        summary: raw,
        raw,
        failureClass: looksLikeError ? 'deterministic' : undefined,
      }
    }

    return {
      ok: true,
      summary: fallbackSummary,
      raw,
    }
  }

  private enrichActionResult(
    result: DesktopActionResult,
    before: DesktopSnapshot,
    after: DesktopSnapshot,
  ): DesktopActionResult {
    const currentState = resolveActionState(before)
    const nextState = resolveActionState(after)
    const verifiedAnchor = resolveDesktopObservationAnchor(after)
    const recoveryPoint =
      after.recoveryPoint ??
      before.recoveryPoint ??
      (currentState !== 'unknown' ? `focus:${currentState}` : undefined)
    const observationReliable =
      isDesktopObservationReliable(after) && Boolean(verifiedAnchor)

    if (!result.ok || !observationReliable) {
      return {
        ...result,
        ok: false,
        summary: result.ok
          ? `${result.summary} Post-action verification failed.`
          : result.summary,
        failureClass: result.failureClass ?? 'deterministic',
        currentState,
        nextState,
        verifiedAnchor,
        recoveryPoint,
        verifiedObservation: after,
        verification: {
          passed: false,
          details: result.ok
            ? 'Post-action snapshot was not reliable enough to confirm the transition.'
            : 'Action failed before a safe post-action verification could be completed.',
        },
      }
    }

    return {
      ...result,
      currentState,
      nextState,
      verifiedAnchor,
      recoveryPoint,
      verifiedObservation: after,
      verification: {
        passed: true,
        details: 'Post-action snapshot confirmed the desktop transition.',
      },
    }
  }

  private async withOptionalVerification(
    fallbackSummary: string,
    action: () => Promise<unknown>,
  ): Promise<DesktopActionResult> {
    if (!this.shouldUseSnapshotVerification(fallbackSummary)) {
      const raw = await action()
      return this.normalizeActionResult(raw, fallbackSummary)
    }

    const before = await this.tryReliableSnapshot()
    const raw = await action()
    const normalized = this.normalizeActionResult(raw, fallbackSummary)
    const after = await this.tryReliableSnapshot()

    if (!before || !after) {
      return normalized
    }

    return this.enrichActionResult(normalized, before, after)
  }

  private async tryReliableSnapshot(): Promise<DesktopSnapshot | undefined> {
    try {
      const snapshot = await this.snapshot()
      return isDesktopObservationReliable(snapshot) ? snapshot : undefined
    } catch {
      return undefined
    }
  }

  private shouldUseSnapshotVerification(fallbackSummary: string): boolean {
    return (
      fallbackSummary.startsWith('Click ') ||
      fallbackSummary.startsWith('Type text into label ') ||
      fallbackSummary.startsWith('App mode=')
    )
  }

  private async verifyFocusedWindow(
    windowTitle: string,
    result: DesktopActionResult,
    before: DesktopSnapshot | undefined,
  ): Promise<DesktopActionResult> {
    const after = await this.tryReliableSnapshot()
    const currentState = before ? resolveActionState(before) : 'unknown'
    const nextState = after ? resolveActionState(after) : 'unknown'
    const verifiedAnchor = after ? resolveDesktopObservationAnchor(after) : undefined
    const recoveryPoint =
      after?.recoveryPoint ??
      before?.recoveryPoint ??
      (windowTitle ? `focus:${windowTitle}` : undefined)

    if (!after) {
      return {
        ...result,
        ok: false,
        summary: result.ok ? `${result.summary} Post-action verification failed.` : result.summary,
        failureClass: result.failureClass ?? 'deterministic',
        currentState,
        nextState,
        verifiedAnchor,
        recoveryPoint,
        verifiedObservation: before,
        verification: {
          passed: false,
          details: result.ok
            ? `Could not confirm focus on target window "${windowTitle}".`
            : 'Action failed before a safe post-action verification could be completed.',
        },
      }
    }

    if (!result.ok || !snapshotMatchesWindowTitle(after, windowTitle)) {
      return {
        ...result,
        ok: false,
        summary: result.ok
          ? `${result.summary} Target focus verification failed.`
          : result.summary,
        failureClass: result.failureClass ?? 'deterministic',
        currentState,
        nextState,
        verifiedAnchor,
        recoveryPoint,
        verifiedObservation: after,
        verification: {
          passed: false,
          details: result.ok
            ? `Post-action snapshot did not confirm focus on target window "${windowTitle}".`
            : 'Action failed before the target window could be confirmed.',
        },
      }
    }

    return {
      ...result,
      currentState,
      nextState,
      verifiedAnchor,
      recoveryPoint,
      verifiedObservation: after,
      verification: {
        passed: true,
        details: `Post-action snapshot confirmed focus on target window "${windowTitle}".`,
      },
    }
  }
}

function resolveActionState(snapshot: DesktopSnapshot): string {
  return (
    resolveDesktopObservationAnchor(snapshot) ??
    snapshot.focusedWindow ??
    snapshot.windows[0] ??
    'unknown'
  )
}

function enrichSnapshot(
  snapshot: DesktopSnapshot,
  observationMode: DesktopSnapshot['observationMode'],
): DesktopSnapshot {
  const anchors = dedupeStrings([
    ...(snapshot.anchors ?? []),
    ...snapshot.windows,
    snapshot.focusedWindow,
    ...extractDirectSnapshotAnchors(snapshot),
    ...extractRawAnchors(snapshot.raw),
  ])
  const windowAnchor = resolveWindowAnchor(snapshot, anchors)
  const domAnchor = resolveDomAnchor(snapshot)
  const domSummary = summarizeDomPayload(snapshot.raw) ?? summarizeDirectDomSnapshot(snapshot)
  const focusedTargetConfidence = resolveFocusedTargetConfidence(
    snapshot,
    anchors,
    windowAnchor,
    domAnchor,
  )
  const confidence = resolveObservationConfidence(
    snapshot,
    anchors,
    windowAnchor,
    domAnchor,
    domSummary,
    focusedTargetConfidence,
    observationMode,
  )
  const recoveryPoint = resolveObservationRecoveryPoint(
    snapshot,
    windowAnchor,
    domAnchor,
    observationMode,
  )

  return {
    ...snapshot,
    anchors,
    windowAnchor,
    domAnchor,
    confidence,
    focusedTargetConfidence,
    domSummary,
    observationMode,
    recoveryPoint,
  }
}

function extractDirectSnapshotAnchors(snapshot: DesktopSnapshot): string[] {
  const candidate = snapshot as unknown as Record<string, unknown>
  const directValues = [
    candidate.title,
    candidate.url,
    candidate.app,
    candidate.application,
    candidate.activeElement,
  ]

  const dom =
    typeof candidate.dom === 'object' && candidate.dom !== null
      ? (candidate.dom as Record<string, unknown>)
      : undefined

  const domValues = dom
    ? [dom.title, dom.url, dom.activeElement, dom.selectedText]
    : []

  return dedupeStrings(
    [...directValues, ...domValues]
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  )
}

function isDesktopSnapshot(value: unknown): value is DesktopSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.summary === 'string' && Array.isArray(candidate.windows)
}

function parseTextSnapshotPayload(raw: unknown): DesktopSnapshot | undefined {
  const normalizedText = normalizeSnapshotTextPayload(raw)
  if (!normalizedText) {
    return undefined
  }

  const focusedWindow = extractSectionFirstValue(
    normalizedText,
    'Focused Window:',
    'Opened Windows:',
  )
  const windows = extractOpenedWindows(normalizedText)
  const interactiveElements = mergeInteractiveElements(
    extractInteractiveElements(normalizedText),
    extractUiTreeInteractiveElements(normalizedText),
  )
  const interactiveNames = interactiveElements.map(element => element.name)
  const uiTreeAnchors = extractUiTreeAnchors(normalizedText)

  return {
    summary: normalizedText,
    windows,
    focusedWindow,
    interactiveElements,
    anchors: dedupeStrings([
      focusedWindow,
      ...windows,
      ...interactiveNames,
      ...uiTreeAnchors,
    ]),
    raw,
  }
}

function normalizeSnapshotTextPayload(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      return undefined
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        return normalizeSnapshotTextPayload(parsed)
      } catch {
        return trimmed
      }
    }

    return trimmed
  }

  if (Array.isArray(raw)) {
    const textParts = raw
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)

    return textParts.length > 0 ? textParts.join('\n') : undefined
  }

  return undefined
}

function extractSectionFirstValue(
  text: string,
  sectionStartLabel: string,
  nextSectionLabel: string | string[],
): string | undefined {
  const section = extractSection(text, sectionStartLabel, nextSectionLabel)
  if (!section) {
    return undefined
  }

  const lines = section
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^name(\s+.+)?$/i.test(line))
    .filter(line => !/^[-\s]{3,}$/.test(line))

  const candidate = lines[0]
  if (!candidate) {
    return undefined
  }

  const firstColumn = candidate.split(/\s{2,}/)[0]?.trim() || undefined
  if (!firstColumn || /^\d+$/.test(firstColumn)) {
    return undefined
  }

  return firstColumn
}

function extractOpenedWindows(text: string): string[] {
  const section = extractSection(text, 'Opened Windows:', [
    'List of Interactive Elements:',
    'List of Scrollable Elements:',
    'UI Tree:',
  ])
  if (!section) {
    return []
  }

  const lines = section
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !/^name(\s+.+)?$/i.test(line))
    .filter(line => !/^[-\s]{3,}$/.test(line))

  const windows: string[] = []
  for (const line of lines) {
    const parts = line.split(/\s{2,}/).map(part => part.trim()).filter(Boolean)
    if (parts.length === 0) {
      continue
    }

    const candidate = parts[0]
    if (
      !candidate ||
      candidate.toLowerCase() === 'name' ||
      candidate.toLowerCase() === 'no windows found'
    ) {
      continue
    }

    windows.push(candidate)
  }

  return dedupeStrings(windows)
}

function extractInteractiveElements(text: string): DesktopInteractiveElement[] {
  const section = extractSection(
    text,
    'List of Interactive Elements:',
    ['List of Scrollable Elements:', 'UI Tree:'],
  )
  if (!section) {
    return []
  }

  const elements: DesktopInteractiveElement[] = []
  const lines = section
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (
      line.startsWith('# id|window|control_type|name|coords|metadata') ||
      !/^\d+\|/.test(line)
    ) {
      continue
    }

    const element = parseInteractiveElementLine(line)
    if (!element) {
      continue
    }

    elements.push(element)
    if (elements.length >= 128) {
      break
    }
  }

  return elements
}

function extractUiTreeAnchors(text: string): string[] {
  const section = extractSection(text, 'UI Tree:', [])
  if (!section) {
    return []
  }

  const anchors: string[] = []
  const lines = section
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const matches = [...line.matchAll(/"([^"]+)"/g)]
      .map(match => match[1]?.trim())
      .filter((value): value is string => Boolean(value))

    for (const match of matches) {
      anchors.push(match)
      if (anchors.length >= 24) {
        return dedupeStrings(anchors)
      }
    }
  }

  return dedupeStrings(anchors)
}

function extractSection(
  text: string,
  sectionStartLabel: string,
  nextSectionLabel: string | string[],
): string | undefined {
  const startIndex = text.indexOf(sectionStartLabel)
  if (startIndex < 0) {
    return undefined
  }

  const contentStart = startIndex + sectionStartLabel.length
  const nextLabels = Array.isArray(nextSectionLabel)
    ? nextSectionLabel
    : [nextSectionLabel]
  const nextIndex = nextLabels
    .map(label => text.indexOf(label, contentStart))
    .filter(index => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), Number.POSITIVE_INFINITY)
  const section = nextIndex >= 0
    ? text.slice(contentStart, nextIndex)
    : text.slice(contentStart)

  const trimmed = section.trim()
  return trimmed || undefined
}

function parseInteractiveElementLine(
  line: string,
): DesktopInteractiveElement | undefined {
  const parts = line.split('|')
  if (parts.length < 5) {
    return undefined
  }

  const labelCandidate = parts[0]?.trim()
  const label = labelCandidate ? Number(labelCandidate) : Number.NaN
  const name = parts[3]?.trim()
  if (!name) {
    return undefined
  }

  const coordinateData = parseCoordinatePayload(parts[4]?.trim())
  const metadata = parts.slice(5).join('|').trim()
  return {
    label: Number.isFinite(label) ? label : undefined,
    window: parts[1]?.trim() || undefined,
    controlType: parts[2]?.trim() || undefined,
    name,
    coords: parts[4]?.trim() || undefined,
    metadata: metadata || undefined,
    x: coordinateData?.x,
    y: coordinateData?.y,
  }
}

function extractUiTreeInteractiveElements(text: string): DesktopInteractiveElement[] {
  const section = extractSection(text, 'UI Tree:', [])
  if (!section) {
    return []
  }

  const elements: DesktopInteractiveElement[] = []
  const lines = section
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const element = parseUiTreeInteractiveElementLine(line)
    if (!element) {
      continue
    }

    elements.push(element)
    if (elements.length >= 128) {
      break
    }
  }

  return elements
}

function parseUiTreeInteractiveElementLine(
  line: string,
): DesktopInteractiveElement | undefined {
  const match = line.match(/\((\d+),\s*(\d+)\)\s+(.+?)\s+"([^"]+)"/)
  if (!match) {
    return undefined
  }

  const x = Number(match[1])
  const y = Number(match[2])
  const controlType = match[3]?.trim()
  const name = match[4]?.trim()
  if (!Number.isFinite(x) || !Number.isFinite(y) || !controlType || !name) {
    return undefined
  }

  return {
    controlType,
    name,
    coords: `(${String(x)},${String(y)})`,
    x,
    y,
    metadata: line.includes('[action: click]') ? 'action: click' : undefined,
  }
}

function extractRawAnchors(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) {
    return []
  }

  const candidate = raw as Record<string, unknown>
  const directValues = [
    candidate.title,
    candidate.url,
    candidate.app,
    candidate.application,
    candidate.focusedWindow,
  ]

  const dom = candidate.dom
  const domValues =
    typeof dom === 'object' && dom !== null
      ? [
          (dom as Record<string, unknown>).title,
          (dom as Record<string, unknown>).url,
          (dom as Record<string, unknown>).activeElement,
          (dom as Record<string, unknown>).selectedText,
        ]
      : []

  return dedupeStrings(
    [...directValues, ...domValues]
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  )
}

function summarizeDomPayload(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }

  const candidate = raw as Record<string, unknown>
  const dom =
    typeof candidate.dom === 'object' && candidate.dom !== null
      ? (candidate.dom as Record<string, unknown>)
      : undefined
  if (!dom) {
    return undefined
  }

  const parts = [
    typeof dom.title === 'string' ? `title=${dom.title}` : undefined,
    typeof dom.url === 'string' ? `url=${dom.url}` : undefined,
    typeof dom.activeElement === 'string'
      ? `activeElement=${dom.activeElement}`
      : undefined,
    typeof dom.nodes === 'number' ? `nodes=${dom.nodes}` : undefined,
  ].filter((value): value is string => Boolean(value))

  return parts.length > 0 ? parts.join('; ') : undefined
}

function summarizeDirectDomSnapshot(snapshot: DesktopSnapshot): string | undefined {
  const candidate = snapshot as unknown as Record<string, unknown>
  const dom =
    typeof candidate.dom === 'object' && candidate.dom !== null
      ? (candidate.dom as Record<string, unknown>)
      : undefined
  if (!dom) {
    return undefined
  }

  const parts = [
    typeof dom.title === 'string' ? `title=${dom.title}` : undefined,
    typeof dom.url === 'string' ? `url=${dom.url}` : undefined,
    typeof dom.activeElement === 'string'
      ? `activeElement=${dom.activeElement}`
      : undefined,
    typeof dom.nodes === 'number' ? `nodes=${dom.nodes}` : undefined,
  ].filter((value): value is string => Boolean(value))

  return parts.length > 0 ? parts.join('; ') : undefined
}

function resolveWindowAnchor(
  snapshot: DesktopSnapshot,
  anchors: string[],
): string | undefined {
  const candidate = snapshot as unknown as Record<string, unknown>
  const directValues = [
    snapshot.focusedWindow,
    snapshot.windows[0],
    candidate.title,
    candidate.app,
    candidate.application,
  ]

  return dedupeStrings([
    ...directValues.filter((value): value is string => typeof value === 'string'),
    ...anchors,
  ])[0]
}

function resolveDomAnchor(snapshot: DesktopSnapshot): string | undefined {
  const candidate = snapshot as unknown as Record<string, unknown>
  const dom =
    typeof candidate.dom === 'object' && candidate.dom !== null
      ? (candidate.dom as Record<string, unknown>)
      : undefined

  if (!dom) {
    return undefined
  }

  return dedupeStrings([
    typeof dom.title === 'string' ? dom.title : undefined,
    typeof dom.url === 'string' ? dom.url : undefined,
    typeof dom.selectedText === 'string' ? dom.selectedText : undefined,
    typeof dom.activeElement === 'string' ? dom.activeElement : undefined,
  ])[0]
}

function resolveFocusedTargetConfidence(
  snapshot: DesktopSnapshot,
  anchors: string[],
  windowAnchor: string | undefined,
  domAnchor: string | undefined,
): number {
  if (!windowAnchor && !domAnchor) {
    return anchors.length > 0 ? 0.25 : 0.12
  }

  if (snapshot.focusedWindow && snapshot.windows.includes(snapshot.focusedWindow)) {
    return 0.92
  }

  if (windowAnchor) {
    return 0.78
  }

  return 0.64
}

function resolveObservationConfidence(
  snapshot: DesktopSnapshot,
  anchors: string[],
  windowAnchor: string | undefined,
  domAnchor: string | undefined,
  domSummary: string | undefined,
  focusedTargetConfidence: number,
  observationMode: DesktopSnapshot['observationMode'],
): number {
  let score = 0.1

  if (windowAnchor) {
    score += 0.28
  }
  if (domAnchor) {
    score += 0.22
  }
  if (snapshot.windows.length > 0) {
    score += 0.14
  }
  if (anchors.length > 0) {
    score += 0.08
  }
  if (domSummary) {
    score += 0.12
  }
  if (snapshot.focusedWindow) {
    score += focusedTargetConfidence * 0.2
  }
  if (observationMode === 'dom') {
    score += 0.06
  }

  if (!windowAnchor && !domAnchor) {
    score -= 0.12
  }

  return Math.max(0.05, Math.min(0.98, Number(score.toFixed(2))))
}

function resolveObservationRecoveryPoint(
  snapshot: DesktopSnapshot,
  windowAnchor: string | undefined,
  domAnchor: string | undefined,
  observationMode: DesktopSnapshot['observationMode'],
): string | undefined {
  return (
    snapshot.recoveryPoint ??
    (windowAnchor ? `focus:${windowAnchor}` : undefined) ??
    (domAnchor ? `dom:${domAnchor}` : undefined) ??
    (observationMode ? `observe:${observationMode}` : undefined)
  )
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []

  for (const value of values) {
    const normalized = value?.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    deduped.push(normalized)
  }

  return deduped
}

function mergeInteractiveElements(
  primary: DesktopInteractiveElement[],
  secondary: DesktopInteractiveElement[],
): DesktopInteractiveElement[] {
  const merged: DesktopInteractiveElement[] = []
  const seen = new Set<string>()

  for (const element of [...primary, ...secondary]) {
    const key = [
      element.label ?? '',
      normalizeInteractiveElementText(element.window) ?? '',
      normalizeInteractiveElementText(element.controlType) ?? '',
      normalizeInteractiveElementText(element.name) ?? '',
      element.x ?? '',
      element.y ?? '',
    ].join('|')

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    merged.push(element)
  }

  return merged
}

function parseCoordinatePayload(
  value: string | undefined,
): { x: number; y: number } | undefined {
  if (!value) {
    return undefined
  }

  const rectMatch = value.match(/\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\]/)
  if (rectMatch) {
    const left = Number(rectMatch[1])
    const top = Number(rectMatch[2])
    const right = Number(rectMatch[3])
    const bottom = Number(rectMatch[4])
    if ([left, top, right, bottom].every(Number.isFinite)) {
      return {
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
      }
    }
  }

  const pointMatch = value.match(/\((\d+)\s*,\s*(\d+)\)/)
  if (pointMatch) {
    const x = Number(pointMatch[1])
    const y = Number(pointMatch[2])
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y }
    }
  }

  return undefined
}

function scoreInteractiveElementNameMatch(
  candidate: string | undefined,
  query: string,
  queryAliases: string[],
  matchMode: 'contains' | 'exact',
): number {
  if (!candidate) {
    return 0
  }

  if (candidate === query || queryAliases.includes(candidate)) {
    return 120
  }

  if (matchMode === 'exact') {
    return 0
  }

  if (candidate.includes(query) || queryAliases.some(alias => candidate.includes(alias))) {
    return 90
  }

  const queryTokens = query.split(' ').filter(Boolean)
  if (queryTokens.length > 0 && queryTokens.every(token => candidate.includes(token))) {
    return 60
  }

  return 0
}

function matchesInteractiveElementText(
  candidate: string | undefined,
  query: string,
  queryAliases: string[],
  matchMode: 'contains' | 'exact',
): boolean {
  const normalizedCandidate = normalizeInteractiveElementText(candidate)
  if (!normalizedCandidate) {
    return false
  }

  if (matchMode === 'exact') {
    return normalizedCandidate === query || queryAliases.includes(normalizedCandidate)
  }

  return (
    normalizedCandidate.includes(query) ||
    queryAliases.some(alias => normalizedCandidate.includes(alias)) ||
    query.includes(normalizedCandidate) ||
    queryAliases.some(alias => alias.includes(normalizedCandidate))
  )
}

function snapshotMatchesWindowTitle(
  snapshot: DesktopSnapshot,
  windowTitle: string,
): boolean {
  const normalizedWindowTitle = normalizeInteractiveElementText(windowTitle)
  const windowTitleAliases = buildInteractiveElementNameAliases(windowTitle)
  if (!normalizedWindowTitle || windowTitleAliases.length === 0) {
    return false
  }

  const candidates = dedupeStrings([
    snapshot.focusedWindow,
    snapshot.windowAnchor,
    snapshot.domAnchor,
    ...snapshot.windows,
    ...extractSnapshotWindowVerificationCandidates(snapshot.raw),
  ])

  return candidates.some(candidate =>
    matchesInteractiveElementText(
      candidate,
      normalizedWindowTitle,
      windowTitleAliases,
      'contains',
    ),
  )
}

function extractSnapshotWindowVerificationCandidates(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) {
    return []
  }

  const candidate = raw as Record<string, unknown>
  const directValues = [
    candidate.title,
    candidate.app,
    candidate.application,
    candidate.focusedWindow,
  ]
  const dom =
    typeof candidate.dom === 'object' && candidate.dom !== null
      ? (candidate.dom as Record<string, unknown>)
      : undefined
  const domValues = dom
    ? [
        typeof dom.title === 'string' ? dom.title : undefined,
        typeof dom.activeWindow === 'string' ? dom.activeWindow : undefined,
      ]
    : []

  return dedupeStrings(
    [...directValues, ...domValues].filter((value): value is string => typeof value === 'string'),
  )
}

function normalizeInteractiveElementText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim().toLowerCase()
  return normalized || undefined
}

function buildInteractiveElementNameAliases(value: string | undefined): string[] {
  const normalized = normalizeInteractiveElementText(value)
  if (!normalized) {
    return []
  }

  const aliases = new Set<string>([normalized])

  switch (normalized) {
    case 'weixin':
    case '微信':
      aliases.add('weixin')
      aliases.add('微信')
      break
    case '进入微信':
      aliases.add('进入微信')
      aliases.add('进入')
      aliases.add('微信')
      aliases.add('weixin')
      break
    case '登录':
    case '我知道了':
    case '取消':
    case '切换账号':
    case '软件':
      aliases.add(normalized)
      break
    default:
      break
  }

  return [...aliases]
}

function buildInteractiveElementControlTypeAliases(
  value: string | undefined,
): string[] {
  const normalized = normalizeInteractiveElementText(value)
  if (!normalized) {
    return []
  }

  const aliases = new Set<string>([normalized])

  switch (normalized) {
    case 'edit':
      aliases.add('编辑')
      aliases.add('文本编辑器')
      aliases.add('textbox')
      aliases.add('text box')
      aliases.add('输入')
      break
    case 'textbox':
    case 'text box':
      aliases.add('edit')
      aliases.add('编辑')
      aliases.add('文本编辑器')
      aliases.add('输入')
      break
    case '按钮':
    case 'button':
      aliases.add('button')
      aliases.add('按钮')
      break
    case '菜单项目':
    case 'menu item':
      aliases.add('menu item')
      aliases.add('菜单项目')
      break
    default:
      break
  }

  return [...aliases]
}

function isStableInputControlName(value: string | undefined): boolean {
  const normalized = normalizeInteractiveElementText(value)
  if (!normalized) {
    return false
  }

  return /^(edit|textbox|text box|文本编辑器|编辑|输入|input|text)$/i.test(normalized)
}

function isDesktopActionResult(value: unknown): value is DesktopActionResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.ok === 'boolean' &&
    typeof candidate.summary === 'string'
  )
}

function isUnsupportedAppListModeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message.includes("Input should be 'launch', 'resize' or 'switch'") ||
    error.message.includes('literal_error')
  )
}

function isUnsupportedAppListPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  const messages = [candidate.error, candidate.summary, candidate.raw]
  return messages.some(message => {
    if (typeof message !== 'string') {
      return false
    }

    return isUnsupportedAppListModeText(message)
  })
}

function isUnsupportedAppListModeText(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.includes('launch') &&
    normalized.includes('resize') &&
    normalized.includes('switch') &&
    (normalized.includes('not support') ||
      normalized.includes('unsupported') ||
      normalized.includes('input should'))
  )
}

function isActionErrorText(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    /^error[:\s]/i.test(value) ||
    normalized.includes(' not found') ||
    normalized.includes('failed') ||
    normalized.includes('denied') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout')
  )
}
