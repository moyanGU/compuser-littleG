import type {
  CapabilityDefinition,
  CapabilityExecuteContext,
  CapabilityFailureClass,
  CapabilityFailureReason,
  CapabilityObservation,
  CapabilityOperation,
  CapabilityRecoveryAction,
} from './Capability.js'
import type { DesktopSnapshot } from '../adapters/windows-mcp/WindowsMcpAdapter.js'
import { findDesktopInteractiveElement } from '../adapters/windows-mcp/WindowsMcpAdapter.js'
import { executeNestedTool } from './Capability.js'
import { basename, dirname } from 'node:path'

const PHASE4_TEMPLATE_ROUTING_POLICY = [
  'backend-first',
  'browser-dom-first',
  'desktop-observe-fallback',
  'gui-last',
] as const

function readTemplateChainCurrentTarget(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const chainState = (data as { chainState?: unknown }).chainState
  if (typeof chainState !== 'object' || chainState === null) {
    return undefined
  }

  const currentTarget = (chainState as { currentTarget?: unknown }).currentTarget
  return typeof currentTarget === 'string' && currentTarget.trim()
    ? currentTarget
    : undefined
}

function readTemplateChainCurrentArtifact(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const chainState = (data as { chainState?: unknown }).chainState
  if (typeof chainState !== 'object' || chainState === null) {
    return undefined
  }

  const currentArtifact = (chainState as { currentArtifact?: unknown }).currentArtifact
  return typeof currentArtifact === 'string' && currentArtifact.trim()
    ? currentArtifact
    : undefined
}

function deriveTemplateFailureReason(data: unknown): CapabilityFailureReason {
  if (typeof data === 'object' && data !== null) {
    const failureReason = (data as { failureReason?: unknown }).failureReason
    if (
      failureReason === 'routing_failed' ||
      failureReason === 'observation_insufficient' ||
      failureReason === 'focus_drift' ||
      failureReason === 'verification_failed' ||
      failureReason === 'execution_failed'
    ) {
      return failureReason
    }
  }

  const chainStatus = readCapabilityChainStatus(data)
  return chainStatus === 'verified_failed'
    ? 'verification_failed'
    : 'execution_failed'
}

function deriveTemplateRecoveryAction(
  data: unknown,
  failureReason: CapabilityFailureReason,
): CapabilityRecoveryAction {
  if (typeof data === 'object' && data !== null) {
    const recoveryAction = (data as { recoveryAction?: unknown }).recoveryAction
    if (
      recoveryAction === 'recover:refocus' ||
      recoveryAction === 'recover:reobserve' ||
      recoveryAction === 'recover:reroute' ||
      recoveryAction === 'recover:restage'
    ) {
      return recoveryAction
    }
  }

  if (failureReason === 'focus_drift') {
    return 'recover:refocus'
  }
  if (failureReason === 'observation_insufficient') {
    return 'recover:reobserve'
  }
  if (failureReason === 'routing_failed') {
    return 'recover:reroute'
  }

  return 'recover:restage'
}

function readCapabilityObservation(
  data: unknown,
): CapabilityObservation | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const observation = (data as { observation?: unknown }).observation
  return typeof observation === 'object' && observation !== null
    ? (observation as CapabilityObservation)
    : undefined
}

function buildTemplateChainState(
  data: unknown,
  input: {
    currentTarget: string
    currentArtifact: string
    fallbackChainStatus:
      | 'verified'
      | 'completed'
      | 'verified_failed'
      | 'execution_failed'
      | 'routing_failed'
      | 'environment_unready'
    fallbackAnchor?: string
  },
) {
  const observation = readCapabilityObservation(data)
  const chainStatus = readCapabilityChainStatus(data)
  const failureReason = deriveTemplateFailureReason(data)
  const anchorMatches = dedupeCandidateStrings([
    readCapabilityLastVerifiedAnchor(data),
    observation?.windowAnchor,
    observation?.domAnchor,
    observation?.textAnchor,
  ])

  return {
    currentTarget: input.currentTarget,
    currentArtifact: input.currentArtifact,
    lastVerifiedAnchor:
      readCapabilityLastVerifiedAnchor(data) ??
      input.fallbackAnchor ??
      input.currentTarget,
    observationConfidence: observation?.confidence,
    observationSource: observation?.mode,
    anchorMatches: anchorMatches.length > 0 ? anchorMatches : undefined,
    chainStatus:
      chainStatus === 'verified_failed' ||
      chainStatus === 'execution_failed' ||
      chainStatus === 'completed' ||
      chainStatus === 'blocked' ||
      chainStatus === 'environment_unready'
        ? chainStatus
        : chainStatus === 'routing_failed'
          ? 'routing_failed'
          : failureReason === 'observation_insufficient'
            ? 'environment_unready'
            : chainStatus ?? input.fallbackChainStatus,
  } as const
}

function buildPhase5TemplateOutput(
  output: Record<string, unknown> | undefined,
  input: {
    selectedWindowTitle: string
    currentArtifact: string
  },
): Record<string, unknown> {
  const normalized = { ...(output ?? {}) }
  const extractedText = extractRecordString(normalized, 'extractedText')
  const transformedText = extractRecordString(normalized, 'transformedText')
  const deliveredText =
    extractRecordString(normalized, 'deliveredText') ??
    transformedText ??
    extractedText

  return {
    ...normalized,
    selectedWindowTitle:
      extractRecordString(normalized, 'selectedWindowTitle') ??
      extractRecordString(normalized, 'targetWindowTitle') ??
      extractRecordString(normalized, 'chatTargetWindowTitle') ??
      extractRecordString(normalized, 'finalTargetWindowTitle') ??
      input.selectedWindowTitle,
    currentArtifact:
      extractRecordString(normalized, 'currentArtifact') ??
      extractRecordString(normalized, 'sourcePath') ??
      input.currentArtifact,
    ...(extractedText ? { extractedText } : {}),
    ...(transformedText ? { transformedText } : {}),
    ...(deliveredText ? { deliveredText } : {}),
  }
}

export function createBuiltinCapabilities(): CapabilityDefinition[] {
  const desktopObserve: CapabilityDefinition<
    Record<string, never>,
    {
      usedTool: string
      observation: unknown
      toolPointer?: string
    }
  > = {
    id: 'desktop.observe',
    kind: 'skill',
    availability: 'discoverable',
    title: 'Desktop Observe',
    description:
      'Observe the desktop using a structured snapshot first, then fall back to screenshot.',
    searchHints: [
      'desktop observe snapshot screenshot',
      'screen inspect current desktop',
    ],
    tags: ['desktop', 'windows', 'observe', 'snapshot', 'screenshot'],
    preferredRoute: 'tool',
    riskLevel: 'low',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'desktop observe input',
    },
    examples: [
      {
        task: 'Look at the current desktop state first.',
        input: {},
      },
    ],
    fallbacks: ['windows.snapshot', 'windows.screenshot'],
    async execute(_input, context) {
      const operations: CapabilityOperation[] = []
      const snapshotResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.snapshot',
      )
      operations.push({
        type: 'tool',
        target: 'windows.snapshot',
        ok: snapshotResult.ok,
        summary: snapshotResult.summary,
      })

      if (snapshotResult.ok) {
        const observation = await resolveDesktopSnapshotFromToolResult(
          context,
          snapshotResult,
        )
        const evaluation = evaluateDesktopObservation(observation)
        const observationSufficient = evaluation.sufficient
        const verificationPassed =
          readCapabilityVerificationPassed(snapshotResult.data) !== false &&
          observationSufficient
        return {
          ok: verificationPassed,
          summary: verificationPassed
            ? `Observed desktop via snapshot. ${snapshotResult.summary}`
            : `Desktop snapshot returned, but observation confidence is insufficient. ${snapshotResult.summary}`,
          route: 'tool',
          data: {
            usedTool: 'windows.snapshot',
            observation: observation ?? snapshotResult.data,
            toolPointer: snapshotResult.pointer,
          },
          error: verificationPassed || !observation ? undefined : 'DESKTOP_OBSERVATION_LOW_CONFIDENCE',
          failureClass: verificationPassed ? undefined : 'deterministic',
          operations,
          chainState: buildObservationChainState(observation),
          recoveryPoint: verificationPassed ? undefined : evaluation.recoveryPoint,
          verificationEvidence: evaluation.evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'snapshot-first',
            passed: verificationPassed,
            details: verificationPassed
              ? 'Structured snapshot was returned successfully.'
              : 'Structured snapshot returned but confidence/anchors were insufficient for safe observation.',
          },
        }
      }

      const screenshotResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.screenshot',
      )
      operations.push({
        type: 'tool',
        target: 'windows.screenshot',
        ok: screenshotResult.ok,
        summary: screenshotResult.summary,
      })

      return {
        ok: screenshotResult.ok,
        summary: screenshotResult.ok
          ? `Snapshot failed; recovered with screenshot. ${screenshotResult.summary}`
          : `Desktop observation failed. snapshot=${snapshotResult.summary}; screenshot=${screenshotResult.summary}`,
        route: 'tool',
        data: screenshotResult.ok
          ? {
              usedTool: 'windows.screenshot',
              observation: screenshotResult.data,
              toolPointer: screenshotResult.pointer,
            }
          : undefined,
        error:
          screenshotResult.ok && !snapshotResult.ok
            ? snapshotResult.error
            : screenshotResult.error ?? snapshotResult.error,
        failureClass:
          screenshotResult.ok && !snapshotResult.ok
            ? snapshotResult.failureClass
            : screenshotResult.failureClass ?? snapshotResult.failureClass,
        operations,
        chainState: buildObservationChainState(
          screenshotResult.ok
            ? await resolveDesktopSnapshotFromToolResult(context, screenshotResult)
            : undefined,
        ),
        verificationEvidence: buildObservationEvidence(
          screenshotResult.ok
            ? await resolveDesktopSnapshotFromToolResult(context, screenshotResult)
            : undefined,
        ),
        recoveryUsed: screenshotResult.ok,
        verification: {
          strategy: 'snapshot-then-screenshot',
          passed: screenshotResult.ok,
          details: screenshotResult.ok
            ? 'Recovered using screenshot fallback.'
            : 'Both snapshot and screenshot failed.',
        },
      }
    },
  }

  const inspectTree: CapabilityDefinition<
    {
      path?: string
      depth?: number
      limit?: number
    },
    {
      root: string
      entries: Array<{
        path: string
        type: 'file' | 'dir'
        size?: number
      }>
    }
  > = {
    id: 'workspace.inspect_tree',
    kind: 'command',
    availability: 'discoverable',
    title: 'Workspace Inspect Tree',
    description: 'Inspect workspace tree structure through backend PowerShell.',
    searchHints: [
      'workspace tree inspect list files',
      'directory structure backend',
    ],
    tags: ['workspace', 'filesystem', 'tree', 'backend', 'cli'],
    preferredRoute: 'cli',
    riskLevel: 'low',
    retryPolicy: {
      retryable: true,
      maxAttempts: 2,
      retryOn: ['transient'],
    },
    inputSchema: {
      description: 'workspace inspect tree input',
      properties: {
        path: { type: 'string' },
        depth: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    examples: [
      {
        task: 'Show the current workspace tree.',
        input: {
          path: '.',
          depth: 2,
          limit: 20,
        },
      },
    ],
    fallbacks: ['workspace.glob'],
    async execute(input, context) {
      const cliAdapter = requireCliAdapter(context, 'command.workspace.inspect_tree')
      const resolvedPath = input.path?.trim() || context.toolContext.cwd
      const depth = clampNumber(input.depth, 2, 0, 8)
      const limit = clampNumber(input.limit, 30, 1, 200)
      const script = [
        `$root = (Resolve-Path -LiteralPath '${escapePowerShellLiteral(resolvedPath)}').Path`,
        `$depth = ${depth}`,
        `$limit = ${limit}`,
        `$entries = Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop |`,
        `  Where-Object { ((Resolve-Path -LiteralPath $_.FullName).Path.Substring($root.Length).TrimStart('\\') -split '\\\\').Count -le $depth } |`,
        `  Select-Object -First $limit @{Name='path';Expression={$_.FullName}}, @{Name='type';Expression={ if ($_.PSIsContainer) { 'dir' } else { 'file' }}}, @{Name='size';Expression={ if ($_.PSIsContainer) { $null } else { $_.Length } }}`,
        `$result = @{ root = $root; entries = @($entries) }`,
        `$result | ConvertTo-Json -Depth 5 -Compress`,
      ].join('\n')

      const cliResult = await cliAdapter.runPowerShell(script, {
        cwd: context.toolContext.cwd,
      })
      const operations: CapabilityOperation[] = [
        {
          type: 'cli',
          target: 'powershell:Get-ChildItem',
          ok: cliResult.ok,
          summary: cliResult.summary,
        },
      ]

      if (!cliResult.ok) {
        return cliFailureResult(
          'cli',
          cliResult,
          operations,
          'backend-cli',
          'Workspace tree inspection failed.',
        )
      }

      const parsed = parseJsonOutput(cliResult.stdout) as {
        root?: string
        entries?: Array<{
          path?: string
          type?: 'file' | 'dir'
          size?: number
        }>
      }
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries
            .filter(entry => typeof entry.path === 'string')
            .map(entry => ({
              path: entry.path as string,
              type: entry.type === 'dir' ? ('dir' as const) : ('file' as const),
              size:
                typeof entry.size === 'number' && Number.isFinite(entry.size)
                  ? entry.size
                  : undefined,
            }))
        : []

      return {
        ok: true,
        summary: `Inspected workspace tree via backend. root=${parsed.root ?? resolvedPath}; entries=${entries.length}`,
        route: 'cli',
        data: {
          root: parsed.root ?? resolvedPath,
          entries,
        },
        operations,
        verification: {
          strategy: 'powershell-get-childitem',
          passed: true,
          details: `PowerShell returned ${entries.length} entries.`,
        },
      }
    },
  }

  const searchText: CapabilityDefinition<
    {
      query: string
      path?: string
      limit?: number
      includePattern?: string
    },
    {
      root: string
      matches: Array<{
        path: string
        lineNumber: number
        line: string
      }>
    }
  > = {
    id: 'workspace.search_text',
    kind: 'command',
    availability: 'discoverable',
    title: 'Workspace Search Text',
    description: 'Search workspace text through backend PowerShell.',
    searchHints: [
      'workspace search text backend',
      'grep query project source',
    ],
    tags: ['workspace', 'search', 'text', 'backend', 'cli'],
    preferredRoute: 'cli',
    riskLevel: 'low',
    retryPolicy: {
      retryable: true,
      maxAttempts: 2,
      retryOn: ['transient'],
    },
    inputSchema: {
      description: 'workspace search text input',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' },
        includePattern: { type: 'string' },
      },
      required: ['query'],
    },
    examples: [
      {
        task: 'Search for QueryEngine in the project.',
        input: {
          query: 'QueryEngine',
          path: '.',
          limit: 20,
          includePattern: '*.ts',
        },
      },
    ],
    fallbacks: ['workspace.grep'],
    async execute(input, context) {
      const cliAdapter = requireCliAdapter(context, 'command.workspace.search_text')
      const resolvedPath = input.path?.trim() || context.toolContext.cwd
      const limit = clampNumber(input.limit, 20, 1, 100)
      const includePattern = input.includePattern?.trim() || '*'
      const script = [
        `$root = (Resolve-Path -LiteralPath '${escapePowerShellLiteral(resolvedPath)}').Path`,
        `$pattern = '${escapePowerShellLiteral(includePattern)}'`,
        `$query = '${escapePowerShellLiteral(input.query)}'`,
        `$limit = ${limit}`,
        `$matches = Get-ChildItem -LiteralPath $root -File -Force -Recurse -ErrorAction Stop |`,
        `  Where-Object { $_.Name -like $pattern } |`,
        `  Select-String -Pattern $query -SimpleMatch |`,
        `  Select-Object -First $limit Path, LineNumber, Line`,
        `$result = @{ root = $root; matches = @($matches) }`,
        `$result | ConvertTo-Json -Depth 5 -Compress`,
      ].join('\n')

      const cliResult = await cliAdapter.runPowerShell(script, {
        cwd: context.toolContext.cwd,
      })
      const operations: CapabilityOperation[] = [
        {
          type: 'cli',
          target: 'powershell:Select-String',
          ok: cliResult.ok,
          summary: cliResult.summary,
        },
      ]

      if (!cliResult.ok) {
        return cliFailureResult(
          'cli',
          cliResult,
          operations,
          'backend-cli',
          'Workspace text search failed.',
        )
      }

      const parsed = parseJsonOutput(cliResult.stdout) as {
        root?: string
        matches?:
          | {
              Path?: string
              LineNumber?: number
              Line?: string
            }
          | Array<{
              Path?: string
              LineNumber?: number
              Line?: string
            }>
      }
      const rawMatches = Array.isArray(parsed.matches)
        ? parsed.matches
        : parsed.matches
          ? [parsed.matches]
          : []
      const matches = rawMatches
        .filter(match => typeof match.Path === 'string')
        .map(match => ({
          path: match.Path as string,
          lineNumber:
            typeof match.LineNumber === 'number' ? match.LineNumber : 0,
          line: typeof match.Line === 'string' ? match.Line : '',
        }))

      return {
        ok: true,
        summary: `Searched workspace text via backend. matches=${matches.length}`,
        route: 'cli',
        data: {
          root: parsed.root ?? resolvedPath,
          matches,
        },
        operations,
        verification: {
          strategy: 'powershell-select-string',
          passed: true,
          details: `PowerShell returned ${matches.length} matches.`,
        },
      }
    },
  }

  const readText: CapabilityDefinition<
    {
      path: string
      offset?: number
      limit?: number
    },
    {
      path: string
      startLine: number
      endLine: number
      lines: string[]
    }
  > = {
    id: 'workspace.read_text',
    kind: 'command',
    availability: 'discoverable',
    title: 'Workspace Read Text',
    description: 'Read a text file through backend PowerShell.',
    searchHints: [
      'workspace read file text backend',
      'open file project source',
    ],
    tags: ['workspace', 'read', 'file', 'backend', 'cli'],
    preferredRoute: 'cli',
    riskLevel: 'low',
    retryPolicy: {
      retryable: true,
      maxAttempts: 2,
      retryOn: ['transient'],
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
    examples: [
      {
        task: 'Read package.json.',
        input: {
          path: 'package.json',
          offset: 1,
          limit: 20,
        },
      },
    ],
    fallbacks: ['workspace.read_text'],
    async execute(input, context) {
      const cliAdapter = requireCliAdapter(context, 'command.workspace.read_text')
      const offset = clampNumber(input.offset, 1, 1, 100_000)
      const limit = clampNumber(input.limit, 40, 1, 500)
      const filePath = input.path.trim()
      const script = [
        `$path = (Resolve-Path -LiteralPath '${escapePowerShellLiteral(filePath)}').Path`,
        `$offset = ${offset}`,
        `$limit = ${limit}`,
        `$lines = @(Get-Content -LiteralPath $path -Encoding UTF8 -ErrorAction Stop | Select-Object -Skip ($offset - 1) -First $limit | ForEach-Object { [string]$_ })`,
        `$result = @{ path = $path; startLine = $offset; endLine = ($offset + @($lines).Count - 1); lines = @($lines) }`,
        `$result | ConvertTo-Json -Depth 5 -Compress`,
      ].join('\n')

      const cliResult = await cliAdapter.runPowerShell(script, {
        cwd: context.toolContext.cwd,
      })
      const operations: CapabilityOperation[] = [
        {
          type: 'cli',
          target: 'powershell:Get-Content',
          ok: cliResult.ok,
          summary: cliResult.summary,
        },
      ]

      if (!cliResult.ok) {
        return cliFailureResult(
          'cli',
          cliResult,
          operations,
          'backend-cli',
          'Workspace file read failed.',
        )
      }

      const parsed = parseJsonOutput(cliResult.stdout) as {
        path?: string
        startLine?: number
        endLine?: number
        lines?: string | string[]
      }
      const lines = Array.isArray(parsed.lines)
        ? parsed.lines.map(line => String(line))
        : typeof parsed.lines === 'string'
          ? [parsed.lines]
          : []

      return {
        ok: true,
        summary: `Read text file via backend. lines=${lines.length}`,
        route: 'cli',
        data: {
          path: parsed.path ?? filePath,
          startLine:
            typeof parsed.startLine === 'number' ? parsed.startLine : offset,
          endLine:
            typeof parsed.endLine === 'number'
              ? parsed.endLine
              : offset + lines.length - 1,
          lines,
        },
        operations,
        verification: {
          strategy: 'powershell-get-content',
          passed: true,
          details: `PowerShell returned ${lines.length} lines.`,
        },
      }
    },
  }

  const appOpenOrFocus: CapabilityDefinition<
    {
      appName: string
    },
    {
      appName: string
      focused: boolean
    }
  > = {
    id: 'app.open_or_focus',
    kind: 'command',
    title: 'Open Or Focus App',
    description: 'Focus an app window first, then launch it if needed.',
    searchHints: ['app open focus launch switch window'],
    tags: ['desktop', 'app', 'focus', 'launch'],
    preferredRoute: 'tool',
    riskLevel: 'medium',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'app open or focus input',
      properties: {
        appName: { type: 'string' },
      },
      required: ['appName'],
    },
    examples: [
      {
        task: 'Open Notepad or focus it if already open.',
        input: {
          appName: 'Notepad',
        },
      },
    ],
    fallbacks: ['windows.focus_window', 'windows.app'],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const focusResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.focus_window',
        { windowTitle: input.appName },
      )
      operations.push({
        type: 'tool',
        target: 'windows.focus_window',
        ok: focusResult.ok,
        summary: focusResult.summary,
      })

      if (focusResult.ok) {
        const focusVerified = await verifyWindowAvailable(context, input.appName)
        return {
          ok: focusVerified,
          summary: focusVerified
            ? `Focused app window ${input.appName}.`
            : `Focus command returned success, but ${input.appName} was not confirmed afterward.`,
          route: 'tool',
          data: {
            appName: input.appName,
            focused: focusVerified,
          },
          error: focusVerified ? undefined : 'WINDOW_FOCUS_VERIFICATION_FAILED',
          failureClass: focusVerified ? undefined : 'deterministic',
          operations,
          recoveryUsed: false,
          verification: {
            strategy: 'focus-first',
            passed: focusVerified,
            details: focusVerified
              ? 'Existing target window was focused and confirmed.'
              : 'Focus command succeeded, but the expected target window was not confirmed by follow-up observation.',
          },
        }
      }

      const backendLaunchScript = buildBackendLaunchScript(input.appName)
      if (backendLaunchScript) {
        const shellLaunchResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.shell',
          {
            command: backendLaunchScript,
          },
        )
        operations.push({
          type: 'tool',
          target: 'windows.shell',
          ok: shellLaunchResult.ok,
          summary: shellLaunchResult.summary,
        })

        if (shellLaunchResult.ok) {
          await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.wait',
            { durationSeconds: 1 },
          )

          const refocusResult = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.focus_window',
            { windowTitle: input.appName },
          )
          operations.push({
            type: 'tool',
            target: 'windows.focus_window',
            ok: refocusResult.ok,
            summary: refocusResult.summary,
          })

          const refocusVerified = await verifyWindowAvailable(
            context,
            input.appName,
          )

          if (refocusVerified) {
            return {
              ok: true,
              summary: `Launched app ${input.appName} through backend shell recovery.`,
              route: 'tool',
              data: {
                appName: input.appName,
                focused: true,
              },
              operations,
              recoveryUsed: true,
              verification: {
                strategy: 'focus-then-shell-launch-verify',
                passed: true,
                details:
                  'Backend shell launch succeeded and the target app became available afterward.',
              },
            }
          }
        }
      }

      const launchResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.app',
        {
          mode: 'launch',
          name: input.appName,
        },
      )
      operations.push({
        type: 'tool',
        target: 'windows.app',
        ok: launchResult.ok,
        summary: launchResult.summary,
      })

      if (launchResult.ok) {
        await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.wait',
          { durationSeconds: 1 },
        )

        const launchVerified = await verifyWindowAvailable(
          context,
          input.appName,
        )

        if (launchVerified) {
          return {
            ok: true,
            summary: `Launched app ${input.appName}.`,
            route: 'tool',
            data: {
              appName: input.appName,
              focused: true,
            },
            operations,
            recoveryUsed: true,
            verification: {
              strategy: 'focus-then-launch',
              passed: true,
              details: 'App was launched and confirmed after fallback.',
            },
          }
        }
      }

      return {
        ok: false,
        summary: launchResult.ok
          ? `Launched app ${input.appName}, but it was not confirmed afterward.`
          : `Failed to focus or launch ${input.appName}.`,
        route: 'tool',
        data: {
          appName: input.appName,
          focused: false,
        },
        error:
          launchResult.ok
            ? 'WINDOW_LAUNCH_VERIFICATION_FAILED'
            : launchResult.error ?? focusResult.error,
        failureClass:
          launchResult.ok
            ? 'deterministic'
            : launchResult.failureClass ?? focusResult.failureClass,
        operations,
        recoveryUsed: launchResult.ok,
        verification: {
          strategy: 'focus-then-launch',
          passed: false,
          details: launchResult.ok
            ? 'App launch fallback succeeded, but the target app was not confirmed afterward.'
            : 'Neither focus nor launch succeeded.',
        },
      }
    },
  }

  const desktopCaptureAndLocate: CapabilityDefinition<
    {
      query?: string
    },
    {
      usedTool: string
      observation: unknown
      query?: string
    }
  > = {
    id: 'desktop.capture_and_locate',
    kind: 'command',
    title: 'Desktop Capture And Locate',
    description:
      'Capture desktop state and return the structured observation that can be used to locate a UI target.',
    searchHints: ['desktop capture locate target observe verify'],
    tags: ['desktop', 'observe', 'locate', 'snapshot'],
    preferredRoute: 'tool',
    riskLevel: 'low',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'desktop capture and locate input',
      properties: {
        query: { type: 'string' },
      },
    },
    examples: [
      {
        task: 'Capture the desktop and locate the target app before acting.',
        input: {
          query: 'Notepad',
        },
      },
    ],
    fallbacks: ['skill.desktop.observe', 'windows.snapshot', 'windows.screenshot'],
    async execute(input, context) {
      const observeResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.desktop.observe',
      )
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.desktop.observe',
          ok: observeResult.ok,
          summary: observeResult.summary,
        },
      ]
      const observation = readNestedObservationSnapshot(observeResult.data)
      const evaluation = evaluateDesktopObservation(observation)
      const queryMatched = matchesQueryAgainstObservation(
        observation,
        input.query,
      )
      const verificationPassed =
        observeResult.ok &&
        readCapabilityVerificationPassed(observeResult.data) !== false &&
        queryMatched
      const failureReason: CapabilityFailureReason | undefined = !observeResult.ok
        ? 'observation_insufficient'
        : !evaluation.sufficient
          ? 'observation_insufficient'
          : !queryMatched
            ? 'focus_drift'
            : undefined

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Captured desktop state for target location. ${observeResult.summary}`
          : observeResult.ok
            ? 'Captured desktop state, but the observation is not yet safe to act on for the requested target.'
            : 'Failed to capture desktop state for target location.',
        route: 'tool',
        data: observeResult.ok
          ? {
              usedTool: 'skill.desktop.observe',
              observation: observeResult.data,
              query: input.query,
            }
          : undefined,
        error: verificationPassed
          ? observeResult.error
          : failureReason === 'focus_drift'
            ? 'DESKTOP_OBSERVATION_TARGET_MISMATCH'
            : observeResult.error ?? 'DESKTOP_OBSERVATION_INSUFFICIENT',
        failureClass: verificationPassed
          ? observeResult.failureClass
          : observeResult.failureClass ?? 'deterministic',
        failureReason,
        operations,
        chainState: {
          currentTarget: input.query,
          currentArtifact: 'desktop-capture-locate',
          lastVerifiedAnchor: verificationPassed ? evaluation.anchor ?? input.query : undefined,
          chainStatus: verificationPassed ? 'completed' : 'verified_failed',
        },
        recoveryPoint: verificationPassed
          ? undefined
          : failureReason === 'focus_drift'
            ? `focus:${input.query}`
            : evaluation.recoveryPoint ?? `observe:${observation?.observationMode ?? 'snapshot'}`,
        recoveryAction: verificationPassed
          ? undefined
          : failureReason === 'focus_drift'
            ? 'recover:refocus'
            : evaluation.recoveryAction ?? 'recover:reobserve',
        observation: evaluation.observation,
        verificationEvidence: dedupeCandidateStrings([
          `query=${input.query ?? ''}`,
          queryMatched ? 'match=confirmed' : 'match=mismatch',
          ...evaluation.evidence,
          ...readCapabilityVerificationEvidence(observeResult.data),
        ]),
        recoveryUsed: false,
        verification: {
          strategy: 'observe-before-locate',
          passed: verificationPassed,
          details: observeResult.ok
            ? queryMatched
              ? 'Observation payload matched the requested target query.'
              : 'Observation payload was captured, but it did not match the requested target query, so the chain must recover before acting.'
            : 'Observation payload could not be captured.',
        },
      }
    },
  }

  const clipboardReadWrite: CapabilityDefinition<
    {
      mode: 'get' | 'set'
      text?: string
    },
    {
      mode: 'get' | 'set'
      text?: string
    }
  > = {
    id: 'clipboard.read_write',
    kind: 'command',
    title: 'Clipboard Read Write',
    description: 'Read from or write to the Windows clipboard.',
    searchHints: ['clipboard copy paste transfer text'],
    tags: ['desktop', 'clipboard', 'copy', 'paste'],
    preferredRoute: 'tool',
    riskLevel: 'medium',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'clipboard read write input',
      properties: {
        mode: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['mode'],
    },
    examples: [
      {
        task: 'Copy a string to the clipboard.',
        input: {
          mode: 'set',
          text: 'hello world',
        },
      },
    ],
    fallbacks: ['windows.clipboard'],
    async execute(input, context) {
      const clipboardResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.clipboard',
        input.mode === 'set'
          ? { mode: input.mode, text: input.text ?? '' }
          : { mode: input.mode },
      )

      if (input.mode === 'set' && clipboardResult.ok) {
        const verifyResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.clipboard',
          { mode: 'get' },
        )
        const verifiedText = extractClipboardText(verifyResult.data)
        const verified = verifyResult.ok && verifiedText === input.text

        return {
          ok: verified,
          summary: verified
            ? clipboardResult.summary
            : `Clipboard write succeeded, but the written text was not confirmed.`,
          route: 'tool',
          data: {
            mode: input.mode,
            text: input.text,
          },
          error: verified ? clipboardResult.error : 'CLIPBOARD_WRITE_VERIFICATION_FAILED',
          failureClass: verified ? clipboardResult.failureClass : 'deterministic',
          recoveryUsed: false,
          operations: [
            {
              type: 'tool',
              target: 'windows.clipboard',
              ok: clipboardResult.ok,
              summary: clipboardResult.summary,
            },
            {
              type: 'tool',
              target: 'windows.clipboard',
              ok: verifyResult.ok,
              summary: verifyResult.summary,
            },
          ],
          verification: {
            strategy: 'clipboard-tool',
            passed: verified,
            details: verified
              ? 'Clipboard write was confirmed by a read-back check.'
              : 'Clipboard write completed, but the read-back check did not match.',
          },
        }
      }

      if (input.mode === 'get') {
        const readText = extractClipboardText(clipboardResult.data)
        const readVerified = clipboardResult.ok && typeof readText === 'string'

        return {
          ok: readVerified,
          summary: readVerified
            ? clipboardResult.summary
            : 'Clipboard read succeeded, but no text was confirmed.',
          route: 'tool',
          data: {
            mode: input.mode,
            text: readText,
          },
          error: readVerified ? clipboardResult.error : 'CLIPBOARD_READ_VERIFICATION_FAILED',
          failureClass: readVerified ? clipboardResult.failureClass : 'deterministic',
          recoveryUsed: false,
          operations: [
            {
              type: 'tool',
              target: 'windows.clipboard',
              ok: clipboardResult.ok,
              summary: clipboardResult.summary,
            },
          ],
          verification: {
            strategy: 'clipboard-tool',
            passed: readVerified,
            details: readVerified
              ? 'Clipboard read was confirmed.'
              : 'Clipboard read completed, but no text was confirmed.',
          },
        }
      }

      return {
        ok: clipboardResult.ok,
        summary: clipboardResult.summary,
        route: 'tool',
        data: {
          mode: input.mode,
          text:
            input.mode === 'set'
              ? input.text
              : extractClipboardText(clipboardResult.data),
        },
        error: clipboardResult.error,
        failureClass: clipboardResult.failureClass,
        recoveryUsed: false,
        operations: [
          {
            type: 'tool',
            target: 'windows.clipboard',
            ok: clipboardResult.ok,
            summary: clipboardResult.summary,
          },
        ],
        verification: {
          strategy: 'clipboard-tool',
          passed: clipboardResult.ok,
          details: clipboardResult.ok
            ? 'Clipboard operation completed.'
            : 'Clipboard operation failed.',
        },
      }
    },
  }

  const browserInspectDom: CapabilityDefinition<
    Record<string, never>,
    {
      observation: unknown
    }
  > = {
    id: 'browser.inspect_dom',
    kind: 'command',
    title: 'Browser Inspect DOM',
    description:
      'Inspect the active browser using DOM-first snapshot mode before falling back to generic desktop observation.',
    searchHints: ['browser dom inspect snapshot use_dom active tab'],
    tags: ['browser', 'dom', 'snapshot', 'inspect'],
    preferredRoute: 'tool',
    riskLevel: 'low',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser inspect dom input',
    },
    examples: [
      {
        task: 'Inspect the active browser tab DOM.',
        input: {},
      },
    ],
    fallbacks: ['windows.snapshot', 'skill.desktop.observe'],
    async execute(_input, context) {
      const operations: CapabilityOperation[] = []
      const domSnapshot = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.snapshot',
        { useDom: true },
      )
      operations.push({
        type: 'tool',
        target: 'windows.snapshot',
        ok: domSnapshot.ok,
        summary: domSnapshot.summary,
      })

      if (domSnapshot.ok) {
        const observation = await resolveDesktopSnapshotFromToolResult(
          context,
          domSnapshot,
        )
        const evaluation = evaluateDesktopObservation(observation)
        const observationSufficient = evaluation.sufficient
        const verificationPassed =
          readCapabilityVerificationPassed(domSnapshot.data) !== false &&
          observationSufficient
        return {
          ok: verificationPassed,
          summary: verificationPassed
            ? `Inspected browser DOM via snapshot. ${domSnapshot.summary}`
            : `Browser DOM snapshot returned but observation is insufficient. ${domSnapshot.summary}`,
          route: 'tool',
          data: {
            observation: observation ?? domSnapshot.data,
          },
          error:
            verificationPassed || !observation
              ? undefined
              : 'BROWSER_DOM_OBSERVATION_LOW_CONFIDENCE',
          failureClass: verificationPassed ? undefined : 'deterministic',
          operations,
          chainState: buildObservationChainState(observation),
          recoveryPoint: verificationPassed ? undefined : evaluation.recoveryPoint,
          verificationEvidence: evaluation.evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'snapshot-dom-first',
            passed: verificationPassed,
            details: verificationPassed
              ? 'DOM-oriented snapshot succeeded.'
              : 'DOM snapshot returned but anchor/confidence quality is too low.',
          },
        }
      }

      const observeResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.desktop.observe',
      )
      operations.push({
        type: 'tool',
        target: 'skill.desktop.observe',
        ok: observeResult.ok,
        summary: observeResult.summary,
      })

      return {
        ok: observeResult.ok,
        summary: observeResult.ok
          ? `DOM snapshot failed; recovered with desktop observation. ${observeResult.summary}`
          : 'Browser inspection failed.',
        route: 'tool',
        data: observeResult.ok
          ? {
              observation: observeResult.data,
            }
          : undefined,
        error: observeResult.error ?? domSnapshot.error,
        failureClass: observeResult.failureClass ?? domSnapshot.failureClass,
        operations,
        chainState: buildObservationChainState(
          observeResult.ok ? readNestedObservationSnapshot(observeResult.data) : undefined,
        ),
        recoveryPoint: observeResult.ok
          ? readNestedObservationSnapshot(observeResult.data)?.recoveryPoint ?? 'command.browser.inspect_dom'
          : 'command.browser.inspect_dom',
        verificationEvidence: buildObservationEvidence(
          observeResult.ok ? readNestedObservationSnapshot(observeResult.data) : undefined,
        ),
        recoveryUsed: observeResult.ok,
        verification: {
          strategy: 'snapshot-dom-then-observe',
          passed: observeResult.ok,
          details: observeResult.ok
            ? 'Recovered with generic observation after DOM snapshot failure.'
            : 'Neither DOM snapshot nor generic observation succeeded.',
        },
      }
    },
  }

  const browserExtractThenTransfer: CapabilityDefinition<
    {
      targetWindowTitle: string
      pressEnter?: boolean
    },
    {
      extractedText: string
      targetWindowTitle: string
      transferred: boolean
    }
  > = {
    id: 'browser.extract_then_transfer',
    kind: 'skill',
    title: 'Browser Extract Then Transfer',
    description:
      'Inspect the active browser DOM, extract transferable text, then send it to a target app.',
    searchHints: ['browser extract text dom transfer target app'],
    tags: ['browser', 'dom', 'extract', 'transfer', 'clipboard'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser extract then transfer input',
      properties: {
        targetWindowTitle: { type: 'string' },
        pressEnter: { type: 'boolean' },
      },
      required: ['targetWindowTitle'],
    },
    examples: [
      {
        task: 'Extract text from the active browser page and paste it into Notepad.',
        input: {
          targetWindowTitle: 'Notepad',
        },
      },
    ],
    fallbacks: ['command.browser.inspect_dom', 'skill.cross_app.transfer_text'],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const submitWithEnter =
        input.pressEnter === true || shouldSubmitWithEnter(input.targetWindowTitle)
      const browserInspectResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.browser.inspect_dom',
      )
      operations.push({
        type: 'tool',
        target: 'command.browser.inspect_dom',
        ok: browserInspectResult.ok,
        summary: browserInspectResult.summary,
      })

      const browserObservation = readNestedObservationSnapshot(browserInspectResult.data)
      const evidence = buildObservationEvidence(browserObservation)
      const extractedText = extractBrowserTransferText(browserObservation)
      if (extractedText) {
        evidence.push(`extracted=${truncateEvidenceText(extractedText)}`)
      }

      if (!browserInspectResult.ok || !extractedText) {
        return {
          ok: false,
          summary: browserInspectResult.ok
            ? 'Browser inspection succeeded, but no transferable text was extracted.'
            : 'Failed to inspect the browser before transfer.',
          route: 'tool',
          error: browserInspectResult.error,
          failureClass: browserInspectResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: 'browser',
            currentArtifact: 'browser-dom-extract',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'browser-dom-extract-then-transfer',
            passed: false,
            details: browserInspectResult.ok
              ? 'DOM observation was available, but no stable text payload could be extracted.'
              : 'DOM inspection failed before transfer could begin.',
          },
        }
      }

      const transferResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.transfer_text',
        {
          text: extractedText,
          targetWindowTitle: input.targetWindowTitle,
          ...(submitWithEnter ? { pressEnter: true } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.transfer_text',
        ok: transferResult.ok,
        summary: transferResult.summary,
      })

      const transferPassed =
        transferResult.ok && readCapabilityVerificationPassed(transferResult.data) !== false
      return {
        ok: transferPassed,
        summary: transferPassed
          ? `Extracted browser text and transferred it into ${input.targetWindowTitle}.`
          : `Extracted browser text, but transfer into ${input.targetWindowTitle} failed.`,
        route: 'tool',
        data: {
          extractedText,
          targetWindowTitle: input.targetWindowTitle,
          transferred: transferPassed,
        },
        error: transferPassed ? undefined : transferResult.error,
        failureClass: transferPassed
          ? undefined
          : transferResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: input.targetWindowTitle,
          currentArtifact: 'browser-dom-extract',
          lastVerifiedAnchor:
            browserObservation?.anchors?.[0] ?? input.targetWindowTitle,
          chainStatus: transferPassed ? 'completed' : 'execution_failed',
        },
        recoveryPoint: transferPassed
          ? undefined
          : `focus:${input.targetWindowTitle}`,
        verificationEvidence: [
          ...evidence,
          ...(submitWithEnter ? ['submitAction=enter'] : []),
          ...readCapabilityVerificationEvidence(transferResult.data),
        ],
        recoveryUsed: readCapabilityRecoveryUsed(transferResult.data),
        verification: {
          strategy: 'browser-dom-extract-clipboard-transfer',
          passed: transferPassed,
          details: transferPassed
            ? 'Transferable text was extracted from the browser and the transfer capability completed successfully.'
            : 'Transfer capability failed after browser text extraction.',
        },
      }
    },
  }

  const browserClickElementByName: CapabilityDefinition<
    {
      name: string
      windowTitle?: string
      matchMode?: 'contains' | 'exact'
      button?: 'left' | 'right' | 'middle'
    },
    {
      clicked: boolean
      elementName: string
      windowTitle?: string
    }
  > = {
    id: 'browser.click_element_by_name',
    kind: 'skill',
    title: 'Browser Click Element By Name',
    description: 'Click a visible browser element by name.',
    searchHints: ['browser click element name link button'],
    tags: ['browser', 'click', 'link', 'button'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser click element by name input',
      properties: {
        name: { type: 'string' },
        windowTitle: { type: 'string' },
        matchMode: { type: 'string' },
        button: { type: 'string' },
      },
      required: ['name'],
    },
    examples: [
      {
        task: 'Click the login link in the browser.',
        input: {
          name: '登录',
          windowTitle: 'Microsoft Edge',
        },
      },
    ],
    fallbacks: ['command.browser.inspect_dom', 'windows.click_element_by_name'],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const focusResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.app.open_or_focus',
        { appName: input.windowTitle ?? 'Microsoft Edge' },
      )
      operations.push({
        type: 'tool',
        target: 'command.app.open_or_focus',
        ok: focusResult.ok,
        summary: focusResult.summary,
      })

      if (!focusResult.ok) {
        const appName = input.windowTitle ?? 'Microsoft Edge'
        const switchResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.app',
          {
            mode: 'switch',
            name: appName,
          },
        )
        operations.push({
          type: 'tool',
          target: 'windows.app',
          ok: switchResult.ok,
          summary: switchResult.summary,
        })

        if (!switchResult.ok) {
          return {
            ok: false,
            summary: `Failed to focus browser window for ${input.name}.`,
            route: 'tool',
            error: focusResult.error ?? switchResult.error,
            failureClass:
              switchResult.failureClass ?? focusResult.failureClass ?? 'deterministic',
            operations,
            recoveryPoint: `focus:${appName}`,
            recoveryUsed: false,
            verification: {
              strategy: 'browser-click-by-name',
              passed: false,
              details: 'Browser window could not be focused before clicking.',
            },
          }
        }
      }

      const clickResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.click_element_by_name',
        {
          name: input.name,
          windowTitle: input.windowTitle ?? 'Microsoft Edge',
          matchMode: input.matchMode,
          button: input.button,
        },
      )
      operations.push({
        type: 'tool',
        target: 'windows.click_element_by_name',
        ok: clickResult.ok,
        summary: clickResult.summary,
      })

      const clicked =
        clickResult.ok && readCapabilityVerificationPassed(clickResult.data) !== false
      return {
        ok: clicked,
        summary: clicked
          ? `Clicked browser element "${input.name}".`
          : `Failed to click browser element "${input.name}".`,
        route: 'tool',
        data: {
          clicked,
          elementName: input.name,
          windowTitle: input.windowTitle ?? 'Microsoft Edge',
        },
        error: clicked ? undefined : clickResult.error,
        failureClass: clicked ? undefined : clickResult.failureClass ?? 'deterministic',
        operations,
        recoveryPoint: clicked ? undefined : `focus:${input.windowTitle ?? 'Microsoft Edge'}`,
        recoveryUsed: false,
        verification: {
          strategy: 'browser-click-by-name',
          passed: clicked,
          details: clicked
            ? 'Browser element click was completed and verified.'
            : 'Browser element click could not be verified.',
        },
      }
    },
  }

  const fileReadTransformTransfer: CapabilityDefinition<
    {
      path: string
      targetWindowTitle: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
      pressEnter?: boolean
    },
    {
      sourcePath: string
      transformedText: string
      targetWindowTitle: string
      transferred: boolean
    }
  > = {
    id: 'file_read_transform_transfer',
    kind: 'skill',
    title: 'File Read Transform Transfer',
    description:
      'Read local text through the backend path, apply a small transform, then transfer it into a target app.',
    searchHints: ['file read transform transfer target app'],
    tags: ['workspace', 'file', 'backend', 'transform', 'transfer'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file read transform transfer input',
      properties: {
        path: { type: 'string' },
        targetWindowTitle: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
        pressEnter: { type: 'boolean' },
      },
      required: ['path', 'targetWindowTitle'],
    },
    examples: [
      {
        task: 'Read a local note and paste it into Notepad in uppercase.',
        input: {
          path: 'notes.txt',
          targetWindowTitle: 'Notepad',
          transform: 'uppercase',
        },
      },
    ],
    fallbacks: ['command.workspace.read_text', 'skill.cross_app.open_observe_act_verify'],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const readInput = {
        path: input.path,
        ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      }
      let readResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'workspace.read_text',
        readInput,
      )
      operations.push({
        type: 'tool',
        target: 'workspace.read_text',
        ok: readResult.ok,
        summary: readResult.summary,
      })

      if (!readResult.ok) {
        readResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'command.workspace.read_text',
          readInput,
        )
        operations.push({
          type: 'tool',
          target: 'command.workspace.read_text',
          ok: readResult.ok,
          summary: readResult.summary,
        })
      }

      const readOutput = readWorkspaceReadOutput(readResult.data)
      const transformedText = transformTransferText(
        readOutput.lines.join('\n'),
        input.transform,
      )
      const evidence = [
        `source=${readOutput.path}`,
        `lines=${readOutput.startLine}-${readOutput.endLine}`,
        `transform=${input.transform ?? 'none'}`,
      ]
      if (transformedText) {
        evidence.push(`extracted=${truncateEvidenceText(transformedText)}`)
      }

      if (!readResult.ok || !transformedText.trim()) {
        return {
          ok: false,
          summary: readResult.ok
            ? `Read ${input.path}, but the transformed payload is empty.`
            : `Failed to read ${input.path} before transfer.`,
          route: 'cli',
          error: readResult.error,
          failureClass: readResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: readOutput.path,
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.workspace.read_text',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'backend-read-transform-transfer',
            passed: false,
            details: readResult.ok
              ? 'Backend read succeeded, but the transformed payload was empty.'
              : 'Backend read failed before transfer could begin.',
          },
        }
      }

      const transferResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: normalizeBrowserAppTarget(input.targetWindowTitle),
          targetWindowTitle: normalizeBrowserWindowTarget(input.targetWindowTitle),
          text: transformedText,
          ...(input.pressEnter === true ? { pressEnter: true } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: transferResult.ok,
        summary: transferResult.summary,
      })

      const transferPassed =
        transferResult.ok && readCapabilityVerificationPassed(transferResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(transferResult.data) ??
        (transferPassed ? 'completed' : 'execution_failed')
      return {
        ok: transferPassed,
        summary: transferPassed
          ? `Read ${readOutput.path}, transformed it, and verified it through the editor chain for ${input.targetWindowTitle}.`
          : `Read ${readOutput.path}, but the editor chain failed for ${input.targetWindowTitle}.`,
        route: 'cli',
        data: {
          sourcePath: readOutput.path,
          transformedText,
          targetWindowTitle: input.targetWindowTitle,
          transferred: transferPassed,
        },
        error: transferPassed ? undefined : transferResult.error,
        failureClass: transferPassed
          ? undefined
          : transferResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: input.targetWindowTitle,
          currentArtifact: readOutput.path,
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(transferResult.data) ??
            input.targetWindowTitle,
          chainStatus,
        },
        recoveryPoint: transferPassed
          ? undefined
          : `focus:${input.targetWindowTitle}`,
        verificationEvidence: [
          ...evidence,
          ...readCapabilityVerificationEvidence(transferResult.data),
        ],
        recoveryUsed: readCapabilityRecoveryUsed(transferResult.data),
        output: {
          sourcePath: readOutput.path,
          transformedText,
          targetWindowTitle: input.targetWindowTitle,
          transferred: transferPassed,
        },
        verification: {
          strategy: 'backend-read-transform-open-observe-act-verify',
          passed: transferPassed,
          details: transferPassed
            ? 'Backend file content was transformed and the downstream editor verification chain completed successfully.'
            : 'Editor verification chain failed after backend read and transform.',
        },
      }
    },
  }

  const browserToEditorCaptureVerify: CapabilityDefinition<
    {
      appName: string
      targetWindowTitle?: string
    },
    {
      extractedText: string
      appName: string
      targetWindowTitle: string
      verified: boolean
    }
  > = {
    id: 'browser_to_editor.capture_verify',
    kind: 'skill',
    title: 'Browser To Editor Capture Verify',
    description:
      'Capture text from the active browser DOM, then run a full open/observe/act/verify transfer into an editor target.',
    searchHints: ['browser to editor capture verify dom transfer'],
    tags: ['browser', 'editor', 'dom', 'verify', 'cross-app'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser to editor capture verify input',
      properties: {
        appName: { type: 'string' },
        targetWindowTitle: { type: 'string' },
      },
      required: ['appName'],
    },
    examples: [
      {
        task: 'Capture text from the browser and verify it lands in Notepad.',
        input: {
          appName: 'Notepad',
          targetWindowTitle: 'Notepad',
        },
      },
    ],
    fallbacks: ['command.browser.inspect_dom', 'skill.cross_app.open_observe_act_verify'],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const targetWindowTitle = input.targetWindowTitle ?? input.appName
      const browserInspectResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.browser.inspect_dom',
      )
      operations.push({
        type: 'tool',
        target: 'command.browser.inspect_dom',
        ok: browserInspectResult.ok,
        summary: browserInspectResult.summary,
      })

      const browserObservation = readNestedObservationSnapshot(browserInspectResult.data)
      const extractedText = extractBrowserTransferText(browserObservation)
      const evidence = buildObservationEvidence(browserObservation)
      if (extractedText) {
        evidence.push(`extracted=${truncateEvidenceText(extractedText)}`)
      }

      if (!browserInspectResult.ok || !extractedText) {
        return {
          ok: false,
          summary: browserInspectResult.ok
            ? 'Browser capture succeeded, but no editor-ready text was extracted.'
            : 'Failed to capture browser content before the editor transfer chain.',
          route: 'tool',
          error: browserInspectResult.error,
          failureClass: browserInspectResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: 'browser',
            currentArtifact: 'browser-dom',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'browser-capture-before-editor-chain',
            passed: false,
            details: browserInspectResult.ok
              ? 'Browser capture was available, but no stable text payload could be extracted.'
              : 'Browser capture failed before the editor chain could begin.',
          },
        }
      }

      const chainResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: input.appName,
          targetWindowTitle,
          text: extractedText,
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: chainResult.ok,
        summary: chainResult.summary,
      })

      const verificationPassed =
        chainResult.ok && readCapabilityVerificationPassed(chainResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(chainResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')
      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Captured browser content and verified it through the editor chain for ${targetWindowTitle}.`
          : `Captured browser content, but the editor verification chain failed for ${targetWindowTitle}.`,
        route: 'tool',
        data: {
          extractedText,
          appName: input.appName,
          targetWindowTitle,
          verified: verificationPassed,
        },
        error: verificationPassed ? undefined : chainResult.error,
        failureClass: verificationPassed
          ? undefined
          : chainResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: targetWindowTitle,
          currentArtifact: 'browser-dom-extract',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(chainResult.data) ??
            browserObservation?.anchors?.[0] ??
            targetWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed ? undefined : `focus:${targetWindowTitle}`,
        verificationEvidence: [
          ...evidence,
          ...readCapabilityVerificationEvidence(chainResult.data),
        ],
        recoveryUsed: readCapabilityRecoveryUsed(chainResult.data),
        verification: {
          strategy: 'browser-capture-open-observe-act-verify',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Browser content was captured and the downstream editor chain completed with verification.'
            : 'The downstream open/observe/act/verify editor chain failed after browser capture.',
        },
      }
    },
  }

  const browserRouteCaptureTransfer: CapabilityDefinition<
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery: string
      browserWindowTitle?: string
    },
    {
      extractedText: string
      selectedWindowTitle: string
      routeReason: string
      verified: boolean
    }
  > = {
    id: 'browser.route_capture_transfer',
    kind: 'skill',
    title: 'Browser Route Capture Transfer',
    description:
      'Capture transferable text from the active browser, route across two candidate windows, then complete a verified transfer into the selected target.',
    searchHints: ['browser route capture transfer multi window verify'],
    tags: ['browser', 'route', 'capture', 'transfer', 'cross-app'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser route capture transfer input',
      properties: {
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        browserWindowTitle: { type: 'string' },
      },
      required: ['primaryWindowTitle', 'secondaryWindowTitle', 'routeQuery'],
    },
    examples: [
      {
        task: 'Capture text from the browser, pick the better matching target window, and verify the transfer there.',
        input: {
          primaryWindowTitle: 'Codex',
          secondaryWindowTitle: 'å¾®ä¿¡',
          routeQuery: 'å¾®ä¿¡',
        },
      },
    ],
    fallbacks: [
      'command.browser.inspect_dom',
      'skill.app.switch_collect_compare',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const browserInspectResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.browser.inspect_dom',
      )
      operations.push({
        type: 'tool',
        target: 'command.browser.inspect_dom',
        ok: browserInspectResult.ok,
        summary: browserInspectResult.summary,
      })

      const browserObservation = readNestedObservationSnapshot(browserInspectResult.data)
      const extractedText = extractBrowserTransferText(browserObservation)
      const browserEvidence = buildObservationEvidence(browserObservation)
      if (extractedText) {
        browserEvidence.push(`extracted=${truncateEvidenceText(extractedText)}`)
      }

      if (!browserInspectResult.ok || !extractedText) {
        return {
          ok: false,
          summary: browserInspectResult.ok
            ? 'Browser capture succeeded, but no transferable text was extracted before routing.'
            : 'Browser capture failed before routing and transfer.',
          route: 'tool',
          error: browserInspectResult.error,
          failureClass: browserInspectResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: input.browserWindowTitle ?? 'browser',
            currentArtifact: 'browser-dom',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: browserEvidence,
          recoveryUsed: false,
          verification: {
            strategy: 'browser-capture-route-transfer',
            passed: false,
            details: browserInspectResult.ok
              ? 'Browser capture completed, but no stable text payload could be extracted for routing.'
              : 'Browser capture failed before routing could begin.',
          },
        }
      }

      const compareResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.app.switch_collect_compare',
        {
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.app.switch_collect_compare',
        ok: compareResult.ok,
        summary: compareResult.summary,
      })

      if (!compareResult.ok) {
        return {
          ok: false,
          summary: 'Browser capture succeeded, but target comparison failed before routing.',
          route: 'tool',
          error: compareResult.error,
          failureClass: compareResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'window-comparison',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'execution_failed',
          },
          recoveryPoint: `focus:${input.primaryWindowTitle}`,
          verificationEvidence: [
            ...browserEvidence,
            ...readCapabilityVerificationEvidence(compareResult.data),
          ],
          recoveryUsed: readCapabilityRecoveryUsed(compareResult.data),
          verification: {
            strategy: 'browser-capture-route-transfer',
            passed: false,
            details: 'Window comparison failed after browser capture succeeded.',
          },
        }
      }

      const compareOutput =
        typeof compareResult.data === 'object' &&
        compareResult.data !== null &&
        typeof (compareResult.data as { output?: unknown }).output === 'object' &&
        (compareResult.data as { output?: unknown }).output !== null
          ? ((compareResult.data as { output?: unknown }).output as {
              primaryEvidence?: string[]
              secondaryEvidence?: string[]
            })
          : undefined
      const primaryEvidence = Array.isArray(compareOutput?.primaryEvidence)
        ? compareOutput.primaryEvidence
        : []
      const secondaryEvidence = Array.isArray(compareOutput?.secondaryEvidence)
        ? compareOutput.secondaryEvidence
        : []
      const selectedRoute = selectWindowRoute({
        primaryWindowTitle: input.primaryWindowTitle,
        primaryEvidence,
        secondaryWindowTitle: input.secondaryWindowTitle,
        secondaryEvidence,
        routeQuery: input.routeQuery,
      })

      const chainResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: selectedRoute.selectedWindowTitle,
          targetWindowTitle: selectedRoute.selectedWindowTitle,
          text: extractedText,
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: chainResult.ok,
        summary: chainResult.summary,
      })

      const verificationPassed =
        chainResult.ok && readCapabilityVerificationPassed(chainResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(chainResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Captured browser text, routed to ${selectedRoute.selectedWindowTitle}, and verified the transfer.`
          : `Captured browser text and routed to ${selectedRoute.selectedWindowTitle}, but verified transfer failed.`,
        route: 'tool',
        data: {
          extractedText,
          selectedWindowTitle: selectedRoute.selectedWindowTitle,
          routeReason: selectedRoute.reason,
          verified: verificationPassed,
        },
        error: verificationPassed ? undefined : chainResult.error,
        failureClass: verificationPassed
          ? undefined
          : chainResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: selectedRoute.selectedWindowTitle,
          currentArtifact: 'browser-route-transfer',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(chainResult.data) ??
            browserObservation?.anchors?.[0] ??
            selectedRoute.selectedWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : `focus:${selectedRoute.selectedWindowTitle}`,
        verificationEvidence: [
          ...browserEvidence,
          `routeQuery=${input.routeQuery}`,
          `routeReason=${selectedRoute.reason}`,
          ...primaryEvidence,
          ...secondaryEvidence,
          ...readCapabilityVerificationEvidence(chainResult.data),
        ],
        recoveryUsed:
          readCapabilityRecoveryUsed(compareResult.data) ||
          readCapabilityRecoveryUsed(chainResult.data),
        verification: {
          strategy: 'browser-capture-route-open-observe-act-verify',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Browser text was captured, routed to the best matching target window, and the downstream verified editor chain succeeded.'
            : 'Browser text was captured and routed, but the downstream verified transfer chain failed.',
        },
      }
    },
  }

  const browserEditorStageAndDeliver: CapabilityDefinition<
    {
      editorAppName: string
      editorTargetWindowTitle?: string
      finalAppName: string
      finalTargetWindowTitle?: string
    },
    {
      extractedText: string
      editorTargetWindowTitle: string
      finalTargetWindowTitle: string
      staged: boolean
      delivered: boolean
    }
  > = {
    id: 'browser.editor_stage_and_deliver',
    kind: 'skill',
    title: 'Browser Editor Stage And Deliver',
    description:
      'Capture browser text into a verified editor staging target, then deliver the staged text into a final desktop target.',
    searchHints: ['browser editor stage deliver final target'],
    tags: ['browser', 'editor', 'staging', 'delivery', 'cross-app'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser editor stage and deliver input',
      properties: {
        editorAppName: { type: 'string' },
        editorTargetWindowTitle: { type: 'string' },
        finalAppName: { type: 'string' },
        finalTargetWindowTitle: { type: 'string' },
      },
      required: ['editorAppName', 'finalAppName'],
    },
    examples: [
      {
        task: 'Stage browser content in Notepad, verify it there, then deliver the same content into WeChat.',
        input: {
          editorAppName: 'Notepad',
          editorTargetWindowTitle: 'Notepad',
          finalAppName: 'WeChat',
          finalTargetWindowTitle: 'WeChat',
        },
      },
    ],
    fallbacks: [
      'skill.browser_to_editor.capture_verify',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const editorTargetWindowTitle =
        input.editorTargetWindowTitle ?? input.editorAppName
      const finalTargetWindowTitle =
        input.finalTargetWindowTitle ?? input.finalAppName

      const stageResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser_to_editor.capture_verify',
        {
          appName: input.editorAppName,
          targetWindowTitle: editorTargetWindowTitle,
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.browser_to_editor.capture_verify',
        ok: stageResult.ok,
        summary: stageResult.summary,
      })

      const extractedText = readCapabilityOutputString(stageResult.data, 'extractedText')
      const stageEvidence = readCapabilityVerificationEvidence(stageResult.data)

      if (!stageResult.ok || !extractedText) {
        return {
          ok: false,
          summary: stageResult.ok
            ? `Browser staging into ${editorTargetWindowTitle} succeeded, but no reusable text payload was returned.`
            : `Failed to stage browser content into ${editorTargetWindowTitle}.`,
          route: 'tool',
          error: stageResult.error,
          failureClass: stageResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: editorTargetWindowTitle,
            currentArtifact: 'browser-editor-stage',
            lastVerifiedAnchor:
              readCapabilityLastVerifiedAnchor(stageResult.data) ??
              editorTargetWindowTitle,
            chainStatus: stageResult.ok ? 'verified_failed' : 'execution_failed',
          },
          recoveryPoint: `focus:${editorTargetWindowTitle}`,
          verificationEvidence: [
            `stageTarget=${editorTargetWindowTitle}`,
            ...stageEvidence,
          ],
          recoveryUsed: readCapabilityRecoveryUsed(stageResult.data),
          verification: {
            strategy: 'browser-stage-then-deliver',
            passed: false,
            details: stageResult.ok
              ? 'Editor staging completed, but no extracted browser payload was exposed for final delivery.'
              : 'Browser-to-editor staging failed before final delivery could begin.',
          },
        }
      }

      const deliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: input.finalAppName,
          targetWindowTitle: finalTargetWindowTitle,
          text: extractedText,
          ...(shouldSubmitWithEnter(finalTargetWindowTitle) ? { pressEnter: true } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: deliverResult.ok,
        summary: deliverResult.summary,
      })

      const verificationPassed =
        deliverResult.ok && readCapabilityVerificationPassed(deliverResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(deliverResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Captured browser content, verified it in ${editorTargetWindowTitle}, and delivered it into ${finalTargetWindowTitle}.`
          : `Captured browser content and staged it in ${editorTargetWindowTitle}, but final delivery into ${finalTargetWindowTitle} failed.`,
        route: 'tool',
        data: {
          extractedText,
          selectedWindowTitle: finalTargetWindowTitle,
          editorTargetWindowTitle,
          finalTargetWindowTitle,
          currentStage: verificationPassed ? 'verified' : 'delivered',
          currentArtifact: 'browser-editor-final-delivery',
          staged: true,
          delivered: verificationPassed,
        },
        error: verificationPassed ? undefined : deliverResult.error,
        failureClass: verificationPassed
          ? undefined
          : deliverResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: finalTargetWindowTitle,
          currentArtifact: 'browser-editor-final-delivery',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(deliverResult.data) ??
            readCapabilityLastVerifiedAnchor(stageResult.data) ??
            finalTargetWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : `focus:${finalTargetWindowTitle}`,
        verificationEvidence: [
          `stageTarget=${editorTargetWindowTitle}`,
          `finalTarget=${finalTargetWindowTitle}`,
          ...(shouldSubmitWithEnter(finalTargetWindowTitle)
            ? ['submitAction=enter']
            : []),
          ...stageEvidence,
          ...readCapabilityVerificationEvidence(deliverResult.data),
        ],
        recoveryUsed:
          readCapabilityRecoveryUsed(stageResult.data) ||
          readCapabilityRecoveryUsed(deliverResult.data),
        verification: {
          strategy: 'browser-stage-verify-then-final-deliver',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Browser content was staged through the editor verification chain, then delivered successfully into the final desktop target.'
            : 'Editor staging succeeded, but the final open/observe/act/verify delivery chain failed.',
        },
      }
    },
  }

  const browserEditorChatStageAndDeliver: CapabilityDefinition<
    {
      editorAppName: string
      editorTargetWindowTitle?: string
      chatAppName: string
      chatTargetWindowTitle?: string
    },
    {
      extractedText: string
      editorTargetWindowTitle: string
      chatTargetWindowTitle: string
      staged: boolean
      delivered: boolean
    }
  > = {
    id: 'browser.editor_chat_stage_and_deliver',
    kind: 'skill',
    title: 'Browser Editor Chat Stage And Deliver',
    description:
      'Capture browser text into a verified editor staging target, then deliver the staged text into a chat or IM target.',
    searchHints: ['browser editor chat stage deliver chat target'],
    tags: ['browser', 'editor', 'chat', 'staging', 'delivery', 'cross-app'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser editor chat stage and deliver input',
      properties: {
        editorAppName: { type: 'string' },
        editorTargetWindowTitle: { type: 'string' },
        chatAppName: { type: 'string' },
        chatTargetWindowTitle: { type: 'string' },
      },
      required: ['editorAppName', 'chatAppName'],
    },
    examples: [
      {
        task: 'Stage browser content in Notepad, verify it there, then deliver the same content into Codex chat.',
        input: {
          editorAppName: 'Notepad',
          editorTargetWindowTitle: 'Notepad',
          chatAppName: 'Codex',
          chatTargetWindowTitle: 'Codex',
        },
      },
    ],
    fallbacks: [
      'skill.browser.editor_stage_and_deliver',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const editorTargetWindowTitle =
        input.editorTargetWindowTitle ?? input.editorAppName
      const chatTargetWindowTitle =
        input.chatTargetWindowTitle ?? input.chatAppName

      const stageDeliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser.editor_stage_and_deliver',
        {
          editorAppName: input.editorAppName,
          editorTargetWindowTitle,
          finalAppName: input.chatAppName,
          finalTargetWindowTitle: chatTargetWindowTitle,
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.browser.editor_stage_and_deliver',
        ok: stageDeliverResult.ok,
        summary: stageDeliverResult.summary,
      })

      const extractedText = readCapabilityOutputString(
        stageDeliverResult.data,
        'extractedText',
      )
      const stageEvidence = readCapabilityVerificationEvidence(stageDeliverResult.data)

      if (!stageDeliverResult.ok || !extractedText) {
        return {
          ok: false,
          summary: stageDeliverResult.ok
            ? `Browser staging into ${editorTargetWindowTitle} succeeded, but no reusable text payload was returned for ${chatTargetWindowTitle}.`
            : `Failed to stage browser content into ${editorTargetWindowTitle} before delivering to ${chatTargetWindowTitle}.`,
          route: 'tool',
          error: stageDeliverResult.error,
          failureClass: stageDeliverResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: chatTargetWindowTitle,
            currentArtifact: 'browser-editor-chat-stage',
            lastVerifiedAnchor:
              readCapabilityLastVerifiedAnchor(stageDeliverResult.data) ??
              chatTargetWindowTitle,
            chainStatus: stageDeliverResult.ok ? 'verified_failed' : 'execution_failed',
          },
          recoveryPoint: `focus:${chatTargetWindowTitle}`,
          verificationEvidence: [
            `stageTarget=${editorTargetWindowTitle}`,
            `chatTarget=${chatTargetWindowTitle}`,
            ...stageEvidence,
          ],
          recoveryUsed: readCapabilityRecoveryUsed(stageDeliverResult.data),
          verification: {
            strategy: 'browser-stage-then-chat-deliver',
            passed: false,
            details: stageDeliverResult.ok
              ? 'Editor staging completed, but no extracted browser payload was exposed for chat delivery.'
              : 'Browser-to-editor staging failed before chat delivery could begin.',
          },
        }
      }

      const verificationPassed =
        readCapabilityVerificationPassed(stageDeliverResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(stageDeliverResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Captured browser content, verified it in ${editorTargetWindowTitle}, and delivered it into ${chatTargetWindowTitle}.`
          : `Captured browser content and staged it in ${editorTargetWindowTitle}, but final delivery into ${chatTargetWindowTitle} failed.`,
        route: 'tool',
        data: {
          extractedText,
          selectedWindowTitle: chatTargetWindowTitle,
          editorTargetWindowTitle,
          chatTargetWindowTitle,
          currentStage: verificationPassed ? 'verified' : 'delivered',
          currentArtifact: 'browser-editor-chat-delivery',
          staged: true,
          delivered: verificationPassed,
        },
        error: verificationPassed ? undefined : stageDeliverResult.error,
        failureClass: verificationPassed
          ? undefined
          : stageDeliverResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: chatTargetWindowTitle,
          currentArtifact: 'browser-editor-chat-delivery',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(stageDeliverResult.data) ??
            chatTargetWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : `focus:${chatTargetWindowTitle}`,
        verificationEvidence: [
          `stageTarget=${editorTargetWindowTitle}`,
          `chatTarget=${chatTargetWindowTitle}`,
          ...stageEvidence,
          ...readCapabilityVerificationEvidence(stageDeliverResult.data),
        ],
        recoveryUsed: readCapabilityRecoveryUsed(stageDeliverResult.data),
        verification: {
          strategy: 'browser-stage-verify-then-chat-deliver',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Browser content was staged through the editor verification chain, then delivered successfully into the chat target.'
            : 'Editor staging succeeded, but the final open/observe/act/verify chat delivery chain failed.',
        },
      }
    },
  }

  const browserEditorChatStageAndDeliverVerify: CapabilityDefinition<
    {
      editorAppName: string
      editorTargetWindowTitle?: string
      chatAppName: string
      chatTargetWindowTitle?: string
    },
    {
      extractedText: string
      editorTargetWindowTitle: string
      chatTargetWindowTitle: string
      selectedWindowTitle: string
      staged: boolean
      delivered: boolean
      verified: boolean
      currentStage: 'verified'
      currentArtifact: string
    }
  > = {
    id: 'browser.editor_chat_stage_and_deliver_verify',
    kind: 'skill',
    title: 'Browser Editor Chat Stage And Deliver Verify',
    description:
      'Stage browser text through a verified editor chain, then confirm the chat delivery outcome. ',
    searchHints: ['browser editor chat stage deliver verify chat target'],
    tags: ['browser', 'editor', 'chat', 'staging', 'delivery', 'verify', 'cross-app'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser editor chat stage and deliver verify input',
      properties: {
        editorAppName: { type: 'string' },
        editorTargetWindowTitle: { type: 'string' },
        chatAppName: { type: 'string' },
        chatTargetWindowTitle: { type: 'string' },
      },
      required: ['editorAppName', 'chatAppName'],
    },
    examples: [
      {
        task: 'Stage browser content in Notepad, verify it there, then confirm delivery into Codex chat.',
        input: {
          editorAppName: 'Notepad',
          editorTargetWindowTitle: 'Notepad',
          chatAppName: 'Codex',
          chatTargetWindowTitle: 'Codex',
        },
      },
    ],
    fallbacks: [
      'skill.browser.editor_chat_stage_and_deliver',
      'skill.browser.editor_stage_and_deliver',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const stageDeliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser.editor_chat_stage_and_deliver',
        {
          editorAppName: input.editorAppName,
          editorTargetWindowTitle: input.editorTargetWindowTitle,
          chatAppName: input.chatAppName,
          chatTargetWindowTitle: input.chatTargetWindowTitle,
        },
      )

      const stageOutput = stageDeliverResult.data as
        | {
            extractedText?: unknown
            editorTargetWindowTitle?: unknown
            chatTargetWindowTitle?: unknown
            currentArtifact?: unknown
            currentStage?: unknown
          }
        | undefined
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.browser.editor_chat_stage_and_deliver',
          ok: stageDeliverResult.ok,
          summary: stageDeliverResult.summary,
        },
      ]

      if (!stageDeliverResult.ok || readCapabilityVerificationPassed(stageDeliverResult.data) === false) {
        return {
          ok: false,
          summary: stageDeliverResult.summary,
          route: 'tool',
          error: stageDeliverResult.error,
          failureClass: stageDeliverResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget:
              typeof stageOutput?.chatTargetWindowTitle === 'string'
                ? stageOutput.chatTargetWindowTitle
                : input.chatTargetWindowTitle ?? input.chatAppName,
            currentArtifact:
              typeof stageOutput?.currentArtifact === 'string'
                ? stageOutput.currentArtifact
                : 'browser-editor-chat-delivery',
            chainStatus: 'execution_failed',
          },
          recoveryPoint: `focus:${input.chatTargetWindowTitle ?? input.chatAppName}`,
          verificationEvidence: readCapabilityVerificationEvidence(stageDeliverResult.data),
          recoveryUsed: readCapabilityRecoveryUsed(stageDeliverResult.data),
          verification: {
            strategy: 'browser-stage-chat-deliver-verify',
            passed: false,
            details: 'Base browser editor chat stage and deliver chain failed before verification.',
          },
        }
      }

      const extractedText = readCapabilityOutputString(stageDeliverResult.data, 'extractedText')
      const editorTargetWindowTitle =
        typeof stageOutput?.editorTargetWindowTitle === 'string'
          ? stageOutput.editorTargetWindowTitle
          : input.editorTargetWindowTitle ?? input.editorAppName
      const chatTargetWindowTitle =
        typeof stageOutput?.chatTargetWindowTitle === 'string'
          ? stageOutput.chatTargetWindowTitle
          : input.chatTargetWindowTitle ?? input.chatAppName

      return {
        ok: true,
        summary: stageDeliverResult.summary,
        route: 'tool',
        data: {
          extractedText: extractedText ?? '',
          editorTargetWindowTitle,
          chatTargetWindowTitle,
          selectedWindowTitle: chatTargetWindowTitle,
          staged: true,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact: 'browser-editor-chat-delivery',
        },
        output: {
          extractedText: extractedText ?? '',
          editorTargetWindowTitle,
          chatTargetWindowTitle,
          selectedWindowTitle: chatTargetWindowTitle,
          staged: true,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact: 'browser-editor-chat-delivery',
        },
        operations,
        chainState: {
          currentTarget: chatTargetWindowTitle,
          currentArtifact: 'browser-editor-chat-delivery',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(stageDeliverResult.data) ?? chatTargetWindowTitle,
          chainStatus: 'completed',
        },
        verificationEvidence: [
          ...readCapabilityVerificationEvidence(stageDeliverResult.data),
          `verified:${chatTargetWindowTitle}`,
        ],
        recoveryUsed: readCapabilityRecoveryUsed(stageDeliverResult.data),
        verification: {
          strategy: 'browser-stage-chat-deliver-verify',
          passed: true,
          details: 'Browser content was staged through the verified editor chain and confirmed in the chat target.',
        },
      }
    },
  }

  const fileBrowserChatRouteDeliver: CapabilityDefinition<
    {
      path: string
      chatAppName: string
      chatTargetWindowTitle?: string
      routeQuery?: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
    },
    {
      sourcePath: string
      transformedText: string
      browserContextText?: string
      selectedWindowTitle: string
      routeReason: string
      delivered: boolean
    }
  > = {
    id: 'file.browser_chat_route_deliver',
    kind: 'skill',
    title: 'File Browser Chat Route Deliver',
    description:
      'Read local file text, derive routing context from the browser, then deliver the payload into a chat or IM target.',
    searchHints: ['file browser chat route deliver chat target'],
    tags: ['file', 'browser', 'chat', 'route', 'delivery', 'cross-app'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file browser chat route deliver input',
      properties: {
        path: { type: 'string' },
        chatAppName: { type: 'string' },
        chatTargetWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
      },
      required: ['path', 'chatAppName'],
    },
    examples: [
      {
        task: 'Read a local follow-up note, use browser context to decide the chat target, then deliver the note into Codex.',
        input: {
          path: 'followup.txt',
          chatAppName: 'Codex',
          chatTargetWindowTitle: 'Codex',
          transform: 'trim',
        },
      },
    ],
    fallbacks: [
      'command.workspace.read_text',
      'command.browser.inspect_dom',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const readResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.workspace.read_text',
        {
          path: input.path,
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'command.workspace.read_text',
        ok: readResult.ok,
        summary: readResult.summary,
      })

      const readOutput = readWorkspaceReadOutput(readResult.data)
      const transformedText = transformTransferText(
        readOutput.lines.join('\n'),
        input.transform,
      )
      const evidence = [
        `source=${readOutput.path}`,
        `lines=${readOutput.startLine}-${readOutput.endLine}`,
        `transform=${input.transform ?? 'none'}`,
      ]

      if (!readResult.ok || !transformedText.trim()) {
        return {
          ok: false,
          summary: readResult.ok
            ? `Read ${input.path}, but the transformed payload is empty before browser-assisted chat delivery.`
            : `Failed to read ${input.path} before browser-assisted chat delivery.`,
          route: 'cli',
          error: readResult.error,
          failureClass: readResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: readOutput.path,
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.workspace.read_text',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'file-read-before-browser-chat-route',
            passed: false,
            details: readResult.ok
              ? 'Backend file read succeeded, but the transformed payload was empty before chat routing.'
              : 'Backend file read failed before browser-assisted chat routing could begin.',
          },
        }
      }

      evidence.push(`payload=${truncateEvidenceText(transformedText)}`)

      const browserInspectResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.browser.inspect_dom',
      )
      operations.push({
        type: 'tool',
        target: 'command.browser.inspect_dom',
        ok: browserInspectResult.ok,
        summary: browserInspectResult.summary,
      })

      const browserObservation = readNestedObservationSnapshot(browserInspectResult.data)
      const browserContextText = extractBrowserTransferText(browserObservation)
      evidence.push(...buildObservationEvidence(browserObservation))
      if (browserContextText) {
        evidence.push(`browserContext=${truncateEvidenceText(browserContextText)}`)
      }

      if (!browserInspectResult.ok) {
        return {
          ok: false,
          summary: 'File payload is ready, but browser context inspection failed before chat routing.',
          route: 'cli',
          error: browserInspectResult.error,
          failureClass: browserInspectResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'browser-dom',
            chainStatus: 'execution_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'file-browser-chat-route-deliver',
            passed: false,
            details: 'Browser context inspection failed before chat delivery could begin.',
          },
        }
      }

      const routeBasis = input.routeQuery?.trim() || browserContextText
      if (!routeBasis) {
        return {
          ok: false,
          summary: 'File payload is ready, but no browser-derived routing signal is available for chat delivery.',
          route: 'cli',
          failureClass: 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'browser-dom',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'file-browser-chat-route-deliver',
            passed: false,
            details: 'Browser inspection completed, but neither an explicit routeQuery nor a reusable browser routing signal was available.',
          },
        }
      }

      const chatTargetWindowTitle = input.chatTargetWindowTitle ?? input.chatAppName
      const deliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: input.chatAppName,
          targetWindowTitle: chatTargetWindowTitle,
          text: transformedText,
          ...(shouldSubmitWithEnter(chatTargetWindowTitle) ? { pressEnter: true } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: deliverResult.ok,
        summary: deliverResult.summary,
      })

      const verificationPassed =
        deliverResult.ok && readCapabilityVerificationPassed(deliverResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(deliverResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Read ${readOutput.path}, used browser context to route the payload, and delivered it into ${chatTargetWindowTitle}.`
          : `Read ${readOutput.path} and selected ${chatTargetWindowTitle}, but final chat delivery failed.`,
        route: 'cli',
        data: {
          sourcePath: readOutput.path,
          transformedText,
          browserContextText,
          selectedWindowTitle: chatTargetWindowTitle,
          routeReason: routeBasis === browserContextText
            ? `browserContext matched ${chatTargetWindowTitle}`
            : `routeQuery=${routeBasis}`,
          currentStage: verificationPassed ? 'verified' : 'delivered',
          currentArtifact: readOutput.path,
          delivered: verificationPassed,
        },
        error: verificationPassed ? undefined : deliverResult.error,
        failureClass: verificationPassed
          ? undefined
          : deliverResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: chatTargetWindowTitle,
          currentArtifact: readOutput.path,
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(deliverResult.data) ??
            browserObservation?.anchors?.[0] ??
            chatTargetWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : `focus:${chatTargetWindowTitle}`,
        verificationEvidence: [
          ...evidence,
          `routeQuery=${routeBasis}`,
          `routeReason=${
            routeBasis === browserContextText
              ? `browserContext matched ${chatTargetWindowTitle}`
              : `routeQuery=${routeBasis}`
          }`,
          ...(shouldSubmitWithEnter(chatTargetWindowTitle)
            ? ['submitAction=enter']
            : []),
          ...readCapabilityVerificationEvidence(deliverResult.data),
        ],
        recoveryUsed: readCapabilityRecoveryUsed(deliverResult.data),
        verification: {
          strategy: 'file-read-browser-chat-route-open-observe-act-verify',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Local file content was transformed, browser context selected the chat target, and the downstream verified delivery chain succeeded.'
            : 'File and browser routing completed, but the final open/observe/act/verify chat delivery chain failed.',
        },
      }
    },
  }

  const fileBrowserChatRouteDeliverVerify: CapabilityDefinition<
    {
      path: string
      chatAppName: string
      chatTargetWindowTitle?: string
      routeQuery?: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
    },
    {
      sourcePath: string
      transformedText: string
      browserContextText?: string
      selectedWindowTitle: string
      routeReason: string
      delivered: boolean
      verified: boolean
      currentStage: 'verified'
      currentArtifact: string
    }
  > = {
    id: 'file.browser_chat_route_deliver_verify',
    kind: 'skill',
    title: 'File Browser Chat Route Deliver Verify',
    description:
      'Read local file text, derive routing context from the browser, deliver into a chat target, then verify the final result.',
    searchHints: ['file browser chat route deliver verify chat target'],
    tags: ['file', 'browser', 'chat', 'route', 'delivery', 'verify', 'cross-app'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file browser chat route deliver verify input',
      properties: {
        path: { type: 'string' },
        chatAppName: { type: 'string' },
        chatTargetWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
      },
      required: ['path', 'chatAppName'],
    },
    examples: [
      {
        task: 'Read a local follow-up note, use browser context to decide the chat target, then verify the note was delivered into Codex.',
        input: {
          path: 'followup.txt',
          chatAppName: 'Codex',
          chatTargetWindowTitle: 'Codex',
          transform: 'trim',
        },
      },
    ],
    fallbacks: [
      'skill.file.browser_chat_route_deliver',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const deliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.file.browser_chat_route_deliver',
        {
          path: input.path,
          chatAppName: input.chatAppName,
          chatTargetWindowTitle: input.chatTargetWindowTitle,
          ...(typeof input.routeQuery === 'string' ? { routeQuery: input.routeQuery } : {}),
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          ...(typeof input.transform === 'string' ? { transform: input.transform } : {}),
        },
      )

      const deliverOutput = deliverResult.data as
        | {
            sourcePath?: unknown
            transformedText?: unknown
            browserContextText?: unknown
            selectedWindowTitle?: unknown
            routeReason?: unknown
            output?: {
              sourcePath?: unknown
              transformedText?: unknown
              browserContextText?: unknown
              selectedWindowTitle?: unknown
              routeReason?: unknown
            }
          }
        | undefined
      const nestedDeliverOutput =
        typeof deliverOutput?.output === 'object' && deliverOutput.output !== null
          ? deliverOutput.output
          : undefined
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.file.browser_chat_route_deliver',
          ok: deliverResult.ok,
          summary: deliverResult.summary,
        },
      ]

      if (!deliverResult.ok || readCapabilityVerificationPassed(deliverResult.data) === false) {
        return {
          ok: false,
          summary: deliverResult.summary,
          route: 'cli',
          error: deliverResult.error,
          failureClass: deliverResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget:
              readTemplateChainCurrentTarget(deliverResult.data) ??
              (typeof deliverOutput?.selectedWindowTitle === 'string'
                ? deliverOutput.selectedWindowTitle
                : typeof nestedDeliverOutput?.selectedWindowTitle === 'string'
                  ? nestedDeliverOutput.selectedWindowTitle
                  : input.chatTargetWindowTitle ?? input.chatAppName),
            currentArtifact:
              typeof deliverOutput?.sourcePath === 'string'
                ? deliverOutput.sourcePath
                : typeof nestedDeliverOutput?.sourcePath === 'string'
                  ? nestedDeliverOutput.sourcePath
                  : input.path,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(deliverResult.data),
            chainStatus: readCapabilityChainStatus(deliverResult.data) ?? 'execution_failed',
          },
          recoveryPoint:
            readCapabilityRecoveryPoint(deliverResult.data) ??
            deliverResult.pointer ??
            'skill.file.browser_chat_route_deliver',
          verificationEvidence: readCapabilityVerificationEvidence(deliverResult.data),
          recoveryUsed: readCapabilityRecoveryUsed(deliverResult.data),
          verification: {
            strategy: 'file-browser-chat-route-deliver-verify',
            passed: false,
            details: 'Base file/browser chat route delivery failed before verification.',
          },
        }
      }

      const sourcePath =
        typeof deliverOutput?.sourcePath === 'string'
          ? deliverOutput.sourcePath
          : typeof nestedDeliverOutput?.sourcePath === 'string'
            ? nestedDeliverOutput.sourcePath
            : input.path
      const transformedText =
        typeof deliverOutput?.transformedText === 'string'
          ? deliverOutput.transformedText
          : typeof nestedDeliverOutput?.transformedText === 'string'
            ? nestedDeliverOutput.transformedText
            : ''
      const browserContextText =
        typeof deliverOutput?.browserContextText === 'string'
          ? deliverOutput.browserContextText
          : typeof nestedDeliverOutput?.browserContextText === 'string'
            ? nestedDeliverOutput.browserContextText
            : undefined
      const selectedWindowTitle =
        typeof deliverOutput?.selectedWindowTitle === 'string'
          ? deliverOutput.selectedWindowTitle
          : typeof nestedDeliverOutput?.selectedWindowTitle === 'string'
            ? nestedDeliverOutput.selectedWindowTitle
            : input.chatTargetWindowTitle ?? input.chatAppName
      const routeReason =
        typeof deliverOutput?.routeReason === 'string'
          ? deliverOutput.routeReason
          : typeof nestedDeliverOutput?.routeReason === 'string'
            ? nestedDeliverOutput.routeReason
            : ''
      const currentArtifact = basename(sourcePath)

      return {
        ok: true,
        summary: deliverResult.summary,
        route: 'cli',
        data: {
          sourcePath,
          transformedText,
          browserContextText,
          selectedWindowTitle,
          routeReason,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact,
        },
        output: {
          sourcePath,
          transformedText,
          browserContextText,
          selectedWindowTitle,
          routeReason,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact,
        },
        operations,
        chainState: {
          currentTarget: selectedWindowTitle,
          currentArtifact,
          lastVerifiedAnchor: selectedWindowTitle,
          chainStatus: 'completed',
        },
        verificationEvidence: [
          ...readCapabilityVerificationEvidence(deliverResult.data),
          `verified:${selectedWindowTitle}`,
        ],
        recoveryUsed: readCapabilityRecoveryUsed(deliverResult.data),
        verification: {
          strategy: 'file-browser-chat-route-deliver-verify',
          passed: true,
          details: 'File payload was routed through browser context and verified in the chat target.',
        },
      }
    },
  }

  const fileBrowserRouteDeliver: CapabilityDefinition<
    {
      path: string
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery?: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
    },
    {
      sourcePath: string
      transformedText: string
      browserContextText?: string
      selectedWindowTitle: string
      routeReason: string
      delivered: boolean
    }
  > = {
    id: 'file.browser_route_deliver',
    kind: 'skill',
    title: 'File Browser Route Deliver',
    description:
      'Read local file text, derive routing context from the active browser, compare candidate windows, then deliver the file payload into the selected desktop target.',
    searchHints: ['file browser route deliver candidate windows'],
    tags: ['file', 'browser', 'route', 'delivery', 'cross-app'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file browser route deliver input',
      properties: {
        path: { type: 'string' },
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
      },
      required: ['path', 'primaryWindowTitle', 'secondaryWindowTitle'],
    },
    examples: [
      {
        task: 'Read a local follow-up note, use the active browser to infer the right recipient, then deliver the note into the matching chat window.',
        input: {
          path: 'followup.txt',
          primaryWindowTitle: 'Codex',
          secondaryWindowTitle: 'WeChat',
          transform: 'trim',
        },
      },
    ],
    fallbacks: [
      'command.workspace.read_text',
      'command.browser.inspect_dom',
      'skill.app.switch_collect_compare',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const readResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.workspace.read_text',
        {
          path: input.path,
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'command.workspace.read_text',
        ok: readResult.ok,
        summary: readResult.summary,
      })

      const readOutput = readWorkspaceReadOutput(readResult.data)
      const transformedText = transformTransferText(
        readOutput.lines.join('\n'),
        input.transform,
      )
      const evidence = [
        `source=${readOutput.path}`,
        `lines=${readOutput.startLine}-${readOutput.endLine}`,
        `transform=${input.transform ?? 'none'}`,
      ]

      if (!readResult.ok || !transformedText.trim()) {
        return {
          ok: false,
          summary: readResult.ok
            ? `Read ${input.path}, but the transformed payload is empty before browser routing.`
            : `Failed to read ${input.path} before browser-assisted delivery.`,
          route: 'cli',
          error: readResult.error,
          failureClass: readResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: readOutput.path,
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.workspace.read_text',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'file-read-before-browser-route',
            passed: false,
            details: readResult.ok
              ? 'Backend file read succeeded, but the transformed payload was empty before routing.'
              : 'Backend file read failed before browser routing could begin.',
          },
        }
      }

      evidence.push(`payload=${truncateEvidenceText(transformedText)}`)

      const browserInspectResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.browser.inspect_dom',
      )
      operations.push({
        type: 'tool',
        target: 'command.browser.inspect_dom',
        ok: browserInspectResult.ok,
        summary: browserInspectResult.summary,
      })

      const browserObservation = readNestedObservationSnapshot(browserInspectResult.data)
      const browserContextText = extractBrowserTransferText(browserObservation)
      evidence.push(...buildObservationEvidence(browserObservation))
      if (browserContextText) {
        evidence.push(`browserContext=${truncateEvidenceText(browserContextText)}`)
      }

      if (!browserInspectResult.ok) {
        return {
          ok: false,
          summary: 'File payload is ready, but browser context inspection failed before routing.',
          route: 'cli',
          error: browserInspectResult.error,
          failureClass: browserInspectResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'browser-dom',
            chainStatus: 'execution_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'file-browser-route-deliver',
            passed: false,
            details: 'Browser context inspection failed before candidate comparison and delivery.',
          },
        }
      }

      const routeBasis = input.routeQuery?.trim() || browserContextText
      if (!routeBasis) {
        return {
          ok: false,
          summary: 'File payload is ready, but no browser-derived routing signal is available.',
          route: 'cli',
          failureClass: 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'browser-dom',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'verified_failed',
          },
          recoveryPoint: 'command.browser.inspect_dom',
          verificationEvidence: evidence,
          recoveryUsed: false,
          verification: {
            strategy: 'file-browser-route-deliver',
            passed: false,
            details: 'Browser inspection completed, but neither an explicit routeQuery nor a reusable browser routing signal was available.',
          },
        }
      }

      const compareResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.app.switch_collect_compare',
        {
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.app.switch_collect_compare',
        ok: compareResult.ok,
        summary: compareResult.summary,
      })

      if (!compareResult.ok) {
        return {
          ok: false,
          summary: 'File and browser context are ready, but candidate comparison failed before delivery.',
          route: 'cli',
          error: compareResult.error,
          failureClass: compareResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'window-comparison',
            lastVerifiedAnchor: browserObservation?.anchors?.[0],
            chainStatus: 'execution_failed',
          },
          recoveryPoint: `focus:${input.primaryWindowTitle}`,
          verificationEvidence: [
            ...evidence,
            ...readCapabilityVerificationEvidence(compareResult.data),
          ],
          recoveryUsed: readCapabilityRecoveryUsed(compareResult.data),
          verification: {
            strategy: 'file-browser-route-deliver',
            passed: false,
            details: 'Candidate comparison failed after file read and browser inspection succeeded.',
          },
        }
      }

      const compareOutput =
        typeof compareResult.data === 'object' &&
        compareResult.data !== null &&
        typeof (compareResult.data as { output?: unknown }).output === 'object' &&
        (compareResult.data as { output?: unknown }).output !== null
          ? ((compareResult.data as { output?: unknown }).output as {
              primaryEvidence?: string[]
              secondaryEvidence?: string[]
            })
          : undefined
      const primaryEvidence = Array.isArray(compareOutput?.primaryEvidence)
        ? compareOutput.primaryEvidence
        : []
      const secondaryEvidence = Array.isArray(compareOutput?.secondaryEvidence)
        ? compareOutput.secondaryEvidence
        : []
      const selectedRoute = selectWindowRoute({
        primaryWindowTitle: input.primaryWindowTitle,
        primaryEvidence,
        secondaryWindowTitle: input.secondaryWindowTitle,
        secondaryEvidence,
        routeQuery: routeBasis,
      })

      const deliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: selectedRoute.selectedWindowTitle,
          targetWindowTitle: selectedRoute.selectedWindowTitle,
          text: transformedText,
          ...(shouldSubmitWithEnter(selectedRoute.selectedWindowTitle)
            ? { pressEnter: true }
            : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: deliverResult.ok,
        summary: deliverResult.summary,
      })

      const verificationPassed =
        deliverResult.ok && readCapabilityVerificationPassed(deliverResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(deliverResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Read ${readOutput.path}, used browser context to route the payload, and delivered it into ${selectedRoute.selectedWindowTitle}.`
          : `Read ${readOutput.path} and selected ${selectedRoute.selectedWindowTitle}, but final delivery failed.`,
        route: 'cli',
        data: {
          sourcePath: readOutput.path,
          transformedText,
          browserContextText,
          selectedWindowTitle: selectedRoute.selectedWindowTitle,
          routeReason: selectedRoute.reason,
          currentStage: verificationPassed ? 'verified' : 'delivered',
          currentArtifact: readOutput.path,
          delivered: verificationPassed,
        },
        error: verificationPassed ? undefined : deliverResult.error,
        failureClass: verificationPassed
          ? undefined
          : deliverResult.failureClass ?? 'deterministic',
        operations,
        chainState: {
          currentTarget: selectedRoute.selectedWindowTitle,
          currentArtifact: readOutput.path,
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(deliverResult.data) ??
            browserObservation?.anchors?.[0] ??
            selectedRoute.selectedWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : `focus:${selectedRoute.selectedWindowTitle}`,
        verificationEvidence: [
          ...evidence,
          `routeQuery=${routeBasis}`,
          `routeReason=${selectedRoute.reason}`,
          ...(shouldSubmitWithEnter(selectedRoute.selectedWindowTitle)
            ? ['submitAction=enter']
            : []),
          ...primaryEvidence,
          ...secondaryEvidence,
          ...readCapabilityVerificationEvidence(deliverResult.data),
        ],
        recoveryUsed:
          readCapabilityRecoveryUsed(compareResult.data) ||
          readCapabilityRecoveryUsed(deliverResult.data),
        verification: {
          strategy: 'file-read-browser-route-open-observe-act-verify',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Local file content was transformed, browser context selected the best target, and the downstream verified delivery chain succeeded.'
            : 'File and browser routing completed, but the final open/observe/act/verify delivery chain failed.',
        },
      }
    },
  }

  const fileBrowserRouteDeliverVerify: CapabilityDefinition<
    {
      path: string
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery?: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
    },
    {
      sourcePath: string
      transformedText: string
      browserContextText?: string
      selectedWindowTitle: string
      routeReason: string
      delivered: boolean
      verified: boolean
      currentStage: 'delivered' | 'verified'
      currentArtifact: string
    }
  > = {
    id: 'file.browser_route_deliver_verify',
    kind: 'skill',
    title: 'File Browser Route Deliver Verify',
    description:
      'Read local file text, use browser-derived context to choose the target, then deliver and verify the final desktop result.',
    searchHints: ['file browser route deliver verify target'],
    tags: ['file', 'browser', 'route', 'delivery', 'verify', 'cross-app'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file browser route deliver verify input',
      properties: {
        path: { type: 'string' },
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
      },
      required: ['path', 'primaryWindowTitle', 'secondaryWindowTitle'],
    },
    examples: [
      {
        task: 'Read a local follow-up note, use browser context to select the recipient, then deliver and verify the note.',
        input: {
          path: 'followup.txt',
          primaryWindowTitle: 'Codex',
          secondaryWindowTitle: 'WeChat',
          transform: 'trim',
        },
      },
    ],
    fallbacks: [
      'skill.file.browser_route_deliver',
      'skill.app.switch_collect_compare',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const routeResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.file.browser_route_deliver',
        {
          path: input.path,
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
          ...(typeof input.routeQuery === 'string' ? { routeQuery: input.routeQuery } : {}),
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          ...(typeof input.transform === 'string' ? { transform: input.transform } : {}),
        },
      )

      const routeOutput = routeResult.data as
        | {
            sourcePath?: unknown
            transformedText?: unknown
            browserContextText?: unknown
            selectedWindowTitle?: unknown
            routeReason?: unknown
            output?: {
              sourcePath?: unknown
              transformedText?: unknown
              browserContextText?: unknown
              selectedWindowTitle?: unknown
              routeReason?: unknown
              currentStage?: unknown
              currentArtifact?: unknown
              delivered?: unknown
              verified?: unknown
            }
          }
        | undefined
      const nestedRouteOutput =
        typeof routeOutput?.output === 'object' && routeOutput.output !== null
          ? routeOutput.output
          : undefined
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.file.browser_route_deliver',
          ok: routeResult.ok,
          summary: routeResult.summary,
        },
      ]

      if (!routeResult.ok || readCapabilityVerificationPassed(routeResult.data) === false) {
        return {
          ok: false,
          summary: routeResult.summary,
          route: 'tool',
          error: routeResult.error,
          failureClass: routeResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget:
              readTemplateChainCurrentTarget(routeResult.data) ??
              (typeof routeOutput?.selectedWindowTitle === 'string'
                ? routeOutput.selectedWindowTitle
                : typeof nestedRouteOutput?.selectedWindowTitle === 'string'
                  ? nestedRouteOutput.selectedWindowTitle
                  : input.primaryWindowTitle),
            currentArtifact:
              typeof routeOutput?.sourcePath === 'string'
                ? routeOutput.sourcePath
                : input.path,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(routeResult.data),
            chainStatus: readCapabilityChainStatus(routeResult.data) ?? 'execution_failed',
          },
          recoveryPoint:
            readCapabilityRecoveryPoint(routeResult.data) ??
            routeResult.pointer ??
            'skill.file.browser_route_deliver',
          verificationEvidence: readCapabilityVerificationEvidence(routeResult.data),
          recoveryUsed: readCapabilityRecoveryUsed(routeResult.data),
          verification: {
            strategy: 'file-browser-route-deliver-verify',
            passed: false,
            details: 'Base file/browser route delivery failed before verification.',
          },
        }
      }

      const selectedWindowTitle =
        typeof routeOutput?.selectedWindowTitle === 'string'
          ? routeOutput.selectedWindowTitle
          : typeof nestedRouteOutput?.selectedWindowTitle === 'string'
            ? nestedRouteOutput.selectedWindowTitle
          : input.primaryWindowTitle
      const sourcePath =
        typeof routeOutput?.sourcePath === 'string'
          ? routeOutput.sourcePath
          : typeof nestedRouteOutput?.sourcePath === 'string'
            ? nestedRouteOutput.sourcePath
            : input.path
      const transformedText =
        typeof routeOutput?.transformedText === 'string'
          ? routeOutput.transformedText
          : typeof nestedRouteOutput?.transformedText === 'string'
            ? nestedRouteOutput.transformedText
            : ''
      const browserContextText =
        typeof routeOutput?.browserContextText === 'string'
          ? routeOutput.browserContextText
          : typeof nestedRouteOutput?.browserContextText === 'string'
            ? nestedRouteOutput.browserContextText
            : undefined
      const routeReason =
        typeof routeOutput?.routeReason === 'string'
          ? routeOutput.routeReason
          : typeof nestedRouteOutput?.routeReason === 'string'
            ? nestedRouteOutput.routeReason
            : ''
      return {
        ok: true,
        summary: routeResult.summary,
        route: 'tool',
        data: {
          sourcePath,
          transformedText,
          browserContextText,
          selectedWindowTitle,
          routeReason,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact: sourcePath,
        },
        output: {
          sourcePath,
          transformedText,
          browserContextText,
          selectedWindowTitle,
          routeReason,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact: sourcePath,
        },
        operations,
        chainState: {
          currentTarget: selectedWindowTitle,
          currentArtifact: sourcePath,
          lastVerifiedAnchor: selectedWindowTitle,
          chainStatus: 'completed',
        },
        verificationEvidence: [
          ...readCapabilityVerificationEvidence(routeResult.data),
          `verified:${selectedWindowTitle}`,
        ],
        recoveryUsed: readCapabilityRecoveryUsed(routeResult.data),
        verification: {
          strategy: 'file-browser-route-deliver-verify',
          passed: true,
          details: 'File payload was routed through browser context and delivered successfully.',
        },
      }
    },
  }

  const appSwitchCollectCompare: CapabilityDefinition<
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
    },
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
      primaryEvidence: string[]
      secondaryEvidence: string[]
      comparisonSummary: string
      identical: boolean
    }
  > = {
    id: 'app.switch_collect_compare',
    kind: 'skill',
    title: 'App Switch Collect Compare',
    description:
      'Switch across two target windows, collect observation evidence from each, and summarize their differences.',
    searchHints: ['window switch collect compare summarize'],
    tags: ['desktop', 'window', 'switch', 'observe', 'compare'],
    preferredRoute: 'tool',
    riskLevel: 'medium',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'app switch collect compare input',
      properties: {
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
      },
      required: ['primaryWindowTitle', 'secondaryWindowTitle'],
    },
    examples: [
      {
        task: 'Switch between two windows and compare their visible evidence.',
        input: {
          primaryWindowTitle: 'Browser',
          secondaryWindowTitle: 'Notepad',
        },
      },
    ],
    fallbacks: [
      'windows.app',
      'windows.focus_window',
      'skill.desktop.observe',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []

      const listResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.app',
        { mode: 'list' },
      )
      operations.push({
        type: 'tool',
        target: 'windows.app',
        ok: listResult.ok,
        summary: listResult.summary,
      })

      const primaryCollection = await collectWindowObservation(
        context,
        input.primaryWindowTitle,
      )
      operations.push(...primaryCollection.operations)
      if (!primaryCollection.ok) {
        return {
          ok: false,
          summary: `Failed to collect evidence from ${input.primaryWindowTitle}.`,
          route: 'tool',
          error: primaryCollection.error,
          failureClass: primaryCollection.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: input.primaryWindowTitle,
            lastVerifiedAnchor: primaryCollection.lastVerifiedAnchor,
            chainStatus: primaryCollection.chainStatus,
          },
          recoveryPoint: `focus:${input.primaryWindowTitle}`,
          verificationEvidence: primaryCollection.evidence,
          recoveryUsed: primaryCollection.recoveryUsed,
          verification: {
            strategy: 'list-focus-observe-compare',
            passed: false,
            details: 'Primary window focus/observation failed.',
          },
        }
      }

      const secondaryCollection = await collectWindowObservation(
        context,
        input.secondaryWindowTitle,
      )
      operations.push(...secondaryCollection.operations)
      if (!secondaryCollection.ok) {
        return {
          ok: false,
          summary: `Collected evidence from ${input.primaryWindowTitle}, but failed on ${input.secondaryWindowTitle}.`,
          route: 'tool',
          error: secondaryCollection.error,
          failureClass: secondaryCollection.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: input.secondaryWindowTitle,
            lastVerifiedAnchor:
              primaryCollection.lastVerifiedAnchor ??
              secondaryCollection.lastVerifiedAnchor,
            chainStatus: secondaryCollection.chainStatus,
          },
          recoveryPoint: `focus:${input.secondaryWindowTitle}`,
          verificationEvidence: [
            ...primaryCollection.evidence,
            ...secondaryCollection.evidence,
          ],
          recoveryUsed: secondaryCollection.recoveryUsed,
          verification: {
            strategy: 'list-focus-observe-compare',
            passed: false,
            details: 'Secondary window focus/observation failed after primary collection succeeded.',
          },
        }
      }

      const comparison = compareEvidenceSets(
        input.primaryWindowTitle,
        primaryCollection.evidence,
        input.secondaryWindowTitle,
        secondaryCollection.evidence,
      )

      return {
        ok: true,
        summary: `Collected evidence from ${input.primaryWindowTitle} and ${input.secondaryWindowTitle}. ${comparison.summary}`,
        route: 'tool',
        data: {
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
          primaryEvidence: primaryCollection.evidence,
          secondaryEvidence: secondaryCollection.evidence,
          comparisonSummary: comparison.summary,
          identical: comparison.identical,
        },
        output: {
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
          primaryEvidence: primaryCollection.evidence,
          secondaryEvidence: secondaryCollection.evidence,
          comparisonSummary: comparison.summary,
          identical: comparison.identical,
        },
        operations,
        chainState: {
          currentTarget: input.secondaryWindowTitle,
          currentArtifact: 'window-comparison',
          lastVerifiedAnchor:
            secondaryCollection.lastVerifiedAnchor ??
            primaryCollection.lastVerifiedAnchor,
          chainStatus: 'completed',
        },
        recoveryPoint: undefined,
        verificationEvidence: [
          ...(listResult.ok ? [] : [`windowListUnavailable=${listResult.summary}`]),
          ...primaryCollection.evidence,
          ...secondaryCollection.evidence,
          comparison.summary,
        ],
        recoveryUsed:
          primaryCollection.recoveryUsed || secondaryCollection.recoveryUsed,
        verification: {
          strategy: 'list-focus-observe-compare',
          passed: true,
          details:
            'Both target windows were focused and observed successfully before comparison.',
        },
      }
    },
  }

  const multiWindowObserveRouteExecute: CapabilityDefinition<
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery: string
      actionText?: string
    },
    {
      selectedWindowTitle: string
      routeReason: string
      actionText?: string
      executed: boolean
      verified: boolean
    }
  > = {
    id: 'multi_window.observe_route_execute',
    kind: 'skill',
    title: 'Multi Window Observe Route Execute',
    description:
      'Observe two candidate windows, route to the best-matching target, then execute through the verified app chain.',
    searchHints: ['multi window observe route execute choose target'],
    tags: ['desktop', 'window', 'route', 'observe', 'execute'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'multi window observe route execute input',
      properties: {
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        actionText: { type: 'string' },
      },
      required: ['primaryWindowTitle', 'secondaryWindowTitle', 'routeQuery'],
    },
    examples: [
      {
        task: 'Observe two windows, pick the one matching a query, then execute a verified action there.',
        input: {
          primaryWindowTitle: 'Browser',
          secondaryWindowTitle: 'Notepad',
          routeQuery: 'note',
          actionText: 'hello from compuser',
        },
      },
    ],
    fallbacks: [
      'skill.app.switch_collect_compare',
      'skill.cross_app.open_observe_act_verify',
      'windows.app',
      'windows.focus_window',
      'skill.desktop.observe',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []

      const listResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.app',
        { mode: 'list' },
      )
      operations.push({
        type: 'tool',
        target: 'windows.app',
        ok: listResult.ok,
        summary: listResult.summary,
      })

      if (!listResult.ok) {
        return {
          ok: false,
          summary: 'Failed to enumerate app windows before routing execution.',
          route: 'tool',
          error: listResult.error,
          failureClass: listResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentArtifact: 'window-list',
            chainStatus: 'execution_failed',
          },
          recoveryPoint: 'windows.app:list',
          verificationEvidence: [],
          recoveryUsed: false,
          verification: {
            strategy: 'observe-route-execute',
            passed: false,
            details: 'Window list step failed before observation and routing.',
          },
        }
      }

      const primaryCollection = await collectWindowObservation(
        context,
        input.primaryWindowTitle,
      )
      operations.push(...primaryCollection.operations)
      if (!primaryCollection.ok) {
        return {
          ok: false,
          summary: `Failed to observe primary target ${input.primaryWindowTitle}.`,
          route: 'tool',
          error: primaryCollection.error,
          failureClass: primaryCollection.failureClass ?? 'deterministic',
          failureReason: primaryCollection.failureReason,
          operations,
          chainState: {
            currentTarget: input.primaryWindowTitle,
            lastVerifiedAnchor: primaryCollection.lastVerifiedAnchor,
            chainStatus: primaryCollection.chainStatus,
          },
          recoveryPoint:
            primaryCollection.recoveryPoint ?? `focus:${input.primaryWindowTitle}`,
          recoveryAction:
            primaryCollection.recoveryAction ?? 'recover:refocus',
          observation: primaryCollection.observation,
          verificationEvidence: primaryCollection.evidence,
          recoveryUsed: primaryCollection.recoveryUsed,
          verification: {
            strategy: 'observe-route-execute',
            passed: false,
            details: 'Primary target observation failed before routing.',
          },
        }
      }

      const secondaryCollection = await collectWindowObservation(
        context,
        input.secondaryWindowTitle,
      )
      operations.push(...secondaryCollection.operations)
      if (!secondaryCollection.ok) {
        return {
          ok: false,
          summary: `Observed ${input.primaryWindowTitle}, but failed on ${input.secondaryWindowTitle}.`,
          route: 'tool',
          error: secondaryCollection.error,
          failureClass: secondaryCollection.failureClass ?? 'deterministic',
          failureReason: secondaryCollection.failureReason,
          operations,
          chainState: {
            currentTarget: input.secondaryWindowTitle,
            lastVerifiedAnchor:
              primaryCollection.lastVerifiedAnchor ??
              secondaryCollection.lastVerifiedAnchor,
            chainStatus: secondaryCollection.chainStatus,
          },
          recoveryPoint:
            secondaryCollection.recoveryPoint ?? `focus:${input.secondaryWindowTitle}`,
          recoveryAction:
            secondaryCollection.recoveryAction ?? 'recover:refocus',
          observation: secondaryCollection.observation,
          verificationEvidence: [
            ...primaryCollection.evidence,
            ...secondaryCollection.evidence,
          ],
          recoveryUsed: secondaryCollection.recoveryUsed,
          verification: {
            strategy: 'observe-route-execute',
            passed: false,
            details: 'Secondary target observation failed before routing.',
          },
        }
      }

      const selectedRoute = selectWindowRoute({
        primaryWindowTitle: input.primaryWindowTitle,
        primaryEvidence: primaryCollection.evidence,
        secondaryWindowTitle: input.secondaryWindowTitle,
        secondaryEvidence: secondaryCollection.evidence,
        routeQuery: input.routeQuery,
      })

      const executeResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: selectedRoute.selectedWindowTitle,
          targetWindowTitle: selectedRoute.selectedWindowTitle,
          ...(typeof input.actionText === 'string' ? { text: input.actionText } : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: executeResult.ok,
        summary: executeResult.summary,
      })

      const selectedCollection =
        selectedRoute.selectedWindowTitle === input.primaryWindowTitle
          ? primaryCollection
          : secondaryCollection
      let finalExecuteResult = executeResult
      let recoveryUsed =
        primaryCollection.recoveryUsed ||
        secondaryCollection.recoveryUsed ||
        readCapabilityRecoveryUsed(executeResult.data)
      let recoveryPoint = readCapabilityRecoveryPoint(executeResult.data)

      if (
        (!executeResult.ok ||
          readCapabilityVerificationPassed(executeResult.data) === false) &&
        shouldRetryWithFocusRecovery(recoveryPoint, selectedRoute.selectedWindowTitle)
      ) {
        const refocusResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'command.app.open_or_focus',
          {
            appName: selectedRoute.selectedWindowTitle,
          },
        )
        operations.push({
          type: 'tool',
          target: 'command.app.open_or_focus',
          ok: refocusResult.ok,
          summary: refocusResult.summary,
        })

        if (refocusResult.ok) {
          const retryExecuteResult = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'skill.cross_app.open_observe_act_verify',
            {
              appName: selectedRoute.selectedWindowTitle,
              targetWindowTitle: selectedRoute.selectedWindowTitle,
              ...(typeof input.actionText === 'string'
                ? { text: input.actionText }
                : {}),
            },
          )
          operations.push({
            type: 'tool',
            target: 'skill.cross_app.open_observe_act_verify',
            ok: retryExecuteResult.ok,
            summary: retryExecuteResult.summary,
          })
          finalExecuteResult = retryExecuteResult
          recoveryUsed = true
          recoveryPoint = readCapabilityRecoveryPoint(retryExecuteResult.data)
        }
      }

      const verificationPassed =
        finalExecuteResult.ok &&
        readCapabilityVerificationPassed(finalExecuteResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(finalExecuteResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Observed two windows, routed to ${selectedRoute.selectedWindowTitle}, and completed the verified execution chain.`
          : `Observed two windows and routed to ${selectedRoute.selectedWindowTitle}, but execution failed.`,
        route: 'tool',
        data: {
          selectedWindowTitle: selectedRoute.selectedWindowTitle,
          routeReason: selectedRoute.reason,
          actionText: input.actionText,
          executed: finalExecuteResult.ok,
          verified: verificationPassed,
        },
        error: verificationPassed ? undefined : finalExecuteResult.error,
        failureClass: verificationPassed
          ? undefined
          : finalExecuteResult.failureClass ?? 'deterministic',
        failureReason: verificationPassed
          ? undefined
          : finalExecuteResult.ok
            ? 'verification_failed'
            : 'execution_failed',
        operations,
        chainState: {
          currentTarget: selectedRoute.selectedWindowTitle,
          currentArtifact: 'multi-window-route',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(finalExecuteResult.data) ??
            selectedCollection.lastVerifiedAnchor,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : recoveryPoint ?? `focus:${selectedRoute.selectedWindowTitle}`,
        recoveryAction: verificationPassed
          ? undefined
          : shouldRetryWithFocusRecovery(
                recoveryPoint,
                selectedRoute.selectedWindowTitle,
              )
            ? 'recover:refocus'
            : 'recover:reroute',
        verificationEvidence: [
          `routeQuery=${input.routeQuery}`,
          `routeReason=${selectedRoute.reason}`,
          ...primaryCollection.evidence,
          ...secondaryCollection.evidence,
          ...readCapabilityVerificationEvidence(finalExecuteResult.data),
        ],
        recoveryUsed,
        verification: {
          strategy: 'observe-route-execute',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Observation-based routing selected a target window and the downstream verified execution chain succeeded.'
            : 'Observation-based routing selected a target window, but the downstream execution chain failed.',
        },
      }
    },
  }

  const multiWindowObserveRouteDeliverVerify: CapabilityDefinition<
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery: string
      targetAppName: string
      targetWindowTitle?: string
      actionText?: string
    },
    {
      selectedWindowTitle: string
      routeReason: string
      currentStage: 'delivered' | 'verified'
      currentArtifact: string
      executed: boolean
      verified: boolean
    }
  > = {
    id: 'multi_window.observe_route_deliver_verify',
    kind: 'skill',
    title: 'Multi Window Observe Route Deliver Verify',
    description:
      'Observe two windows, route to the better target, deliver the payload, and verify the result.',
    searchHints: ['multi window observe route deliver verify target'],
    tags: ['desktop', 'window', 'route', 'deliver', 'verify'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'multi window observe route deliver verify input',
      properties: {
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        targetAppName: { type: 'string' },
        targetWindowTitle: { type: 'string' },
        actionText: { type: 'string' },
      },
      required: [
        'primaryWindowTitle',
        'secondaryWindowTitle',
        'routeQuery',
        'targetAppName',
      ],
    },
    examples: [
      {
        task: 'Observe two windows, route a payload to the best target, deliver it, and verify the result.',
        input: {
          primaryWindowTitle: 'Browser',
          secondaryWindowTitle: 'Notepad',
          routeQuery: 'note',
          targetAppName: 'Notepad',
          targetWindowTitle: 'Notepad',
          actionText: 'hello from compuser',
        },
      },
    ],
    fallbacks: [
      'skill.app.switch_collect_compare',
      'skill.cross_app.open_observe_act_verify',
      'windows.app',
      'windows.focus_window',
      'skill.desktop.observe',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []

      const listResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.app',
        { mode: 'list' },
      )
      operations.push({
        type: 'tool',
        target: 'windows.app',
        ok: listResult.ok,
        summary: listResult.summary,
      })

      const primaryCollection = await collectWindowObservation(
        context,
        input.primaryWindowTitle,
      )
      operations.push(...primaryCollection.operations)
      if (!primaryCollection.ok) {
        return {
          ok: false,
          summary: `Failed to observe primary target ${input.primaryWindowTitle}.`,
          route: 'tool',
          error: primaryCollection.error,
          failureClass: primaryCollection.failureClass ?? 'deterministic',
          failureReason: primaryCollection.failureReason,
          operations,
          chainState: {
            currentTarget: input.primaryWindowTitle,
            lastVerifiedAnchor: primaryCollection.lastVerifiedAnchor,
            chainStatus: primaryCollection.chainStatus,
          },
          recoveryPoint:
            primaryCollection.recoveryPoint ?? `focus:${input.primaryWindowTitle}`,
          recoveryAction:
            primaryCollection.recoveryAction ?? 'recover:refocus',
          observation: primaryCollection.observation,
          verificationEvidence: primaryCollection.evidence,
          recoveryUsed: primaryCollection.recoveryUsed,
          verification: {
            strategy: 'observe-route-deliver-verify',
            passed: false,
            details: 'Primary target observation failed before routing.',
          },
        }
      }

      const secondaryCollection = await collectWindowObservation(
        context,
        input.secondaryWindowTitle,
      )
      operations.push(...secondaryCollection.operations)
      if (!secondaryCollection.ok) {
        return {
          ok: false,
          summary: `Observed ${input.primaryWindowTitle}, but failed on ${input.secondaryWindowTitle}.`,
          route: 'tool',
          error: secondaryCollection.error,
          failureClass: secondaryCollection.failureClass ?? 'deterministic',
          failureReason: secondaryCollection.failureReason,
          operations,
          chainState: {
            currentTarget: input.secondaryWindowTitle,
            lastVerifiedAnchor:
              primaryCollection.lastVerifiedAnchor ??
              secondaryCollection.lastVerifiedAnchor,
            chainStatus: secondaryCollection.chainStatus,
          },
          recoveryPoint:
            secondaryCollection.recoveryPoint ?? `focus:${input.secondaryWindowTitle}`,
          recoveryAction:
            secondaryCollection.recoveryAction ?? 'recover:refocus',
          observation: secondaryCollection.observation,
          verificationEvidence: [
            ...primaryCollection.evidence,
            ...secondaryCollection.evidence,
          ],
          recoveryUsed: secondaryCollection.recoveryUsed,
          verification: {
            strategy: 'observe-route-deliver-verify',
            passed: false,
            details: 'Secondary target observation failed before routing.',
          },
        }
      }

      const selectedRoute = selectWindowRoute({
        primaryWindowTitle: input.primaryWindowTitle,
        primaryEvidence: primaryCollection.evidence,
        secondaryWindowTitle: input.secondaryWindowTitle,
        secondaryEvidence: secondaryCollection.evidence,
        routeQuery: input.routeQuery,
      })

      const deliveredText =
        typeof input.actionText === 'string' && input.actionText.trim()
          ? input.actionText
          : input.routeQuery
      const deliveryTargetWindowTitle = selectedRoute.selectedWindowTitle

      const deliverResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.cross_app.open_observe_act_verify',
        {
          appName: deliveryTargetWindowTitle,
          targetWindowTitle: deliveryTargetWindowTitle,
          text: deliveredText,
          ...(shouldSubmitWithEnter(deliveryTargetWindowTitle)
            ? { pressEnter: true }
            : {}),
        },
      )
      operations.push({
        type: 'tool',
        target: 'skill.cross_app.open_observe_act_verify',
        ok: deliverResult.ok,
        summary: deliverResult.summary,
      })

      const verificationPassed =
        deliverResult.ok && readCapabilityVerificationPassed(deliverResult.data) !== false
      const chainStatus =
        readCapabilityChainStatus(deliverResult.data) ??
        (verificationPassed ? 'completed' : 'execution_failed')

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? `Observed two windows, routed to ${selectedRoute.selectedWindowTitle}, delivered payload into ${deliveryTargetWindowTitle}, and verified the result.`
          : `Observed two windows and routed to ${selectedRoute.selectedWindowTitle}, but delivery into ${deliveryTargetWindowTitle} failed.`,
        route: 'tool',
        data: {
          selectedWindowTitle: selectedRoute.selectedWindowTitle,
          routeReason: selectedRoute.reason,
          currentStage: verificationPassed ? 'verified' : 'delivered',
          currentArtifact: 'multi-window-observe-route-deliver-verify',
          executed: deliverResult.ok,
          verified: verificationPassed,
        },
        error: verificationPassed ? undefined : deliverResult.error,
        failureClass: verificationPassed
          ? undefined
          : deliverResult.failureClass ?? 'deterministic',
        failureReason: verificationPassed
          ? undefined
          : deliverResult.ok
            ? 'verification_failed'
            : 'execution_failed',
        operations,
        chainState: {
          currentTarget: deliveryTargetWindowTitle,
          currentArtifact: 'multi-window-observe-route-deliver-verify',
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(deliverResult.data) ??
            selectedRoute.selectedWindowTitle,
          chainStatus,
        },
        recoveryPoint: verificationPassed
          ? undefined
          : readCapabilityRecoveryPoint(deliverResult.data) ??
            `focus:${deliveryTargetWindowTitle}`,
        recoveryAction: verificationPassed
          ? undefined
          : deliverResult.ok
            ? 'recover:reobserve'
            : 'recover:restage',
        verificationEvidence: [
          `routeQuery=${input.routeQuery}`,
          `routeReason=${selectedRoute.reason}`,
          `selectedWindow=${selectedRoute.selectedWindowTitle}`,
          ...(shouldSubmitWithEnter(deliveryTargetWindowTitle)
            ? ['submitAction=enter']
            : []),
          ...primaryCollection.evidence,
          ...secondaryCollection.evidence,
          ...readCapabilityVerificationEvidence(deliverResult.data),
        ],
        recoveryUsed:
          primaryCollection.recoveryUsed ||
          secondaryCollection.recoveryUsed ||
          readCapabilityRecoveryUsed(deliverResult.data),
        verification: {
          strategy: 'observe-route-deliver-verify',
          passed: verificationPassed,
          details: verificationPassed
            ? 'Observation-based routing selected a target window and the downstream verified delivery chain succeeded.'
            : 'Observation-based routing selected a target window, but the downstream delivery chain failed.',
        },
      }
    },
  }

  const crossAppTransferText: CapabilityDefinition<
    {
      text: string
      targetWindowTitle: string
      pressEnter?: boolean
    },
    {
      transferred: boolean
      targetWindowTitle: string
    }
  > = {
    id: 'cross_app.transfer_text',
    kind: 'skill',
    title: 'Cross App Transfer Text',
    description:
      'Transfer text across apps using clipboard-first flow, then type as fallback.',
    searchHints: ['cross app transfer text paste clipboard type'],
    tags: ['desktop', 'cross-app', 'clipboard', 'type', 'paste'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'cross app transfer text input',
      properties: {
        text: { type: 'string' },
        targetWindowTitle: { type: 'string' },
        pressEnter: { type: 'boolean' },
      },
      required: ['text', 'targetWindowTitle'],
    },
    examples: [
      {
        task: 'Paste generated text into a target app.',
        input: {
          text: 'Hello from compuser',
          targetWindowTitle: 'Notepad',
        },
      },
    ],
    fallbacks: [
      'command.app.open_or_focus',
      'command.clipboard.read_write',
      'windows.shortcut',
      'windows.type',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const browserTarget = isBrowserWindowTitle(input.targetWindowTitle)
      const focusResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.app.open_or_focus',
        { appName: input.targetWindowTitle },
      )
      operations.push({
        type: 'tool',
        target: 'command.app.open_or_focus',
        ok: focusResult.ok,
        summary: focusResult.summary,
      })

      if (!focusResult.ok) {
        return {
          ok: false,
          summary: `Failed to focus target app ${input.targetWindowTitle}.`,
          route: 'tool',
          error: focusResult.error,
          failureClass: focusResult.failureClass,
          operations,
          recoveryUsed: false,
          verification: {
            strategy: 'focus-before-transfer',
            passed: false,
            details: 'Could not focus or launch the target app.',
          },
        }
      }

      const clipboardResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        browserTarget ? 'windows.clipboard' : 'command.clipboard.read_write',
        browserTarget
          ? {
              mode: 'set',
              text: input.text,
            }
          : {
              mode: 'set',
              text: input.text,
            },
      )
      operations.push({
        type: 'tool',
        target: browserTarget ? 'windows.clipboard' : 'command.clipboard.read_write',
        ok: clipboardResult.ok,
        summary: clipboardResult.summary,
      })

      const clipboardPasteReady =
        clipboardResult.ok ||
        (
          !browserTarget &&
          clipboardResult.error === 'CLIPBOARD_WRITE_VERIFICATION_FAILED'
        )

      if (clipboardPasteReady) {
        if (browserTarget) {
          const addressBarShortcut = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.shortcut',
            { shortcut: 'ctrl+l' },
          )
          operations.push({
            type: 'tool',
            target: 'windows.shortcut',
            ok: addressBarShortcut.ok,
            summary: addressBarShortcut.summary,
          })
        }

        const pasteShortcut = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.shortcut',
          { shortcut: 'ctrl+v' },
        )
        operations.push({
          type: 'tool',
          target: 'windows.shortcut',
          ok: pasteShortcut.ok,
          summary: pasteShortcut.summary,
        })

        if (pasteShortcut.ok && (input.pressEnter || browserTarget)) {
          const enterShortcut = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.shortcut',
            { shortcut: 'enter' },
          )
          operations.push({
            type: 'tool',
            target: 'windows.shortcut',
            ok: enterShortcut.ok,
            summary: enterShortcut.summary,
          })
        }

        if (pasteShortcut.ok) {
          await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.wait',
            { durationSeconds: 1 },
          )

          const verifyResult = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'skill.desktop.observe',
          )
          operations.push({
            type: 'tool',
            target: 'skill.desktop.observe',
            ok: verifyResult.ok,
            summary: verifyResult.summary,
          })

          const verifyObservation = readNestedObservationSnapshot(verifyResult.data)
          const verifyPassed =
            verifyResult.ok &&
            readCapabilityVerificationPassed(verifyResult.data) !== false &&
            matchesQueryAgainstObservation(
              verifyObservation,
              input.targetWindowTitle,
            )

          if (verifyPassed) {
            return {
              ok: true,
              summary: browserTarget
                ? `Transferred text into ${input.targetWindowTitle} using browser address bar.`
                : `Transferred text into ${input.targetWindowTitle} using clipboard paste.`,
              route: 'tool',
              data: {
                transferred: true,
                targetWindowTitle: input.targetWindowTitle,
              },
              operations,
              recoveryUsed: false,
              verification: {
                strategy: browserTarget
                  ? 'clipboard-then-browser-address-bar'
                  : 'clipboard-then-paste',
                passed: true,
                details: browserTarget
                  ? 'Text was copied, pasted into the browser address bar, and verified afterward.'
                  : 'Text was copied, pasted, and verified afterward.',
              },
            }
          }
        }

        if (pasteShortcut.ok) {
          return {
            ok: false,
            summary: `Pasted text into ${input.targetWindowTitle}, but the target was not confirmed afterward.`,
            route: 'tool',
            data: {
              transferred: false,
              targetWindowTitle: input.targetWindowTitle,
            },
            operations,
            recoveryUsed: false,
            verification: {
              strategy: 'clipboard-then-paste',
              passed: false,
              details: 'Text was copied and pasted, but the target app was not confirmed afterward.',
            },
          }
        }
      }

      const inputTargetResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.find_element_by_name',
        {
          name: '编辑',
          controlType: 'Edit',
          matchMode: 'contains',
        },
      )
      operations.push({
        type: 'tool',
        target: 'windows.find_element_by_name',
        ok: inputTargetResult.ok,
        summary: inputTargetResult.summary,
      })

      const inputElement = inputTargetResult.ok
        ? ((inputTargetResult.data as {
            element?: { label?: number; name?: string; x?: number; y?: number }
          }).element ?? undefined)
        : undefined

      if (typeof inputElement?.label === 'number') {
        const typedResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.type_label',
          {
            label: inputElement.label,
            text: input.text,
            clear: true,
            pressEnter: input.pressEnter === true,
          },
        )
        operations.push({
          type: 'tool',
          target: 'windows.type_label',
          ok: typedResult.ok,
          summary: typedResult.summary,
        })

        if (typedResult.ok) {
          await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.wait',
            { durationSeconds: 1 },
          )

          const verifyResult = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'skill.desktop.observe',
          )
          operations.push({
            type: 'tool',
            target: 'skill.desktop.observe',
            ok: verifyResult.ok,
            summary: verifyResult.summary,
          })

          const verifyObservation = readNestedObservationSnapshot(verifyResult.data)
          const verifyPassed =
            verifyResult.ok &&
            readCapabilityVerificationPassed(verifyResult.data) !== false &&
            matchesQueryAgainstObservation(
              verifyObservation,
              input.targetWindowTitle,
            )

          if (verifyPassed) {
            return {
              ok: true,
              summary: `Transferred text into ${input.targetWindowTitle} using named input focus.`,
              route: 'tool',
              data: {
                transferred: true,
                targetWindowTitle: input.targetWindowTitle,
              },
              operations,
              recoveryUsed: true,
              verification: {
                strategy: 'clipboard-then-type-fallback',
                passed: true,
                details: 'Named input control was found, typed, and verified afterward.',
              },
            }
          }
        }
      }

      const fallbackInputTargetResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.find_element_by_name',
        {
          name: input.targetWindowTitle,
          matchMode: 'contains',
        },
      )
      operations.push({
        type: 'tool',
        target: 'windows.find_element_by_name',
        ok: fallbackInputTargetResult.ok,
        summary: fallbackInputTargetResult.summary,
      })

      const fallbackInputElement = fallbackInputTargetResult.ok
        ? ((fallbackInputTargetResult.data as {
            element?: { label?: number; name?: string; x?: number; y?: number }
          }).element ?? undefined)
        : undefined

      if (typeof fallbackInputElement?.label === 'number') {
        const typedResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.type_label',
          {
            label: fallbackInputElement.label,
            text: input.text,
            clear: true,
            pressEnter: input.pressEnter === true,
          },
        )
        operations.push({
          type: 'tool',
          target: 'windows.type_label',
          ok: typedResult.ok,
          summary: typedResult.summary,
        })

        if (typedResult.ok) {
          await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.wait',
            { durationSeconds: 1 },
          )

          const verifyResult = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'skill.desktop.observe',
          )
          operations.push({
            type: 'tool',
            target: 'skill.desktop.observe',
            ok: verifyResult.ok,
            summary: verifyResult.summary,
          })

          const verifyObservation = readNestedObservationSnapshot(verifyResult.data)
          const verifyPassed =
            verifyResult.ok &&
            readCapabilityVerificationPassed(verifyResult.data) !== false &&
            matchesQueryAgainstObservation(
              verifyObservation,
              input.targetWindowTitle,
            )

          if (verifyPassed) {
            return {
              ok: true,
              summary: `Transferred text into ${input.targetWindowTitle} using named input focus.`,
              route: 'tool',
              data: {
                transferred: true,
                targetWindowTitle: input.targetWindowTitle,
              },
              operations,
              recoveryUsed: true,
              verification: {
                strategy: 'clipboard-then-type-fallback',
                passed: true,
                details: 'Named input control was found, typed, and verified afterward.',
              },
            }
          }
        }
      }

      const typeResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.type',
        { text: input.text },
      )
      operations.push({
        type: 'tool',
        target: 'windows.type',
        ok: typeResult.ok,
        summary: typeResult.summary,
      })

      if (typeResult.ok) {
        await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.wait',
          { durationSeconds: 1 },
        )

        const verifyResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'skill.desktop.observe',
        )
        operations.push({
          type: 'tool',
          target: 'skill.desktop.observe',
          ok: verifyResult.ok,
          summary: verifyResult.summary,
        })

        const verifyObservation = readNestedObservationSnapshot(verifyResult.data)
        const verifyPassed =
          verifyResult.ok &&
          readCapabilityVerificationPassed(verifyResult.data) !== false &&
          matchesQueryAgainstObservation(
            verifyObservation,
            input.targetWindowTitle,
          )

        if (verifyPassed) {
          return {
            ok: true,
            summary: `Transferred text into ${input.targetWindowTitle} using direct typing fallback.`,
            route: 'tool',
            data: {
              transferred: true,
              targetWindowTitle: input.targetWindowTitle,
            },
            operations,
            recoveryUsed: true,
            verification: {
              strategy: 'clipboard-then-type-fallback',
              passed: true,
              details: 'Direct typing fallback completed and was verified afterward.',
            },
          }
        }
      }

      return {
        ok: false,
        summary: typeResult.ok
          ? `Typed text into ${input.targetWindowTitle}, but the target was not confirmed afterward.`
          : typeResult.summary.includes('stable input anchor')
            ? `Failed to find a stable input anchor for ${input.targetWindowTitle}.`
            : `Failed to transfer text into ${input.targetWindowTitle}.`,
        route: 'tool',
        data: {
          transferred: false,
          targetWindowTitle: input.targetWindowTitle,
        },
        error: typeResult.ok
          ? 'CROSS_APP_TRANSFER_VERIFICATION_FAILED'
          : typeResult.summary.includes('stable input anchor')
            ? 'WINDOW_INPUT_ANCHOR_NOT_FOUND'
            : typeResult.error,
        failureClass: typeResult.ok
          ? 'deterministic'
          : typeResult.summary.includes('stable input anchor')
            ? 'deterministic'
            : typeResult.failureClass,
        operations,
        recoveryUsed: typeResult.ok,
        verification: {
          strategy: 'clipboard-then-type-fallback',
          passed: false,
          details: typeResult.ok
            ? 'Direct typing fallback completed, but the target app was not confirmed afterward.'
            : typeResult.summary.includes('stable input anchor')
              ? 'No stable input anchor was available for direct typing.'
              : 'Clipboard and direct typing paths both failed.',
        },
      }
    },
  }

  const fileSendToChatWindow: CapabilityDefinition<
    {
      path: string
      targetWindowTitle: string
      send?: boolean
    },
    {
      attached: boolean
      sent: boolean
      targetWindowTitle: string
      path: string
      fileName: string
    }
  > = {
    id: 'file.send_to_chat_window',
    kind: 'skill',
    title: 'Send File To Chat Window',
    description:
      'Attach a local file into a WeChat-like chat window through the standard file picker, then optionally send it.',
    searchHints: ['send local file video chat window wechat attach upload file picker'],
    tags: ['desktop', 'chat', 'wechat', 'file', 'attachment', 'video'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'send file to chat window input',
      properties: {
        path: { type: 'string' },
        targetWindowTitle: { type: 'string' },
        send: { type: 'boolean' },
      },
      required: ['path', 'targetWindowTitle'],
    },
    examples: [
      {
        task: 'Attach a local video to WeChat and send it immediately.',
        input: {
          path: 'C:\\Users\\me\\Videos\\clip.mp4',
          targetWindowTitle: 'WeChat',
          send: true,
        },
      },
    ],
    fallbacks: [
      'windows.filesystem',
      'command.app.open_or_focus',
      'windows.click_element_by_name',
      'windows.type_element_by_name',
      'windows.shortcut',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const normalizedTarget = input.targetWindowTitle.trim()
      const fileName = basename(input.path)

      if (!normalizedTarget || !isWeChatLikeWindowTitle(normalizedTarget)) {
        return {
          ok: false,
          summary: `File attachment is only supported for WeChat-like chat windows. Received ${input.targetWindowTitle}.`,
          route: 'tool',
          error: 'CHAT_WINDOW_FILE_SEND_UNSUPPORTED_TARGET',
          failureClass: 'deterministic',
          failureReason: 'target_ambiguous',
          operations,
          recoveryUsed: false,
          chainState: {
            currentTarget: normalizedTarget || input.targetWindowTitle,
            currentArtifact: input.path,
            chainStatus: 'blocked',
          },
          verificationEvidence: [
            `target=${input.targetWindowTitle}`,
            'targetSupport=wechat-only',
          ],
          verification: {
            strategy: 'wechat-only-guard',
            passed: false,
            details:
              'This capability currently supports only WeChat-like chat windows to avoid over-claiming generic file attachment support.',
          },
        }
      }

      if (!input.path.trim()) {
        return {
          ok: false,
          summary: 'File path is required.',
          route: 'tool',
          error: 'CHAT_WINDOW_FILE_SEND_PATH_REQUIRED',
          failureClass: 'deterministic',
          failureReason: 'artifact_missing',
          operations,
          recoveryUsed: false,
          chainState: {
            currentTarget: normalizedTarget,
            currentArtifact: input.path,
            chainStatus: 'blocked',
          },
          verificationEvidence: [`target=${normalizedTarget}`],
          verification: {
            strategy: 'path-required',
            passed: false,
            details: 'The requested file path was empty after trimming.',
          },
        }
      }

      const fileInfoResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.filesystem',
        {
          mode: 'info',
          path: input.path,
        },
      )
      operations.push({
        type: 'tool',
        target: 'windows.filesystem',
        ok: fileInfoResult.ok,
        summary: fileInfoResult.summary,
      })

      if (!fileInfoResult.ok) {
        return {
          ok: false,
          summary: `Could not inspect local file ${input.path}.`,
          route: 'tool',
          error: fileInfoResult.error ?? 'CHAT_WINDOW_FILE_SEND_PATH_UNAVAILABLE',
          failureClass: fileInfoResult.failureClass ?? 'deterministic',
          failureReason: 'artifact_missing',
          operations,
          recoveryUsed: false,
          recoveryPoint: `artifact:${input.path}`,
          recoveryAction: 'recover:restage',
          chainState: {
            currentTarget: normalizedTarget,
            currentArtifact: input.path,
            chainStatus: 'blocked',
          },
          verificationEvidence: [
            `target=${normalizedTarget}`,
            `path=${input.path}`,
            'fileInfo=failed',
          ],
          verification: {
            strategy: 'filesystem-info-before-attach',
            passed: false,
            details: 'The local file could not be inspected before opening the chat attachment flow.',
          },
        }
      }

      const focusResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.app.open_or_focus',
        { appName: normalizedTarget },
      )
      operations.push({
        type: 'tool',
        target: 'command.app.open_or_focus',
        ok: focusResult.ok,
        summary: focusResult.summary,
      })

      if (!focusResult.ok) {
        return {
          ok: false,
          summary: `Failed to focus ${normalizedTarget} before attaching ${fileName}.`,
          route: 'tool',
          error: focusResult.error,
          failureClass: focusResult.failureClass,
          failureReason: 'focus_drift',
          operations,
          recoveryPoint:
            readCapabilityRecoveryPoint(focusResult.data) ?? `focus:${normalizedTarget}`,
          recoveryAction: 'recover:refocus',
          recoveryUsed: false,
          chainState: {
            currentTarget: normalizedTarget,
            currentArtifact: input.path,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(focusResult.data),
            chainStatus: readCapabilityChainStatus(focusResult.data) ?? 'execution_failed',
          },
          verificationEvidence: [
            `target=${normalizedTarget}`,
            `file=${fileName}`,
            ...readCapabilityVerificationEvidence(focusResult.data),
          ],
          verification: {
            strategy: 'focus-before-attach',
            passed: false,
            details: 'The target WeChat-like window could not be focused before the attachment flow started.',
          },
        }
      }

      const attachEntryResult = await tryClickNamedElements(context, operations, {
        names: ['Upload File', 'Attach', 'File', '发送文件', '发送文件给朋友', '附件', '文件'],
        windowTitle: normalizedTarget,
      })

      if (!attachEntryResult.ok) {
        return {
          ok: false,
          summary: `Failed to open the file attachment flow in ${normalizedTarget}.`,
          route: 'tool',
          error: attachEntryResult.error ?? 'CHAT_WINDOW_FILE_SEND_ATTACH_ENTRY_FAILED',
          failureClass: attachEntryResult.failureClass ?? 'deterministic',
          failureReason: 'execution_failed',
          operations,
          recoveryPoint: `focus:${normalizedTarget}`,
          recoveryAction: 'recover:refocus',
          recoveryUsed: false,
          chainState: {
            currentTarget: normalizedTarget,
            currentArtifact: input.path,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(focusResult.data),
            chainStatus: 'execution_failed',
          },
          verificationEvidence: [
            `target=${normalizedTarget}`,
            `file=${fileName}`,
            'attachEntry=failed',
          ],
          verification: {
            strategy: 'open-attachment-entry',
            passed: false,
            details:
              'The capability could not reach a standard file picker from the WeChat-like target window.',
          },
        }
      }

      await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.wait',
        { durationSeconds: 1 },
      )

      const dialogInputResult = await tryTypeIntoNamedElements(context, operations, {
        names: ['File name', 'File name:', 'Address', '文件名', '文件名(N):', '地址', '编辑'],
        text: input.path,
        clear: true,
      })

      if (!dialogInputResult.ok) {
        const explorerFallbackResult = await tryExplorerStyleFileSelection(
          context,
          operations,
          input.path,
          fileName,
        )
        if (!explorerFallbackResult.ok) {
          return {
            ok: false,
            summary: `Opened the attachment flow for ${normalizedTarget}, but no file path input was found in the picker dialog.`,
            route: 'tool',
            error: explorerFallbackResult.error ?? dialogInputResult.error ?? 'CHAT_WINDOW_FILE_SEND_DIALOG_INPUT_MISSING',
            failureClass:
              explorerFallbackResult.failureClass ?? dialogInputResult.failureClass ?? 'deterministic',
            failureReason: 'execution_failed',
            operations,
            recoveryPoint: 'focus:打开',
            recoveryAction: 'recover:reobserve',
            recoveryUsed: false,
            chainState: {
              currentTarget: '打开',
              currentArtifact: input.path,
              lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(focusResult.data),
              chainStatus: 'execution_failed',
            },
            verificationEvidence: [
              `target=${normalizedTarget}`,
              `file=${fileName}`,
              'dialogInput=missing',
              'explorerFallback=failed',
            ],
            verification: {
              strategy: 'type-file-path-into-dialog',
              passed: false,
              details:
                'The standard file picker did not expose a stable named input field, and the explorer-style fallback could not select the requested file.',
            },
          }
        }

        if (input.send === true) {
          const sendShortcut = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.shortcut',
            { shortcut: 'enter' },
          )
          operations.push({
            type: 'tool',
            target: 'windows.shortcut',
            ok: sendShortcut.ok,
            summary: sendShortcut.summary,
          })
        }

        return {
          ok: true,
          summary: `Attached ${fileName} into ${normalizedTarget} via explorer-style picker and sent it.`,
          route: 'tool',
          output: {
            attached: true,
            sent: input.send === true,
            fileName,
            targetWindowTitle: normalizedTarget,
            path: input.path,
          },
          operations,
          recoveryUsed: true,
          chainState: {
            currentTarget: normalizedTarget,
            currentArtifact: input.path,
            lastVerifiedAnchor: normalizedTarget,
            chainStatus: 'completed',
          },
          verificationEvidence: [
            `target=${normalizedTarget}`,
            `file=${fileName}`,
            'dialogInput=missing',
            'explorerFallback=selected',
            ...(input.send === true ? ['send=enter'] : []),
          ],
          verification: {
            strategy: 'explorer-style-file-picker-fallback',
            passed: true,
            details:
              'The standard dialog input was unavailable, so the capability navigated the explorer-style picker and selected the file directly.',
          },
        }
      }

      const openButtonResult = await tryClickNamedElements(context, operations, {
        names: ['Open', '打开'],
      })

      if (!openButtonResult.ok) {
        return {
          ok: false,
          summary: `Typed ${fileName} into the picker, but could not confirm the file selection dialog.`,
          route: 'tool',
          error: openButtonResult.error ?? 'CHAT_WINDOW_FILE_SEND_DIALOG_CONFIRM_FAILED',
          failureClass: openButtonResult.failureClass ?? 'deterministic',
          failureReason: 'execution_failed',
          operations,
          recoveryPoint: 'focus:打开',
          recoveryAction: 'recover:reobserve',
          recoveryUsed: false,
          chainState: {
            currentTarget: '打开',
            currentArtifact: input.path,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(focusResult.data),
            chainStatus: 'execution_failed',
          },
          verificationEvidence: [
            `target=${normalizedTarget}`,
            `file=${fileName}`,
            'dialogConfirm=missing',
          ],
          verification: {
            strategy: 'confirm-file-dialog',
            passed: false,
            details: 'The file path was typed, but the picker confirm button could not be activated.',
          },
        }
      }

      if (input.send === true) {
        const sendShortcut = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.shortcut',
          { shortcut: 'enter' },
        )
        operations.push({
          type: 'tool',
          target: 'windows.shortcut',
          ok: sendShortcut.ok,
          summary: sendShortcut.summary,
        })

        if (!sendShortcut.ok) {
          return {
            ok: false,
            summary: `Attached ${fileName}, but failed to send it in ${normalizedTarget}.`,
            route: 'tool',
            error: sendShortcut.error ?? 'CHAT_WINDOW_FILE_SEND_SHORTCUT_FAILED',
            failureClass: sendShortcut.failureClass ?? 'deterministic',
            failureReason: 'execution_failed',
            operations,
            recoveryPoint: `focus:${normalizedTarget}`,
            recoveryAction: 'recover:refocus',
            recoveryUsed: false,
            chainState: {
              currentTarget: normalizedTarget,
              currentArtifact: input.path,
              chainStatus: 'execution_failed',
            },
            verificationEvidence: [
              `target=${normalizedTarget}`,
              `file=${fileName}`,
              'sendShortcut=failed',
            ],
            verification: {
              strategy: 'attach-then-send',
              passed: false,
              details:
                'The file picker completed, but the final send shortcut did not succeed in the WeChat-like target window.',
            },
          }
        }
      }

      await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.wait',
        { durationSeconds: 1 },
      )

      const observeAfter = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.desktop.observe',
      )
      operations.push({
        type: 'tool',
        target: 'skill.desktop.observe',
        ok: observeAfter.ok,
        summary: observeAfter.summary,
      })

      const observation = readNestedObservationSnapshot(observeAfter.data)
      const anchorCandidates = observation
        ? readMeaningfulAnchorCandidates(observation)
        : []
      const verificationEvidence = dedupeCandidateStrings([
        `target=${normalizedTarget}`,
        `file=${fileName}`,
        ...readCapabilityVerificationEvidence(observeAfter.data),
        ...buildObservationEvidence(observation),
        ...anchorCandidates,
      ])
      const targetConfirmed =
        observeAfter.ok &&
        readCapabilityVerificationPassed(observeAfter.data) !== false &&
        matchesQueryAgainstObservation(observation, normalizedTarget)
      const fileMentioned = verificationEvidence.some(item =>
        item.toLowerCase().includes(fileName.toLowerCase()),
      )
      const verificationPassed = targetConfirmed && fileMentioned

      return {
        ok: verificationPassed,
        summary: verificationPassed
          ? input.send === true
            ? `Attached and sent ${fileName} in ${normalizedTarget}.`
            : `Attached ${fileName} in ${normalizedTarget}.`
          : `The file picker flow completed, but ${normalizedTarget} could not be verified with evidence for ${fileName}.`,
        route: 'tool',
        data: {
          attached: verificationPassed,
          sent: verificationPassed && input.send === true,
          targetWindowTitle: normalizedTarget,
          path: input.path,
          fileName,
        },
        output: {
          attached: verificationPassed,
          sent: verificationPassed && input.send === true,
          targetWindowTitle: normalizedTarget,
          path: input.path,
          fileName,
        },
        error: verificationPassed
          ? undefined
          : 'CHAT_WINDOW_FILE_SEND_VERIFICATION_FAILED',
        failureClass: verificationPassed ? undefined : 'deterministic',
        failureReason: verificationPassed ? undefined : 'verification_mismatch',
        operations,
        recoveryPoint: verificationPassed ? undefined : `focus:${normalizedTarget}`,
        recoveryAction: verificationPassed ? undefined : 'recover:refocus',
        recoveryUsed: false,
        chainState: {
          currentTarget: normalizedTarget,
          currentArtifact: input.path,
          lastVerifiedAnchor:
            verificationPassed
              ? readCapabilityLastVerifiedAnchor(observeAfter.data) ?? normalizedTarget
              : undefined,
          observationConfidence:
            typeof observation?.confidence === 'number' ? observation.confidence : undefined,
          observationSource: observation?.observationMode,
          anchorMatches: verificationPassed
            ? dedupeCandidateStrings([
                readCapabilityLastVerifiedAnchor(observeAfter.data),
                observation?.windowAnchor,
                observation?.domAnchor,
                observation?.focusedWindow,
                ...anchorCandidates,
              ])
            : undefined,
          chainStatus: verificationPassed ? 'completed' : 'verified_failed',
        },
        verificationEvidence,
        verification: {
          strategy: input.send === true ? 'attach-pick-send-verify' : 'attach-pick-verify',
          passed: verificationPassed,
          details: verificationPassed
            ? 'The WeChat-like window returned after the picker flow and the observed evidence included the requested file name.'
            : 'The WeChat-like window was not re-verified with evidence that included the requested file name.',
        },
      }
    },
  }

  const crossAppOpenObserveActVerify: CapabilityDefinition<
    {
      appName: string
      text?: string
      targetWindowTitle?: string
    },
    {
      appName: string
      observed: boolean
      acted: boolean
      verified: boolean
    }
  > = {
    id: 'cross_app.open_observe_act_verify',
    kind: 'skill',
    title: 'Open Observe Act Verify',
    description:
      'Open or focus an app, observe desktop state, act, and verify with a follow-up observation.',
    searchHints: ['open observe act verify desktop app task chain'],
    tags: ['desktop', 'cross-app', 'verify', 'observe', 'focus'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'open observe act verify input',
      properties: {
        appName: { type: 'string' },
        text: { type: 'string' },
        targetWindowTitle: { type: 'string' },
      },
      required: ['appName'],
    },
    examples: [
      {
        task: 'Open Notepad, observe it, transfer text, and verify again.',
        input: {
          appName: 'Notepad',
          text: 'hello from compuser',
          targetWindowTitle: 'Notepad',
        },
      },
    ],
    fallbacks: [
      'command.app.open_or_focus',
      'command.desktop.capture_and_locate',
      'skill.cross_app.transfer_text',
      'skill.desktop.observe',
    ],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const targetWindowTitle = input.targetWindowTitle ?? input.appName
      const focusResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.app.open_or_focus',
        { appName: input.appName },
      )
      operations.push({
        type: 'tool',
        target: 'command.app.open_or_focus',
        ok: focusResult.ok,
        summary: focusResult.summary,
      })

      if (!focusResult.ok) {
        return {
          ok: false,
          summary: `Failed to open or focus ${input.appName}.`,
          route: 'tool',
          error: focusResult.error,
          failureClass: focusResult.failureClass,
          failureReason: 'focus_drift',
          operations,
          recoveryPoint: `focus:${input.appName}`,
          recoveryAction: 'recover:refocus',
          recoveryUsed: false,
          verification: {
            strategy: 'open-before-observe',
            passed: false,
            details: 'The target application could not be focused or launched.',
          },
        }
      }

      await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.wait',
        { durationSeconds: 1 },
      )

      const observeBefore = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'command.desktop.capture_and_locate',
        { query: targetWindowTitle },
      )
      operations.push({
        type: 'tool',
        target: 'command.desktop.capture_and_locate',
        ok: observeBefore.ok,
        summary: observeBefore.summary,
      })

      if (!observeBefore.ok) {
        return {
          ok: false,
          summary: 'Failed to observe desktop state before acting.',
          route: 'tool',
          error: observeBefore.error,
          failureClass: observeBefore.failureClass,
          failureReason: 'observation_insufficient',
          operations,
          recoveryPoint:
            readCapabilityRecoveryPoint(observeBefore.data) ??
            `focus:${targetWindowTitle}`,
          recoveryAction: 'recover:reobserve',
          observation:
            evaluateDesktopObservation(
              readNestedObservationSnapshot(observeBefore.data),
            ).observation,
          recoveryUsed: false,
          verification: {
            strategy: 'observe-before-act',
            passed: false,
            details: 'Observation step failed before any action.',
          },
        }
      }

      let acted = true
      if (typeof input.text === 'string' && input.text.length > 0) {
        const transferResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'skill.cross_app.transfer_text',
          {
            text: input.text,
            targetWindowTitle,
          },
        )
        operations.push({
          type: 'tool',
          target: 'skill.cross_app.transfer_text',
          ok: transferResult.ok,
          summary: transferResult.summary,
        })

        if (!transferResult.ok) {
          return {
            ok: false,
            summary: `Observed ${input.appName} but failed to complete the action step.`,
            route: 'tool',
            error: transferResult.error,
            failureClass: transferResult.failureClass,
            failureReason: 'execution_failed',
            operations,
            recoveryPoint:
              readCapabilityRecoveryPoint(transferResult.data) ??
              `focus:${targetWindowTitle}`,
            recoveryAction: 'recover:restage',
            recoveryUsed: false,
            verification: {
              strategy: 'observe-act-verify',
              passed: false,
              details: 'Action step failed after successful observation.',
            },
          }
        }

        await executeNestedTool(
          context.runtime,
          context.toolContext,
          'windows.wait',
          { durationSeconds: 1 },
        )
      } else {
        acted = false
      }

      const observeAfter = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.desktop.observe',
      )
      operations.push({
        type: 'tool',
        target: 'skill.desktop.observe',
        ok: observeAfter.ok,
        summary: observeAfter.summary,
      })

      const verifyPassed =
        observeAfter.ok &&
        readCapabilityVerificationPassed(observeAfter.data) !== false &&
        isWindowVerificationMatch(
          readNestedObservationSnapshot(observeAfter.data),
          targetWindowTitle,
        )
      let finalObserveAfter = observeAfter
      let finalVerifyPassed = verifyPassed
      let recoveryUsed = false

      if (
        !finalVerifyPassed &&
        shouldRetryWithFocusRecovery(
          readCapabilityRecoveryPoint(observeAfter.data) ?? `focus:${targetWindowTitle}`,
          targetWindowTitle,
        )
      ) {
        const refocusResult = await executeNestedTool(
          context.runtime,
          context.toolContext,
          'command.app.open_or_focus',
          { appName: input.appName },
        )
        operations.push({
          type: 'tool',
          target: 'command.app.open_or_focus',
          ok: refocusResult.ok,
          summary: refocusResult.summary,
        })

        if (refocusResult.ok) {
          await executeNestedTool(
            context.runtime,
            context.toolContext,
            'windows.wait',
            { durationSeconds: 1 },
          )

          if (typeof input.text === 'string' && input.text.length > 0) {
            const retryTransferResult = await executeNestedTool(
              context.runtime,
              context.toolContext,
              'skill.cross_app.transfer_text',
              {
                text: input.text,
                targetWindowTitle,
              },
            )
            operations.push({
              type: 'tool',
              target: 'skill.cross_app.transfer_text',
              ok: retryTransferResult.ok,
              summary: retryTransferResult.summary,
            })

            if (!retryTransferResult.ok) {
              return {
                ok: false,
                summary: `Observed ${input.appName} but failed to complete the action step.`,
                route: 'tool',
                error: retryTransferResult.error,
                failureClass: retryTransferResult.failureClass,
                failureReason: 'execution_failed',
                operations,
                recoveryPoint:
                  readCapabilityRecoveryPoint(retryTransferResult.data) ??
                  `focus:${targetWindowTitle}`,
                recoveryAction: 'recover:restage',
                recoveryUsed: true,
                verification: {
                  strategy: 'observe-act-verify',
                  passed: false,
                  details: 'Action step failed after successful recovery.',
                },
              }
            }

            await executeNestedTool(
              context.runtime,
              context.toolContext,
              'windows.wait',
              { durationSeconds: 1 },
            )
          }

          finalObserveAfter = await executeNestedTool(
            context.runtime,
            context.toolContext,
            'skill.desktop.observe',
          )
          operations.push({
            type: 'tool',
            target: 'skill.desktop.observe',
            ok: finalObserveAfter.ok,
            summary: finalObserveAfter.summary,
          })
          finalVerifyPassed =
            finalObserveAfter.ok &&
            readCapabilityVerificationPassed(finalObserveAfter.data) !== false &&
            isWindowVerificationMatch(
              readNestedObservationSnapshot(finalObserveAfter.data),
              targetWindowTitle,
            )
          recoveryUsed = true
        }
      }
      const verificationDetails = finalVerifyPassed
        ? 'Follow-up observation confirmed the target window after the action step.'
        : 'Follow-up observation did not confirm the expected target window after the action step.'

      return {
        ok: finalVerifyPassed,
        summary: finalObserveAfter.ok
          ? `Completed open/observe/act/verify chain for ${input.appName}.`
          : `Action completed for ${input.appName}, but verification observation failed.`,
        route: 'tool',
        data: {
          appName: input.appName,
          observed: true,
          acted,
          verified: finalVerifyPassed,
        },
        error: finalVerifyPassed ? undefined : finalObserveAfter.error,
        failureClass:
          finalVerifyPassed ? undefined : finalObserveAfter.failureClass ?? 'deterministic',
        failureReason: finalVerifyPassed
          ? undefined
          : finalObserveAfter.ok
            ? 'verification_failed'
            : 'observation_insufficient',
        operations,
        chainState: {
          currentTarget: targetWindowTitle,
          lastVerifiedAnchor: targetWindowTitle,
          chainStatus: finalVerifyPassed ? 'completed' : 'verified_failed',
        },
        recoveryPoint: finalVerifyPassed
          ? undefined
          : readCapabilityRecoveryPoint(finalObserveAfter.data) ??
            `focus:${targetWindowTitle}`,
        recoveryAction: finalVerifyPassed
          ? undefined
          : finalObserveAfter.ok
            ? 'recover:reobserve'
            : 'recover:refocus',
        observation: evaluateDesktopObservation(
          readNestedObservationSnapshot(finalObserveAfter.data),
        ).observation,
        verificationEvidence: readCapabilityVerificationEvidence(finalObserveAfter.data),
        recoveryUsed,
        verification: {
          strategy: 'observe-focus-act-verify',
          passed: finalVerifyPassed,
          details: verificationDetails,
        },
      }
    },
  }

  const browserEditorChatTemplate: CapabilityDefinition<
    {
      editorAppName: string
      editorTargetWindowTitle?: string
      chatAppName: string
      chatTargetWindowTitle?: string
    },
    {
      extractedText: string
      editorTargetWindowTitle: string
      chatTargetWindowTitle: string
      selectedWindowTitle: string
      staged: boolean
      delivered: boolean
      verified: boolean
      currentStage: 'verified'
      currentArtifact: string
    }
  > = {
    id: 'browser.editor_chat_template',
    kind: 'skill',
    title: 'Browser Editor Chat Template',
    description:
      'High-level browser -> editor -> IM/chat template that stages browser content through a verified editor chain, then confirms delivery into the chat target.',
    searchHints: ['browser editor chat template verified delivery'],
    tags: ['browser', 'editor', 'chat', 'template', 'verify', 'cross-app'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser editor chat template input',
      properties: {
        editorAppName: { type: 'string' },
        editorTargetWindowTitle: { type: 'string' },
        chatAppName: { type: 'string' },
        chatTargetWindowTitle: { type: 'string' },
      },
      required: ['editorAppName', 'chatAppName'],
    },
    examples: [
      {
        task: 'Capture browser content, stage it in Notepad, then confirm the final delivery in Codex chat.',
        input: {
          editorAppName: 'Notepad',
          editorTargetWindowTitle: 'Notepad',
          chatAppName: 'Codex',
          chatTargetWindowTitle: 'Codex',
        },
      },
    ],
    fallbacks: [
      'skill.browser.editor_chat_stage_and_deliver_verify',
      'skill.browser.editor_chat_stage_and_deliver',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser.editor_chat_stage_and_deliver_verify',
        {
          editorAppName: input.editorAppName,
          ...(typeof input.editorTargetWindowTitle === 'string'
            ? { editorTargetWindowTitle: input.editorTargetWindowTitle }
            : {}),
          chatAppName: input.chatAppName,
          ...(typeof input.chatTargetWindowTitle === 'string'
            ? { chatTargetWindowTitle: input.chatTargetWindowTitle }
            : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const editorTargetWindowTitle =
        extractRecordString(output, 'editorTargetWindowTitle') ??
        input.editorTargetWindowTitle ??
        input.editorAppName
      const chatTargetWindowTitle =
        extractRecordString(output, 'chatTargetWindowTitle') ??
        input.chatTargetWindowTitle ??
        input.chatAppName
      const selectedWindowTitle =
        extractRecordString(output, 'selectedWindowTitle') ??
        chatTargetWindowTitle
      const currentArtifact =
        extractRecordString(output, 'currentArtifact') ??
        'browser-editor-chat-delivery'
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.browser.editor_chat_stage_and_deliver_verify',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=browser-editor-chat',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: selectedWindowTitle,
            currentArtifact,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(templateResult.data),
            chainStatus: readCapabilityChainStatus(templateResult.data) ?? 'execution_failed',
          },
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${chatTargetWindowTitle}`,
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          verification: {
            strategy: 'phase3-browser-editor-chat-template',
            passed: false,
            details: 'Base browser -> editor -> chat verified chain failed before the template could complete.',
          },
        }
      }

      const extractedText = extractRecordString(output, 'extractedText') ?? ''

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: {
          extractedText,
          editorTargetWindowTitle,
          chatTargetWindowTitle,
          selectedWindowTitle,
          staged: true,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact,
        },
        output: {
          extractedText,
          editorTargetWindowTitle,
          chatTargetWindowTitle,
          selectedWindowTitle,
          staged: true,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact,
        },
        operations,
        chainState: {
          currentTarget: selectedWindowTitle,
          currentArtifact,
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(templateResult.data) ??
            `verified:${selectedWindowTitle}`,
          chainStatus: 'completed',
        },
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        verification: {
          strategy: 'phase3-browser-editor-chat-template',
          passed: true,
          details: 'Template completed browser capture, verified editor staging, and verified chat delivery.',
        },
      }
    },
  }

  const fileBrowserDesktopTemplate: CapabilityDefinition<
    {
      path: string
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery?: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
    },
    {
      sourcePath: string
      transformedText: string
      browserContextText?: string
      selectedWindowTitle: string
      routeReason: string
      delivered: boolean
      verified: boolean
      currentStage: 'verified'
      currentArtifact: string
    }
  > = {
    id: 'file.browser_desktop_template',
    kind: 'skill',
    title: 'File Browser Desktop Template',
    description:
      'High-level filesystem -> browser -> desktop app template that reads a file, derives routing context from the browser, and verifies final desktop delivery.',
    searchHints: ['file browser desktop template verified delivery'],
    tags: ['file', 'browser', 'desktop', 'template', 'verify', 'cross-app'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file browser desktop template input',
      properties: {
        path: { type: 'string' },
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
      },
      required: ['path', 'primaryWindowTitle', 'secondaryWindowTitle'],
    },
    examples: [
      {
        task: 'Read a local follow-up note, route it with browser context, then verify the delivery into the best desktop target.',
        input: {
          path: 'followup.txt',
          primaryWindowTitle: 'Codex',
          secondaryWindowTitle: 'WeChat',
          transform: 'uppercase',
        },
      },
    ],
    fallbacks: [
      'skill.file.browser_route_deliver_verify',
      'skill.file.browser_route_deliver',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.file.browser_route_deliver_verify',
        {
          path: input.path,
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
          ...(typeof input.routeQuery === 'string' ? { routeQuery: input.routeQuery } : {}),
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          ...(typeof input.transform === 'string' ? { transform: input.transform } : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const sourcePath = extractRecordString(output, 'sourcePath') ?? input.path
      const transformedText = extractRecordString(output, 'transformedText') ?? ''
      const browserContextText = extractRecordString(output, 'browserContextText')
      const selectedWindowTitle =
        extractRecordString(output, 'selectedWindowTitle') ?? input.secondaryWindowTitle
      const routeReason = extractRecordString(output, 'routeReason') ?? ''
      const currentArtifact = extractRecordString(output, 'currentArtifact') ?? sourcePath
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.file.browser_route_deliver_verify',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=file-browser-desktop',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: selectedWindowTitle,
            currentArtifact,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(templateResult.data),
            chainStatus: readCapabilityChainStatus(templateResult.data) ?? 'execution_failed',
          },
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ??
            'skill.file.browser_route_deliver_verify',
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          verification: {
            strategy: 'phase3-file-browser-desktop-template',
            passed: false,
            details: 'Base filesystem -> browser -> desktop verified chain failed before the template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: {
          sourcePath,
          transformedText,
          browserContextText,
          selectedWindowTitle,
          routeReason,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact,
        },
        output: {
          sourcePath,
          transformedText,
          browserContextText,
          selectedWindowTitle,
          routeReason,
          delivered: true,
          verified: true,
          currentStage: 'verified' as const,
          currentArtifact,
        },
        operations,
        chainState: {
          currentTarget: selectedWindowTitle,
          currentArtifact,
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(templateResult.data) ?? selectedWindowTitle,
          chainStatus: 'completed',
        },
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        verification: {
          strategy: 'phase3-file-browser-desktop-template',
          passed: true,
          details: 'Template completed file read, browser-derived routing, and verified desktop delivery.',
        },
      }
    },
  }

  const multiWindowRouteDeliverTemplate: CapabilityDefinition<
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery: string
      targetAppName: string
      targetWindowTitle?: string
      actionText?: string
    },
    {
      selectedWindowTitle: string
      routeReason: string
      currentStage: 'verified'
      currentArtifact: string
      executed: boolean
      verified: boolean
    }
  > = {
    id: 'multi_window.observe_route_deliver_template',
    kind: 'skill',
    title: 'Multi Window Observe Route Deliver Template',
    description:
      'High-level multi-window observe -> route -> deliver -> verify template that packages routing evidence and final verified delivery into one reusable entry point.',
    searchHints: ['multi window observe route deliver verify template'],
    tags: ['desktop', 'window', 'route', 'deliver', 'verify', 'template'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'multi window observe route deliver template input',
      properties: {
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        targetAppName: { type: 'string' },
        targetWindowTitle: { type: 'string' },
        actionText: { type: 'string' },
      },
      required: [
        'primaryWindowTitle',
        'secondaryWindowTitle',
        'routeQuery',
        'targetAppName',
      ],
    },
    examples: [
      {
        task: 'Observe two windows, route to the better target, then verify final delivery into Notepad.',
        input: {
          primaryWindowTitle: 'Browser',
          secondaryWindowTitle: 'Notepad',
          routeQuery: 'note',
          targetAppName: 'Notepad',
          targetWindowTitle: 'Notepad',
          actionText: 'hello from compuser',
        },
      },
    ],
    fallbacks: [
      'skill.multi_window.observe_route_deliver_verify',
      'skill.multi_window.observe_route_execute',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.multi_window.observe_route_deliver_verify',
        {
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
          routeQuery: input.routeQuery,
          targetAppName: input.targetAppName,
          ...(typeof input.targetWindowTitle === 'string'
            ? { targetWindowTitle: input.targetWindowTitle }
            : {}),
          ...(typeof input.actionText === 'string' ? { actionText: input.actionText } : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const selectedWindowTitle =
        extractRecordString(output, 'selectedWindowTitle') ?? input.targetAppName
      const routeReason = extractRecordString(output, 'routeReason') ?? ''
      const currentArtifact =
        extractRecordString(output, 'currentArtifact') ??
        'multi-window-observe-route-deliver-verify'
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.multi_window.observe_route_deliver_verify',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=multi-window-route-deliver',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          operations,
          chainState: {
            currentTarget: input.targetAppName,
            currentArtifact,
            lastVerifiedAnchor: readCapabilityLastVerifiedAnchor(templateResult.data),
            chainStatus: readCapabilityChainStatus(templateResult.data) ?? 'execution_failed',
          },
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${input.targetAppName}`,
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          verification: {
            strategy: 'phase3-multi-window-route-deliver-template',
            passed: false,
            details: 'Base multi-window observe -> route -> deliver -> verify chain failed before the template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: {
          selectedWindowTitle,
          routeReason,
          currentStage: 'verified' as const,
          currentArtifact,
          executed: true,
          verified: true,
        },
        output: {
          selectedWindowTitle,
          routeReason,
          currentStage: 'verified' as const,
          currentArtifact,
          executed: true,
          verified: true,
        },
        operations,
        chainState: {
          currentTarget: input.targetAppName,
          currentArtifact,
          lastVerifiedAnchor:
            readCapabilityLastVerifiedAnchor(templateResult.data) ?? selectedWindowTitle,
          chainStatus: 'completed',
        },
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        verification: {
          strategy: 'phase3-multi-window-route-deliver-template',
          passed: true,
          details: 'Template completed multi-window observation, route selection, and verified final delivery.',
        },
      }
    },
  }

  const browserEditorChatReplyTemplate: CapabilityDefinition<
    {
      editorAppName: string
      editorTargetWindowTitle?: string
      chatAppName: string
      chatTargetWindowTitle?: string
    },
    Record<string, unknown>
  > = {
    id: 'browser.editor_chat_reply_template',
    kind: 'skill',
    title: 'Browser Editor Chat Reply Template',
    description:
      'Phase 4 browser reply template skeleton that reuses the verified browser -> editor -> chat delivery chain.',
    searchHints: ['phase4 browser editor chat reply template'],
    tags: ['browser', 'editor', 'chat', 'template', 'phase4'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser editor chat reply template input',
      properties: {
        editorAppName: { type: 'string' },
        editorTargetWindowTitle: { type: 'string' },
        chatAppName: { type: 'string' },
        chatTargetWindowTitle: { type: 'string' },
      },
      required: ['editorAppName', 'chatAppName'],
    },
    examples: [
      {
        task: 'Capture browser context, draft a reply in an editor, then deliver the verified reply into a chat window.',
        input: {
          editorAppName: 'Notepad',
          editorTargetWindowTitle: 'Notepad',
          chatAppName: 'Codex',
          chatTargetWindowTitle: 'Codex',
        },
      },
    ],
    fallbacks: [
      'skill.browser.editor_chat_stage_and_deliver_verify',
      'skill.browser.editor_chat_stage_and_deliver',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser.editor_chat_stage_and_deliver_verify',
        {
          editorAppName: input.editorAppName,
          ...(typeof input.editorTargetWindowTitle === 'string'
            ? { editorTargetWindowTitle: input.editorTargetWindowTitle }
            : {}),
          chatAppName: input.chatAppName,
          ...(typeof input.chatTargetWindowTitle === 'string'
            ? { chatTargetWindowTitle: input.chatTargetWindowTitle }
            : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const currentTarget =
        readTemplateChainCurrentTarget(templateResult.data) ??
        extractRecordString(output, 'selectedWindowTitle') ??
        extractRecordString(output, 'chatTargetWindowTitle') ??
        input.chatTargetWindowTitle ??
        input.chatAppName
      const currentArtifact =
        readTemplateChainCurrentArtifact(templateResult.data) ??
        extractRecordString(output, 'currentArtifact') ??
        'browser-editor-chat-delivery'
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.browser.editor_chat_stage_and_deliver_verify',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=browser-editor-chat-reply',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]
      const normalizedOutput = buildPhase5TemplateOutput(output, {
        selectedWindowTitle: currentTarget,
        currentArtifact,
      })

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        const failureReason = deriveTemplateFailureReason(templateResult.data)
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          failureReason,
          operations,
          data: normalizedOutput,
          output: normalizedOutput,
          chainState: buildTemplateChainState(templateResult.data, {
            currentTarget,
            currentArtifact,
            fallbackChainStatus:
              readCapabilityChainStatus(templateResult.data) === 'verified_failed'
                ? 'verified_failed'
                : failureReason === 'routing_failed'
                  ? 'routing_failed'
                  : failureReason === 'observation_insufficient'
                    ? 'environment_unready'
                    : 'execution_failed',
            fallbackAnchor: `focus:${currentTarget}`,
          }),
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${currentTarget}`,
          recoveryAction: deriveTemplateRecoveryAction(templateResult.data, failureReason),
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          observation:
            typeof templateResult.data === 'object' && templateResult.data !== null
              ? ((templateResult.data as { observation?: unknown }).observation as
                  | CapabilityObservation
                  | undefined)
              : undefined,
          routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
          verification: {
            strategy: 'phase4-browser-editor-chat-reply-template',
            passed: false,
            details:
              'Base browser -> editor -> chat verified chain failed before the reply template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: normalizedOutput,
        output: normalizedOutput,
        operations,
        chainState: buildTemplateChainState(templateResult.data, {
          currentTarget,
          currentArtifact,
          fallbackChainStatus: 'verified',
          fallbackAnchor: `verified:${currentTarget}`,
        }),
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
        verification: {
          strategy: 'phase4-browser-editor-chat-reply-template',
          passed: true,
          details:
            'Reply template completed by reusing the verified browser -> editor -> chat delivery chain.',
        },
      }
    },
  }

  const browserDocDesktopDeliverTemplate: CapabilityDefinition<
    {
      editorAppName: string
      editorTargetWindowTitle?: string
      finalAppName: string
      finalTargetWindowTitle?: string
    },
    Record<string, unknown>
  > = {
    id: 'browser.doc_desktop_deliver_template',
    kind: 'skill',
    title: 'Browser Doc Desktop Deliver Template',
    description:
      'Phase 4 browser document delivery template skeleton that reuses the verified browser -> editor -> desktop delivery chain.',
    searchHints: ['phase4 browser doc desktop deliver template'],
    tags: ['browser', 'editor', 'desktop', 'template', 'phase4'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser doc desktop deliver template input',
      properties: {
        editorAppName: { type: 'string' },
        editorTargetWindowTitle: { type: 'string' },
        finalAppName: { type: 'string' },
        finalTargetWindowTitle: { type: 'string' },
      },
      required: ['editorAppName', 'finalAppName'],
    },
    examples: [
      {
        task: 'Capture browser content, stage it in an editor, then deliver the verified document into a desktop target.',
        input: {
          editorAppName: 'Notepad',
          editorTargetWindowTitle: 'Notepad',
          finalAppName: 'WeChat',
          finalTargetWindowTitle: 'WeChat',
        },
      },
    ],
    fallbacks: [
      'skill.browser.editor_stage_and_deliver',
      'skill.browser_to_editor.capture_verify',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser.editor_stage_and_deliver',
        {
          editorAppName: input.editorAppName,
          ...(typeof input.editorTargetWindowTitle === 'string'
            ? { editorTargetWindowTitle: input.editorTargetWindowTitle }
            : {}),
          finalAppName: input.finalAppName,
          ...(typeof input.finalTargetWindowTitle === 'string'
            ? { finalTargetWindowTitle: input.finalTargetWindowTitle }
            : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const currentTarget =
        readTemplateChainCurrentTarget(templateResult.data) ??
        extractRecordString(output, 'selectedWindowTitle') ??
        extractRecordString(output, 'finalTargetWindowTitle') ??
        input.finalTargetWindowTitle ??
        input.finalAppName
      const currentArtifact =
        readTemplateChainCurrentArtifact(templateResult.data) ??
        extractRecordString(output, 'currentArtifact') ??
        'browser-editor-final-delivery'
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.browser.editor_stage_and_deliver',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=browser-doc-desktop-deliver',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]
      const normalizedOutput = buildPhase5TemplateOutput(output, {
        selectedWindowTitle: currentTarget,
        currentArtifact,
      })

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        const failureReason = deriveTemplateFailureReason(templateResult.data)
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          failureReason,
          operations,
          data: normalizedOutput,
          output: normalizedOutput,
          chainState: buildTemplateChainState(templateResult.data, {
            currentTarget,
            currentArtifact,
            fallbackChainStatus:
              failureReason === 'routing_failed'
                ? 'routing_failed'
                : failureReason === 'observation_insufficient'
                  ? 'environment_unready'
                  : 'execution_failed',
            fallbackAnchor: currentTarget,
          }),
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${currentTarget}`,
          recoveryAction: deriveTemplateRecoveryAction(templateResult.data, failureReason),
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          observation:
            typeof templateResult.data === 'object' && templateResult.data !== null
              ? ((templateResult.data as { observation?: unknown }).observation as
                  | CapabilityObservation
                  | undefined)
              : undefined,
          routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
          verification: {
            strategy: 'phase4-browser-doc-desktop-deliver-template',
            passed: false,
            details:
              'Base browser -> editor -> desktop chain failed before the document delivery template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: normalizedOutput,
        output: normalizedOutput,
        operations,
        chainState: buildTemplateChainState(templateResult.data, {
          currentTarget,
          currentArtifact,
          fallbackChainStatus: 'verified',
          fallbackAnchor: currentTarget,
        }),
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
        verification: {
          strategy: 'phase4-browser-doc-desktop-deliver-template',
          passed: true,
          details:
            'Document delivery template completed by reusing the verified browser -> editor -> desktop chain.',
        },
      }
    },
  }

  const browserTypeElementByName: CapabilityDefinition<
    {
      name: string
      text: string
      windowTitle?: string
      matchMode?: 'contains' | 'exact'
      clear?: boolean
      pressEnter?: boolean
    },
    {
      typed: boolean
      elementName: string
      windowTitle?: string
    }
  > = {
    id: 'browser.type_element_by_name',
    kind: 'skill',
    title: 'Browser Type Element By Name',
    description: 'Type text into a visible browser form element by name.',
    searchHints: ['browser type element name input form field'],
    tags: ['browser', 'type', 'input', 'form', 'field'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser type element by name input',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        windowTitle: { type: 'string' },
        matchMode: { type: 'string' },
        clear: { type: 'boolean' },
        pressEnter: { type: 'boolean' },
      },
      required: ['name', 'text'],
    },
    examples: [
      {
        task: 'Type credentials into the browser login form.',
        input: {
          name: '用户名或手机号',
          text: 'demo_patient',
          windowTitle: 'Microsoft Edge',
          clear: true,
        },
      },
    ],
    fallbacks: ['windows.type_element_by_name'],
    async execute(input, context) {
      const operations: CapabilityOperation[] = []
      const typeResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.type_element_by_name',
        {
          name: input.name,
          text: input.text,
          windowTitle: input.windowTitle ?? 'Microsoft Edge',
          matchMode: input.matchMode,
          clear: input.clear === true,
          pressEnter: input.pressEnter === true,
        },
      )
      operations.push({
        type: 'tool',
        target: 'windows.type_element_by_name',
        ok: typeResult.ok,
        summary: typeResult.summary,
      })

      const typed =
        typeResult.ok && readCapabilityVerificationPassed(typeResult.data) !== false
      return {
        ok: typed,
        summary: typed
          ? `Typed into browser element "${input.name}".`
          : `Failed to type into browser element "${input.name}".`,
        route: 'tool',
        data: {
          typed,
          elementName: input.name,
          windowTitle: input.windowTitle ?? 'Microsoft Edge',
        },
        error: typed ? undefined : typeResult.error,
        failureClass: typed ? undefined : typeResult.failureClass ?? 'deterministic',
        operations,
        recoveryPoint: typed ? undefined : `focus:${input.windowTitle ?? 'Microsoft Edge'}`,
        recoveryUsed: false,
        verification: {
          strategy: 'browser-type-by-name',
          passed: typed,
          details: typed
            ? 'Browser form input was resolved by name and typed successfully.'
            : 'Browser form input could not be resolved or typed.',
        },
      }
    },
  }

  const fileBrowserFormSubmitTemplate: CapabilityDefinition<
    {
      path: string
      browserWindowTitle: string
      offset?: number
      limit?: number
      transform?: 'none' | 'trim' | 'uppercase' | 'lowercase'
      pressEnter?: boolean
    },
    Record<string, unknown>
  > = {
    id: 'file.browser_form_submit_template',
    kind: 'skill',
    title: 'File Browser Form Submit Template',
    description:
      'Phase 4 file-to-browser form submission skeleton that reuses the read/transform/transfer chain against a browser window target.',
    searchHints: ['phase4 file browser form submit template'],
    tags: ['file', 'browser', 'form', 'template', 'phase4'],
    preferredRoute: 'cli',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'file browser form submit template input',
      properties: {
        path: { type: 'string' },
        browserWindowTitle: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        transform: { type: 'string' },
        pressEnter: { type: 'boolean' },
      },
      required: ['path', 'browserWindowTitle'],
    },
    examples: [
      {
        task: 'Read a local draft, transform it, then submit it into a browser form target.',
        input: {
          path: 'draft.txt',
          browserWindowTitle: 'Microsoft Edge',
          transform: 'trim',
          pressEnter: true,
        },
      },
    ],
    fallbacks: [
      'skill.file_read_transform_transfer',
      'skill.cross_app.open_observe_act_verify',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.file_read_transform_transfer',
        {
          path: input.path,
          targetWindowTitle: input.browserWindowTitle,
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          ...(typeof input.transform === 'string' ? { transform: input.transform } : {}),
          ...(input.pressEnter === true ? { pressEnter: true } : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const currentTarget =
        readTemplateChainCurrentTarget(templateResult.data) ??
        extractRecordString(output, 'targetWindowTitle') ??
        input.browserWindowTitle
      const currentArtifact =
        readTemplateChainCurrentArtifact(templateResult.data) ??
        extractRecordString(output, 'sourcePath') ??
        input.path
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.file_read_transform_transfer',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=file-browser-form-submit',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]
      const normalizedOutput = buildPhase5TemplateOutput(output, {
        selectedWindowTitle: currentTarget,
        currentArtifact,
      })

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        const transformedText = extractRecordString(output, 'transformedText')
        const browserSubmitRecovery = await tryBrowserFormSubmitRecovery(
          {
            runtime: context.runtime,
            toolContext: context.toolContext,
          },
          {
            browserWindowTitle: input.browserWindowTitle,
            transformedText,
            pressEnter: input.pressEnter === true,
          },
        )
        if (browserSubmitRecovery) {
          const recoveredOutput = buildPhase5TemplateOutput(
            {
              ...output,
              selectedWindowTitle: input.browserWindowTitle,
              currentTarget: input.browserWindowTitle,
              currentArtifact,
              targetWindowTitle: input.browserWindowTitle,
              transferred: true,
            },
            {
              selectedWindowTitle: input.browserWindowTitle,
              currentArtifact,
            },
          )
          return {
            ok: true,
            summary: browserSubmitRecovery.summary,
            route: 'tool',
            data: recoveredOutput,
            output: recoveredOutput,
            operations: [...operations, ...browserSubmitRecovery.operations],
            chainState: {
              currentTarget: input.browserWindowTitle,
              currentArtifact,
              lastVerifiedAnchor: input.browserWindowTitle,
              chainStatus: 'completed',
            },
            verificationEvidence: [
              ...verificationEvidence,
              ...browserSubmitRecovery.verificationEvidence,
            ],
            recoveryUsed: true,
            routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
            verification: {
              strategy: 'phase4-file-browser-form-submit-template',
              passed: true,
              details:
                'Browser form submit template recovered by targeting a visible browser form field after the generic transfer chain failed.',
            },
          }
        }

        const failureReason = deriveTemplateFailureReason(templateResult.data)
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          failureReason,
          operations,
          data: normalizedOutput,
          output: normalizedOutput,
          chainState: buildTemplateChainState(templateResult.data, {
            currentTarget,
            currentArtifact,
            fallbackChainStatus:
              failureReason === 'routing_failed'
                ? 'routing_failed'
                : failureReason === 'observation_insufficient'
                  ? 'environment_unready'
                  : 'execution_failed',
            fallbackAnchor: currentTarget,
          }),
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${currentTarget}`,
          recoveryAction: deriveTemplateRecoveryAction(templateResult.data, failureReason),
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          observation:
            typeof templateResult.data === 'object' && templateResult.data !== null
              ? ((templateResult.data as { observation?: unknown }).observation as
                  | CapabilityObservation
                  | undefined)
              : undefined,
          routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
          verification: {
            strategy: 'phase4-file-browser-form-submit-template',
            passed: false,
            details:
              'Base file read/transform/transfer chain failed before the browser form submit template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: normalizedOutput,
        output: normalizedOutput,
        operations,
        chainState: buildTemplateChainState(templateResult.data, {
          currentTarget,
          currentArtifact,
          fallbackChainStatus: 'verified',
          fallbackAnchor: currentTarget,
        }),
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
        verification: {
          strategy: 'phase4-file-browser-form-submit-template',
          passed: true,
          details:
            'Browser form submit template completed by reusing the read/transform/transfer chain against the browser target.',
        },
      }
    },
  }

  const multiWindowCompareSummarizeDeliverTemplate: CapabilityDefinition<
    {
      primaryWindowTitle: string
      secondaryWindowTitle: string
      routeQuery: string
      targetAppName: string
      targetWindowTitle?: string
      actionText?: string
    },
    Record<string, unknown>
  > = {
    id: 'multi_window.compare_summarize_deliver_template',
    kind: 'skill',
    title: 'Multi Window Compare Summarize Deliver Template',
    description:
      'Phase 4 multi-window compare/summarize/deliver skeleton that reuses the verified observe -> route -> deliver chain.',
    searchHints: ['phase4 multi window compare summarize deliver template'],
    tags: ['desktop', 'window', 'compare', 'deliver', 'template', 'phase4'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'multi window compare summarize deliver template input',
      properties: {
        primaryWindowTitle: { type: 'string' },
        secondaryWindowTitle: { type: 'string' },
        routeQuery: { type: 'string' },
        targetAppName: { type: 'string' },
        targetWindowTitle: { type: 'string' },
        actionText: { type: 'string' },
      },
      required: [
        'primaryWindowTitle',
        'secondaryWindowTitle',
        'routeQuery',
        'targetAppName',
      ],
    },
    examples: [
      {
        task: 'Compare two windows, summarize the better route, then deliver through the verified multi-window chain.',
        input: {
          primaryWindowTitle: 'Browser',
          secondaryWindowTitle: 'Notepad',
          routeQuery: 'note',
          targetAppName: 'Notepad',
          targetWindowTitle: 'Notepad',
          actionText: 'phase4 compare summarize deliver',
        },
      },
    ],
    fallbacks: [
      'skill.multi_window.observe_route_deliver_verify',
      'skill.app.switch_collect_compare',
    ],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.multi_window.observe_route_deliver_verify',
        {
          primaryWindowTitle: input.primaryWindowTitle,
          secondaryWindowTitle: input.secondaryWindowTitle,
          routeQuery: input.routeQuery,
          targetAppName: input.targetAppName,
          ...(typeof input.targetWindowTitle === 'string'
            ? { targetWindowTitle: input.targetWindowTitle }
            : {}),
          ...(typeof input.actionText === 'string' ? { actionText: input.actionText } : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const currentTarget =
        readTemplateChainCurrentTarget(templateResult.data) ??
        extractRecordString(output, 'selectedWindowTitle') ??
        input.targetWindowTitle ??
        input.targetAppName
      const currentArtifact =
        readTemplateChainCurrentArtifact(templateResult.data) ??
        extractRecordString(output, 'currentArtifact') ??
        'multi-window-observe-route-deliver-verify'
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.multi_window.observe_route_deliver_verify',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=multi-window-compare-summarize-deliver',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]
      const normalizedOutput = buildPhase5TemplateOutput(output, {
        selectedWindowTitle: currentTarget,
        currentArtifact,
      })

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        const failureReason = deriveTemplateFailureReason(templateResult.data)
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          failureReason,
          operations,
          data: normalizedOutput,
          output: normalizedOutput,
          chainState: buildTemplateChainState(templateResult.data, {
            currentTarget,
            currentArtifact,
            fallbackChainStatus:
              failureReason === 'routing_failed'
                ? 'routing_failed'
                : failureReason === 'observation_insufficient'
                  ? 'environment_unready'
                  : 'execution_failed',
            fallbackAnchor: currentTarget,
          }),
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${currentTarget}`,
          recoveryAction: deriveTemplateRecoveryAction(templateResult.data, failureReason),
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          observation:
            typeof templateResult.data === 'object' && templateResult.data !== null
              ? ((templateResult.data as { observation?: unknown }).observation as
                  | CapabilityObservation
                  | undefined)
              : undefined,
          routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
          verification: {
            strategy: 'phase4-multi-window-compare-summarize-deliver-template',
            passed: false,
            details:
              'Base multi-window observe -> route -> deliver chain failed before the compare/summarize/deliver template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: normalizedOutput,
        output: normalizedOutput,
        operations,
        chainState: buildTemplateChainState(templateResult.data, {
          currentTarget,
          currentArtifact,
          fallbackChainStatus: 'verified',
          fallbackAnchor: currentTarget,
        }),
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
        verification: {
          strategy: 'phase4-multi-window-compare-summarize-deliver-template',
          passed: true,
          details:
            'Compare/summarize/deliver template completed by reusing the verified multi-window observe -> route -> deliver chain.',
        },
      }
    },
  }

  const browserExtractTransformPostTemplate: CapabilityDefinition<
    {
      targetWindowTitle: string
      pressEnter?: boolean
    },
    Record<string, unknown>
  > = {
    id: 'browser.extract_transform_post_template',
    kind: 'skill',
    title: 'Browser Extract Transform Post Template',
    description:
      'Phase 4 browser extract/post skeleton that currently reuses the browser extract -> transfer chain as the minimal verified path.',
    searchHints: ['phase4 browser extract transform post template'],
    tags: ['browser', 'extract', 'post', 'template', 'phase4'],
    preferredRoute: 'tool',
    riskLevel: 'high',
    retryPolicy: {
      retryable: false,
      maxAttempts: 1,
      retryOn: [],
    },
    inputSchema: {
      description: 'browser extract transform post template input',
      properties: {
        targetWindowTitle: { type: 'string' },
        pressEnter: { type: 'boolean' },
      },
      required: ['targetWindowTitle'],
    },
    examples: [
      {
        task: 'Extract transferable browser text and post it into a verified target window.',
        input: {
          targetWindowTitle: 'Notepad',
          pressEnter: true,
        },
      },
    ],
    fallbacks: ['skill.browser.extract_then_transfer', 'skill.cross_app.transfer_text'],
    async execute(input, context) {
      const templateResult = await executeNestedTool(
        context.runtime,
        context.toolContext,
        'skill.browser.extract_then_transfer',
        {
          targetWindowTitle: input.targetWindowTitle,
          ...(input.pressEnter === true || shouldSubmitWithEnter(input.targetWindowTitle)
            ? { pressEnter: true }
            : {}),
        },
      )

      const output = readCapabilityOutputRecord(templateResult.data)
      const currentTarget =
        readTemplateChainCurrentTarget(templateResult.data) ??
        extractRecordString(output, 'targetWindowTitle') ??
        input.targetWindowTitle
      const currentArtifact =
        readTemplateChainCurrentArtifact(templateResult.data) ??
        'browser-dom-extract'
      const operations: CapabilityOperation[] = [
        {
          type: 'tool',
          target: 'skill.browser.extract_then_transfer',
          ok: templateResult.ok,
          summary: templateResult.summary,
        },
      ]
      const verificationEvidence = [
        'template=browser-extract-transform-post',
        ...readCapabilityVerificationEvidence(templateResult.data),
      ]
      const normalizedOutput = buildPhase5TemplateOutput(output, {
        selectedWindowTitle: currentTarget,
        currentArtifact,
      })

      if (!templateResult.ok || readCapabilityVerificationPassed(templateResult.data) === false) {
        const failureReason = deriveTemplateFailureReason(templateResult.data)
        return {
          ok: false,
          summary: templateResult.summary,
          route: 'tool',
          error: templateResult.error,
          failureClass: templateResult.failureClass ?? 'deterministic',
          failureReason,
          operations,
          data: normalizedOutput,
          output: normalizedOutput,
          chainState: buildTemplateChainState(templateResult.data, {
            currentTarget,
            currentArtifact,
            fallbackChainStatus:
              failureReason === 'routing_failed'
                ? 'routing_failed'
                : failureReason === 'observation_insufficient'
                  ? 'environment_unready'
                  : 'execution_failed',
            fallbackAnchor: currentTarget,
          }),
          recoveryPoint:
            readCapabilityRecoveryPoint(templateResult.data) ?? `focus:${currentTarget}`,
          recoveryAction: deriveTemplateRecoveryAction(templateResult.data, failureReason),
          verificationEvidence,
          recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
          observation:
            typeof templateResult.data === 'object' && templateResult.data !== null
              ? ((templateResult.data as { observation?: unknown }).observation as
                  | CapabilityObservation
                  | undefined)
              : undefined,
          routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
          verification: {
            strategy: 'phase4-browser-extract-transform-post-template',
            passed: false,
            details:
              'Base browser extract -> transfer chain failed before the extract/post template could complete.',
          },
        }
      }

      return {
        ok: true,
        summary: templateResult.summary,
        route: 'tool',
        data: normalizedOutput,
        output: normalizedOutput,
        operations,
        chainState: buildTemplateChainState(templateResult.data, {
          currentTarget,
          currentArtifact,
          fallbackChainStatus: 'verified',
          fallbackAnchor: currentTarget,
        }),
        verificationEvidence,
        recoveryUsed: readCapabilityRecoveryUsed(templateResult.data),
        routingPolicy: [...PHASE4_TEMPLATE_ROUTING_POLICY],
        verification: {
          strategy: 'phase4-browser-extract-transform-post-template',
          passed: true,
          details:
            'Extract/post template completed by reusing the browser extract -> transfer chain as the minimal verified Phase 4 path.',
        },
      }
    },
  }

  return [
    desktopObserve,
    inspectTree,
    searchText,
    readText,
    appOpenOrFocus,
    desktopCaptureAndLocate,
    clipboardReadWrite,
    browserInspectDom,
    browserExtractThenTransfer,
    browserClickElementByName,
    browserTypeElementByName,
    fileReadTransformTransfer,
    browserToEditorCaptureVerify,
    browserRouteCaptureTransfer,
    browserEditorStageAndDeliver,
    browserEditorChatStageAndDeliver,
    browserEditorChatStageAndDeliverVerify,
    browserEditorChatTemplate,
    browserEditorChatReplyTemplate,
    fileBrowserChatRouteDeliver,
    fileBrowserChatRouteDeliverVerify,
    fileBrowserRouteDeliver,
    fileBrowserRouteDeliverVerify,
    fileBrowserDesktopTemplate,
    browserDocDesktopDeliverTemplate,
    fileBrowserFormSubmitTemplate,
    appSwitchCollectCompare,
    multiWindowObserveRouteExecute,
    multiWindowObserveRouteDeliverVerify,
    multiWindowRouteDeliverTemplate,
    multiWindowCompareSummarizeDeliverTemplate,
    browserExtractTransformPostTemplate,
    crossAppTransferText,
    fileSendToChatWindow,
    crossAppOpenObserveActVerify,
  ]
}

function requireCliAdapter(
  context: CapabilityExecuteContext,
  capabilityToolName: string,
) {
  if (!context.cliAdapter) {
    throw new Error(`${capabilityToolName} missing CLI/backend adapter.`)
  }

  return context.cliAdapter
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''")
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

function parseJsonOutput(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) {
    return {}
  }

  return JSON.parse(trimmed)
}

function cliFailureResult(
  route: 'cli' | 'backend',
  cliResult: {
    summary: string
    stderr: string
    timedOut: boolean
  },
  operations: Array<{
    type: 'tool' | 'cli'
    target: string
    ok: boolean
    summary: string
  }>,
  strategy: string,
  details: string,
) {
  const failureClass: CapabilityFailureClass = cliResult.timedOut
    ? 'transient'
    : 'deterministic'
  return {
    ok: false,
    summary: cliResult.summary,
    route,
    error: cliResult.timedOut ? 'CLI_COMMAND_TIMEOUT' : 'CLI_COMMAND_FAILED',
    failureClass,
    operations,
    verification: {
      strategy,
      passed: false,
      details: `${details} stderr=${cliResult.stderr.trim().slice(0, 240)}`,
    },
  }
}

function readDesktopSnapshot(value: unknown): DesktopSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.windows)
  ) {
    return candidate as unknown as DesktopSnapshot
  }

  return undefined
}

async function resolveDesktopSnapshotFromToolResult(
  context: CapabilityExecuteContext,
  result: {
    data?: unknown
    pointer?: string
  },
): Promise<DesktopSnapshot | undefined> {
  const directSnapshot = readDesktopSnapshot(result.data)
  if (directSnapshot) {
    return directSnapshot
  }

  if (!result.pointer) {
    return undefined
  }

  const pointerContent = await readPointerContent(context, result.pointer)
  const resolved = parseNestedJsonValue(pointerContent)
  return readDesktopSnapshot(resolved)
}

async function readPointerContent(
  context: CapabilityExecuteContext,
  pointer: string,
): Promise<string> {
  let offset = 0
  let content = ''

  for (let index = 0; index < 32; index += 1) {
    const readBack = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'artifacts.read_result',
      {
        pointer,
        maxChars: 20_000,
        offset,
      },
    )

    if (!readBack.ok) {
      throw new Error(`Failed to read pointer content: ${pointer}`)
    }

    const payload = readBack.data as {
      content?: unknown
      hasMore?: unknown
      nextOffset?: unknown
    } | undefined

    if (typeof payload?.content !== 'string') {
      throw new Error(`Pointer content missing: ${pointer}`)
    }

    content += payload.content

    if (payload.hasMore !== true) {
      return content
    }

    if (typeof payload.nextOffset !== 'number') {
      throw new Error(`Pointer nextOffset missing: ${pointer}`)
    }

    offset = payload.nextOffset
  }

  throw new Error(`Pointer read exceeded chunk budget: ${pointer}`)
}

function parseNestedJsonValue(value: string): unknown {
  let current: unknown = value

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

function readNestedObservationSnapshot(value: unknown): DesktopSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const directSnapshot = readDesktopSnapshot(value)
  if (directSnapshot) {
    return directSnapshot
  }

  const candidate = value as {
    observation?: unknown
    output?: unknown
  }
  const directObservation = readDesktopSnapshot(candidate.observation)
  if (directObservation) {
    return directObservation
  }

  if (typeof candidate.output === 'object' && candidate.output !== null) {
    const output = candidate.output as {
      observation?: unknown
    } & Record<string, unknown>

    const nestedSnapshot = readDesktopSnapshot(output)
    if (nestedSnapshot) {
      return nestedSnapshot
    }

    return readDesktopSnapshot(output.observation)
  }

  return undefined
}

function readObservationAnchor(snapshot: DesktopSnapshot): string | undefined {
  return (
    snapshot.windowAnchor ??
    snapshot.domAnchor ??
    snapshot.anchors?.[0] ??
    snapshot.focusedWindow ??
    snapshot.windows[0]
  )
}

function evaluateDesktopObservation(snapshot: DesktopSnapshot | undefined): {
  sufficient: boolean
  anchor: string | undefined
  recoveryPoint: string | undefined
  recoveryAction: CapabilityRecoveryAction | undefined
  failureReason: CapabilityFailureReason | undefined
  observation: CapabilityObservation | undefined
  evidence: string[]
  chainStatus: 'completed' | 'verified_failed'
} {
  if (!snapshot) {
    return {
      sufficient: false,
      anchor: undefined,
      recoveryPoint: undefined,
      recoveryAction: 'recover:reobserve',
      failureReason: 'observation_insufficient',
      observation: undefined,
      evidence: [],
      chainStatus: 'verified_failed',
    }
  }

  const anchor = readObservationAnchor(snapshot)
  const confidence = typeof snapshot.confidence === 'number' ? snapshot.confidence : 0
  const sufficient =
    confidence >= 0.5 &&
    Boolean(anchor) &&
    ((snapshot.anchors?.length ?? 0) > 0 || snapshot.windows.length > 0)

  return {
    sufficient,
    anchor,
    recoveryPoint:
      snapshot.recoveryPoint ??
      anchor ??
      `observe:${snapshot.observationMode ?? 'snapshot'}`,
    recoveryAction: sufficient
      ? undefined
      : snapshot.observationMode === 'dom'
        ? 'recover:reobserve'
        : snapshot.windowAnchor
          ? 'recover:refocus'
          : 'recover:reobserve',
    failureReason: sufficient ? undefined : 'observation_insufficient',
    observation: {
      confidence,
      sufficient,
      mode: snapshot.observationMode,
      windowAnchor: snapshot.windowAnchor,
      domAnchor: snapshot.domAnchor,
      textAnchor: anchor,
    },
    evidence: buildObservationEvidence(snapshot),
    chainStatus: sufficient ? 'completed' : 'verified_failed',
  }
}

function isObservationSufficient(snapshot: DesktopSnapshot | undefined): boolean {
  return evaluateDesktopObservation(snapshot).sufficient
}

function buildObservationChainState(snapshot: DesktopSnapshot | undefined) {
  const evaluation = evaluateDesktopObservation(snapshot)
  if (!snapshot) {
    return {
      chainStatus: 'verified_failed' as const,
    }
  }

  return {
    currentTarget:
      snapshot.focusedWindow ??
      snapshot.windowAnchor ??
      snapshot.windows[0],
    currentArtifact: snapshot.observationMode,
    lastVerifiedAnchor: evaluation.anchor ?? snapshot.focusedWindow,
    chainStatus: evaluation.chainStatus,
  }
}

function buildObservationEvidence(
  snapshot: DesktopSnapshot | undefined,
): string[] {
  if (!snapshot) {
    return []
  }

  return [
    snapshot.observationMode ? `mode=${snapshot.observationMode}` : undefined,
    typeof snapshot.confidence === 'number'
      ? `confidence=${snapshot.confidence}`
      : undefined,
    snapshot.windowAnchor ? `windowAnchor=${snapshot.windowAnchor}` : undefined,
    snapshot.domAnchor ? `domAnchor=${snapshot.domAnchor}` : undefined,
    snapshot.focusedWindow ? `focused=${snapshot.focusedWindow}` : undefined,
    snapshot.anchors?.[0] ? `anchor=${snapshot.anchors[0]}` : undefined,
    snapshot.recoveryPoint ? `recovery=${snapshot.recoveryPoint}` : undefined,
    snapshot.domSummary,
  ].filter((value): value is string => Boolean(value))
}

function readCapabilityVerificationPassed(data: unknown): boolean | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const verification = (data as { verification?: unknown }).verification
  if (typeof verification !== 'object' || verification === null) {
    return undefined
  }

  const passed = (verification as { passed?: unknown }).passed
  return typeof passed === 'boolean' ? passed : undefined
}

function readCapabilityOutputString(
  data: unknown,
  key: string,
): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const output = (data as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) {
    return undefined
  }

  const value = (output as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readCapabilityOutputRecord(
  data: unknown,
): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const output = (data as { output?: unknown }).output
  return typeof output === 'object' && output !== null
    ? (output as Record<string, unknown>)
    : undefined
}

function readCapabilityVerificationEvidence(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  return Array.isArray(evidence)
    ? evidence.filter((value): value is string => typeof value === 'string')
    : []
}

function readCapabilityRecoveryUsed(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  return (data as { recoveryUsed?: unknown }).recoveryUsed === true
}

function readCapabilityRecoveryPoint(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const recoveryPoint = (data as { recoveryPoint?: unknown }).recoveryPoint
  return typeof recoveryPoint === 'string' && recoveryPoint.trim()
    ? recoveryPoint.trim()
    : undefined
}

function readCapabilityChainStatus(
  data: unknown,
):
  | 'idle'
  | 'running'
  | 'observed'
  | 'captured'
  | 'staged'
  | 'routed'
  | 'delivered'
  | 'verified'
  | 'recovered'
  | 'completed'
  | 'routing_failed'
  | 'environment_unready'
  | 'verified_failed'
  | 'execution_failed'
  | 'blocked'
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const chainState = (data as { chainState?: unknown }).chainState
  if (typeof chainState !== 'object' || chainState === null) {
    return undefined
  }

  const chainStatus = (chainState as { chainStatus?: unknown }).chainStatus
  return typeof chainStatus === 'string'
    ? (chainStatus as
        | 'idle'
        | 'running'
        | 'observed'
        | 'captured'
        | 'staged'
        | 'routed'
        | 'delivered'
        | 'verified'
        | 'recovered'
        | 'completed'
        | 'routing_failed'
        | 'environment_unready'
        | 'verified_failed'
        | 'execution_failed'
        | 'blocked')
    : undefined
}

function readCapabilityLastVerifiedAnchor(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const chainState = (data as { chainState?: unknown }).chainState
  if (typeof chainState !== 'object' || chainState === null) {
    return undefined
  }

  const anchor = (chainState as { lastVerifiedAnchor?: unknown }).lastVerifiedAnchor
  return typeof anchor === 'string' && anchor.trim() ? anchor : undefined
}

function readWorkspaceReadOutput(data: unknown): {
  path: string
  startLine: number
  endLine: number
  lines: string[]
} {
  const output =
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { output?: unknown }).output === 'object' &&
    (data as { output?: unknown }).output !== null
      ? ((data as { output?: unknown }).output as {
          path?: unknown
          startLine?: unknown
          endLine?: unknown
          lines?: unknown
        })
      : (data as {
          path?: unknown
          startLine?: unknown
          endLine?: unknown
          lines?: unknown
        } | null)

  const lines = Array.isArray(output?.lines)
    ? output.lines.map(line => String(line))
    : []
  return {
    path: typeof output?.path === 'string' ? output.path : '',
    startLine:
      typeof output?.startLine === 'number' ? output.startLine : 1,
    endLine:
      typeof output?.endLine === 'number'
        ? output.endLine
        : Math.max(1, lines.length),
    lines,
  }
}

function extractClipboardText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value
  }

  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const candidate = value as { text?: unknown; raw?: unknown }
  if (typeof candidate.text === 'string' && candidate.text.trim()) {
    return candidate.text
  }

  const candidateResult = (value as { result?: unknown }).result
  if (typeof candidateResult === 'string' && candidateResult.trim()) {
    return candidateResult
  }

  if (typeof candidate.raw === 'string' && candidate.raw.trim()) {
    return candidate.raw
  }

  if (typeof candidate.raw === 'object' && candidate.raw !== null) {
    const rawText = (candidate.raw as { text?: unknown }).text
    if (typeof rawText === 'string' && rawText.trim()) {
      return rawText
    }

    const rawResult = (candidate.raw as { result?: unknown }).result
    if (typeof rawResult === 'string' && rawResult.trim()) {
      return rawResult
    }
  }

  return undefined
}

async function collectWindowObservation(
  context: CapabilityExecuteContext,
  windowTitle: string,
): Promise<{
  ok: boolean
  error?: string
  failureClass?: CapabilityFailureClass
  failureReason?: CapabilityFailureReason
  operations: CapabilityOperation[]
  evidence: string[]
  lastVerifiedAnchor?: string
  recoveryPoint?: string
  recoveryAction?: CapabilityRecoveryAction
  observation?: CapabilityObservation
  recoveryUsed: boolean
  chainStatus: 'completed' | 'verified_failed' | 'execution_failed'
}> {
  const focusResult = await executeNestedTool(
    context.runtime,
    context.toolContext,
    'windows.focus_window',
    { windowTitle },
  )
  const operations: CapabilityOperation[] = [
    {
      type: 'tool',
      target: 'windows.focus_window',
      ok: focusResult.ok,
      summary: focusResult.summary,
    },
  ]

  let recoveryUsed = false
  let focusVerified = focusResult.ok
  if (!focusResult.ok) {
    const switchResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'windows.app',
      {
        mode: 'switch',
        name: windowTitle,
      },
    )
    operations.push({
      type: 'tool',
      target: 'windows.app',
      ok: switchResult.ok,
      summary: switchResult.summary,
    })
    recoveryUsed = switchResult.ok
    focusVerified = switchResult.ok

    if (!switchResult.ok) {
      return {
        ok: false,
        error: switchResult.error ?? focusResult.error,
        failureClass:
          switchResult.failureClass ?? focusResult.failureClass ?? 'deterministic',
        failureReason: 'focus_drift',
        operations,
        evidence: [
          `target=${windowTitle}`,
          'focus=failed',
        ],
        recoveryUsed,
        recoveryPoint: `focus:${windowTitle}`,
        recoveryAction: 'recover:refocus',
        chainStatus: 'execution_failed',
      }
    }
  }

  await executeNestedTool(
    context.runtime,
    context.toolContext,
    'windows.wait',
    { durationSeconds: 1 },
  )

  const runObservationAttempt = async (): Promise<{
    observeResult: Awaited<ReturnType<typeof executeNestedTool>>
    observation: DesktopSnapshot | undefined
    evaluation: ReturnType<typeof evaluateDesktopObservation>
    observeVerificationPassed: boolean
    observedChainTarget: string | undefined
    observedAnchor: string | undefined
    observedEvidence: string[]
    targetMatched: boolean
    observationSufficient: boolean
    failureReason: CapabilityFailureReason | undefined
    verificationPassed: boolean
    evidence: string[]
  }> => {
    const observeResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'skill.desktop.observe',
    )
    operations.push({
      type: 'tool',
      target: 'skill.desktop.observe',
      ok: observeResult.ok,
      summary: observeResult.summary,
    })

    const observation = readNestedObservationSnapshot(observeResult.data)
    const evaluation = evaluateDesktopObservation(observation)
    const observeVerificationPassed =
      readCapabilityVerificationPassed(observeResult.data) !== false
    const observedChainTarget = readTemplateChainCurrentTarget(observeResult.data)
    const observedAnchor = readCapabilityLastVerifiedAnchor(observeResult.data)
    const observedEvidence = readCapabilityVerificationEvidence(observeResult.data)
    const targetMatched =
      isWindowVerificationMatch(observation, windowTitle) ||
      observedChainTarget?.trim().toLowerCase() === windowTitle.trim().toLowerCase() ||
      observedAnchor?.trim().toLowerCase().includes(windowTitle.trim().toLowerCase()) ===
        true ||
      observedEvidence.some(item =>
        item.trim().toLowerCase().includes(windowTitle.trim().toLowerCase()),
      )
    const observationSufficient =
      evaluation.sufficient ||
      (observeResult.ok &&
        observeVerificationPassed &&
        Boolean(observedChainTarget || observedAnchor || observedEvidence.length > 0))
    const failureReason: CapabilityFailureReason | undefined = !observeResult.ok
      ? 'observation_insufficient'
      : !observationSufficient
        ? 'observation_insufficient'
        : !targetMatched
          ? 'focus_drift'
          : undefined
    const verificationPassed =
      focusVerified &&
      observeResult.ok &&
      observeVerificationPassed &&
      observationSufficient &&
      targetMatched
    const evidence = dedupeCandidateStrings([
      `target=${windowTitle}`,
      `focus=${focusVerified ? 'confirmed' : 'unconfirmed'}`,
      targetMatched ? 'match=confirmed' : 'match=mismatch',
      ...evaluation.evidence,
      ...observedEvidence,
    ])

    return {
      observeResult,
      observation,
      evaluation,
      observeVerificationPassed,
      observedChainTarget,
      observedAnchor,
      observedEvidence,
      targetMatched,
      observationSufficient,
      failureReason,
      verificationPassed,
      evidence,
    }
  }

  let observationAttempt = await runObservationAttempt()
  if (
    !observationAttempt.verificationPassed &&
    shouldRetryWithFocusRecovery(
      observationAttempt.failureReason === 'focus_drift'
        ? `focus:${windowTitle}`
        : observationAttempt.evaluation.recoveryPoint ?? `focus:${windowTitle}`,
      windowTitle,
    )
  ) {
    const refocusResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'command.app.open_or_focus',
      { appName: windowTitle },
    )
    operations.push({
      type: 'tool',
      target: 'command.app.open_or_focus',
      ok: refocusResult.ok,
      summary: refocusResult.summary,
    })

    if (refocusResult.ok) {
      recoveryUsed = true
      await executeNestedTool(
        context.runtime,
        context.toolContext,
        'windows.wait',
        { durationSeconds: 1 },
      )
      observationAttempt = await runObservationAttempt()
    }
  }

  return {
    ok: observationAttempt.verificationPassed,
    error: observationAttempt.verificationPassed
      ? observationAttempt.observeResult.error
      : observationAttempt.failureReason === 'focus_drift'
        ? 'WINDOW_OBSERVATION_TARGET_MISMATCH'
        : observationAttempt.observeResult.error ?? 'WINDOW_OBSERVATION_INSUFFICIENT',
    failureClass: observationAttempt.verificationPassed
      ? undefined
      : observationAttempt.observeResult.failureClass ?? 'deterministic',
    failureReason: observationAttempt.failureReason,
    operations,
    evidence: observationAttempt.evidence,
    lastVerifiedAnchor:
      observationAttempt.verificationPassed
        ? observationAttempt.observedAnchor ??
          observationAttempt.evaluation.anchor ??
          windowTitle
        : undefined,
    recoveryUsed,
    observation: observationAttempt.evaluation.observation,
    recoveryPoint: observationAttempt.verificationPassed
      ? undefined
      : observationAttempt.failureReason === 'focus_drift'
        ? `focus:${windowTitle}`
        : observationAttempt.evaluation.recoveryPoint ?? `focus:${windowTitle}`,
    recoveryAction: observationAttempt.verificationPassed
      ? undefined
      : observationAttempt.failureReason === 'focus_drift'
        ? 'recover:refocus'
        : observationAttempt.evaluation.recoveryAction ?? 'recover:reobserve',
    chainStatus: observationAttempt.verificationPassed ? 'completed' : 'verified_failed',
  }
}

function extractBrowserTransferText(
  snapshot: DesktopSnapshot | undefined,
): string | undefined {
  if (!snapshot) {
    return undefined
  }

  const candidate = snapshot as unknown as Record<string, unknown>
  const dom =
    typeof candidate.dom === 'object' && candidate.dom !== null
      ? (candidate.dom as Record<string, unknown>)
      : undefined
  const raw =
    typeof snapshot.raw === 'object' && snapshot.raw !== null
      ? (snapshot.raw as Record<string, unknown>)
      : undefined
  const rawDom =
    raw && typeof raw.dom === 'object' && raw.dom !== null
      ? (raw.dom as Record<string, unknown>)
      : undefined

  const candidates = [
    extractRecordString(rawDom, 'selectedText'),
    extractRecordString(dom, 'selectedText'),
    extractRecordString(rawDom, 'text'),
    extractRecordString(dom, 'text'),
    extractRecordString(rawDom, 'innerText'),
    extractRecordString(dom, 'innerText'),
    extractRecordString(rawDom, 'title'),
    extractRecordString(dom, 'title'),
    ...readMeaningfulAnchorCandidates(snapshot),
    snapshot.domSummary,
  ]

  return candidates.find(
    (value): value is string =>
      typeof value === 'string' && isMeaningfulTransferText(value, snapshot),
  )
}

function compareEvidenceSets(
  primaryWindowTitle: string,
  primaryEvidence: string[],
  secondaryWindowTitle: string,
  secondaryEvidence: string[],
): {
  summary: string
  identical: boolean
} {
  const primarySet = new Set(primaryEvidence)
  const secondarySet = new Set(secondaryEvidence)
  const primaryOnly = primaryEvidence.filter(item => !secondarySet.has(item))
  const secondaryOnly = secondaryEvidence.filter(item => !primarySet.has(item))

  if (primaryOnly.length === 0 && secondaryOnly.length === 0) {
    return {
      summary: `comparison=identical evidence for ${primaryWindowTitle} and ${secondaryWindowTitle}`,
      identical: true,
    }
  }

  const parts: string[] = []
  if (primaryOnly.length > 0) {
    parts.push(
      `${primaryWindowTitle}-only=${truncateEvidenceText(primaryOnly.join(' | '))}`,
    )
  }
  if (secondaryOnly.length > 0) {
    parts.push(
      `${secondaryWindowTitle}-only=${truncateEvidenceText(secondaryOnly.join(' | '))}`,
    )
  }

  return {
    summary: `comparison=${parts.join('; ')}`,
    identical: false,
  }
}

function shouldRetryWithFocusRecovery(
  recoveryPoint: string | undefined,
  selectedWindowTitle: string,
): boolean {
  if (!recoveryPoint) {
    return false
  }

  const normalizedRecoveryPoint = recoveryPoint.toLowerCase()
  const normalizedTarget = selectedWindowTitle.trim().toLowerCase()

  return (
    normalizedRecoveryPoint.startsWith('focus:') &&
    normalizedRecoveryPoint.includes(normalizedTarget)
  )
}

function selectWindowRoute(input: {
  primaryWindowTitle: string
  primaryEvidence: string[]
  secondaryWindowTitle: string
  secondaryEvidence: string[]
  routeQuery: string
}): {
  selectedWindowTitle: string
  reason: string
} {
  const primaryScore = scoreWindowRoute(
    input.primaryWindowTitle,
    input.primaryEvidence,
    input.routeQuery,
  )
  const secondaryScore = scoreWindowRoute(
    input.secondaryWindowTitle,
    input.secondaryEvidence,
    input.routeQuery,
  )

  if (secondaryScore > primaryScore) {
    return {
      selectedWindowTitle: input.secondaryWindowTitle,
      reason: `${input.secondaryWindowTitle} matched routeQuery=${input.routeQuery} better (${secondaryScore} > ${primaryScore})`,
    }
  }

  return {
    selectedWindowTitle: input.primaryWindowTitle,
    reason: `${input.primaryWindowTitle} matched routeQuery=${input.routeQuery} best-or-tied (${primaryScore} >= ${secondaryScore})`,
  }
}

function scoreWindowRoute(
  windowTitle: string,
  evidence: string[],
  routeQuery: string,
): number {
  const normalizedQuery = routeQuery.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalizedQuery) {
    return 0
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const fields = [windowTitle, ...evidence].map(field => field.toLowerCase())
  let score = 0

  for (const field of fields) {
    if (field.includes(normalizedQuery)) {
      score += 6
    }

    for (const token of tokens) {
      if (token && field.includes(token)) {
        score += 2
      }
    }
  }

  return score
}

function readMeaningfulAnchorCandidates(snapshot: DesktopSnapshot): string[] {
  const candidates = dedupeCandidateStrings([
    ...(snapshot.anchors ?? []),
    snapshot.windowAnchor,
    snapshot.domAnchor,
    ...snapshot.windows,
    snapshot.focusedWindow,
  ])

  const browserTitleVariants = candidates
    .map(candidate => simplifyBrowserWindowTitle(candidate))
    .filter((candidate): candidate is string => Boolean(candidate))

  return dedupeCandidateStrings([
    ...candidates,
    ...browserTitleVariants,
  ]).filter(anchor => {
    const normalized = anchor.replace(/\s+/g, ' ').trim()
    return normalized.length >= 6 && !blockedGenericAnchor(normalized)
  })
}

function blockedGenericAnchor(value: string): boolean {
  const normalized = value.toLowerCase()
  return (
    normalized === 'codex' ||
    normalized === 'notepad' ||
    normalized === 'microsoft edge' ||
    normalized === 'button' ||
    normalized === 'group'
  )
}

function dedupeCandidateStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = value?.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function simplifyBrowserWindowTitle(value: string): string | undefined {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed) {
    return undefined
  }

  if (!/(edge|chrome|firefox|browser)/i.test(trimmed)) {
    return undefined
  }

  let simplified = trimmed
    .replace(/\s+-\s+(?:microsoft|google).+$/i, '')
    .replace(/\s+-\s+firefox.*$/i, '')
    .replace(/\s+-\s+Microsoft.*$/i, '')
    .replace(/\s+(?:和另外|and)\s+\d+\s+(?:个页面|more pages?)(?:\s*-\s*[^-]+)?$/i, '')
    .replace(/\s+-\s+(?:个人|personal|work|profile\s*\d+)$/i, '')
    .replace(/\s+[-_]\s*browser.*$/i, '')
    .trim()

  if (!simplified || simplified === trimmed) {
    return undefined
  }

  return simplified
}

function buildBackendLaunchScript(appName: string): string | undefined {
  const normalized = appName.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  const knownAppMap: Record<string, string> = {
    notepad: 'notepad.exe',
    calc: 'calc.exe',
    calculator: 'calc.exe',
    mspaint: 'mspaint.exe',
    paint: 'mspaint.exe',
  }

  const executable = knownAppMap[normalized]
  if (!executable) {
    return undefined
  }

  return `Start-Process ${executable}`
}

function isBrowserWindowTitle(value: string | undefined): boolean {
  if (typeof value !== 'string') {
    return false
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 && /(edge|chrome|firefox|browser)/i.test(normalized)
}

async function verifyWindowAvailable(
  context: CapabilityExecuteContext,
  appName: string,
): Promise<boolean> {
  const snapshotResult = await executeNestedTool(
    context.runtime,
    context.toolContext,
    'windows.snapshot',
  )

  if (!snapshotResult.ok) {
    return false
  }

  const observation = await resolveDesktopSnapshotFromToolResult(
    context,
    snapshotResult,
  )
  if (!observation) {
    return false
  }

  const normalizedTarget = appName.trim().toLowerCase()
  const aliases = buildAppNameAliases(normalizedTarget)
  const anchors = [
    observation.windowAnchor,
    observation.domAnchor,
    observation.focusedWindow,
    ...observation.windows,
    ...(observation.anchors ?? []),
  ]

  return anchors.some(anchor =>
    typeof anchor === 'string' &&
    aliases.some(alias => normalizeWindowMatchText(anchor).includes(alias)),
  )
}

function buildAppNameAliases(normalizedAppName: string): string[] {
  const aliases = new Set<string>([normalizedAppName])
  const simplifiedWindowTitle = simplifyBrowserWindowTitle(normalizedAppName)
  if (simplifiedWindowTitle) {
    aliases.add(simplifiedWindowTitle.toLowerCase())
  }

  switch (normalizedAppName) {
    case 'notepad':
      aliases.add('notepad.exe')
      aliases.add('记事本')
      break
    case 'calc':
    case 'calculator':
      aliases.add('calc.exe')
      break
    case 'weixin':
    case 'wechat':
    case '微信':
    case 'wecom':
    case 'wxwork':
    case '企业微信':
    case '文件传输助手':
      aliases.add('weixin')
      aliases.add('wechat')
      aliases.add('微信')
      aliases.add('wecom')
      aliases.add('wxwork')
      aliases.add('企业微信')
      aliases.add('文件传输助手')
      break
    default:
      break
  }

  return [...aliases]
}

function isWindowVerificationMatch(
  snapshot: DesktopSnapshot | undefined,
  targetWindowTitle: string,
): boolean {
  if (!snapshot) {
    return false
  }

  const aliases = buildAppNameAliases(targetWindowTitle.trim().toLowerCase())
  const candidates = [
    snapshot.windowAnchor,
    snapshot.domAnchor,
    snapshot.focusedWindow,
    ...snapshot.windows,
    ...(snapshot.anchors ?? []),
  ]

  return candidates.some(
    candidate =>
      typeof candidate === 'string' &&
      aliases.some(alias => normalizeWindowMatchText(candidate).includes(alias)),
  )
}

function matchesQueryAgainstObservation(
  snapshot: DesktopSnapshot | undefined,
  query: string | undefined,
): boolean {
  if (!query?.trim()) {
    return true
  }

  if (!snapshot) {
    return false
  }

  const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const aliasQueries = buildAppNameAliases(normalizedQuery)
  const tokens = dedupeCandidateStrings(
    aliasQueries.flatMap(alias => alias.split(/\s+/).filter(Boolean)),
  ).map(token => token.toLowerCase())
  const candidates = [
    snapshot.windowAnchor,
    snapshot.domAnchor,
    snapshot.focusedWindow,
    ...snapshot.windows,
    ...(snapshot.anchors ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => normalizeWindowMatchText(value))

  return candidates.some(candidate => {
    if (aliasQueries.some(alias => candidate.includes(alias))) {
      return true
    }

    return tokens.length > 0 && tokens.every(token => candidate.includes(token))
  })
}

function extractRecordString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key]
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : undefined
}

function transformTransferText(
  value: string,
  transform: 'none' | 'trim' | 'uppercase' | 'lowercase' | undefined,
): string {
  switch (transform ?? 'none') {
    case 'trim':
      return value.trim()
    case 'uppercase':
      return value.toUpperCase()
    case 'lowercase':
      return value.toLowerCase()
    default:
      return value
  }
}

function truncateEvidenceText(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
}

function isMeaningfulTransferText(
  value: string,
  snapshot: DesktopSnapshot,
): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return false
  }

  const lowerValue = normalized.toLowerCase()
  const blockedAnchors = new Set(
    [snapshot.focusedWindow, ...snapshot.windows]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim().toLowerCase()),
  )

  if (blockedAnchors.has(lowerValue)) {
    return false
  }

  return normalized.length >= 4
}

function normalizeBrowserAppTarget(targetWindowTitle: string): string {
  const normalized = targetWindowTitle.trim()
  if (/edge/i.test(normalized)) {
    return 'Microsoft Edge'
  }
  if (/chrome/i.test(normalized)) {
    return 'Google Chrome'
  }
  if (/firefox/i.test(normalized)) {
    return 'Mozilla Firefox'
  }
  return normalized
}

function normalizeBrowserWindowTarget(targetWindowTitle: string): string {
  return isBrowserWindowTitle(targetWindowTitle)
    ? normalizeBrowserAppTarget(targetWindowTitle)
    : targetWindowTitle
}

function normalizeWindowMatchText(value: string): string {
  return value.replace(/^\*+\s*/u, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function shouldSubmitWithEnter(targetWindowTitle: string | undefined): boolean {
  if (typeof targetWindowTitle !== 'string') {
    return false
  }

  return /(wechat|weixin|wecom|wxwork|文件传输助手|微信)/i.test(targetWindowTitle)
}

function isWeChatLikeWindowTitle(targetWindowTitle: string | undefined): boolean {
  return shouldSubmitWithEnter(targetWindowTitle)
}

async function tryClickNamedElements(
  context: CapabilityExecuteContext,
  operations: CapabilityOperation[],
  input: {
    names: string[]
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
  },
) {
  let lastResult:
    | Awaited<ReturnType<typeof executeNestedTool>>
    | undefined

  for (const name of input.names) {
    const clickResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'windows.click_element_by_name',
      {
        name,
        windowTitle: input.windowTitle,
        controlType: input.controlType,
        matchMode: input.matchMode ?? 'contains',
      },
    )
    operations.push({
      type: 'tool',
      target: 'windows.click_element_by_name',
      ok: clickResult.ok,
      summary: clickResult.summary,
    })
    if (clickResult.ok) {
      return clickResult
    }
    lastResult = clickResult
  }

  return (
    lastResult ?? {
      ok: false,
      summary: 'No named clickable element candidate succeeded.',
      error: 'WINDOW_ELEMENT_NOT_FOUND',
      failureClass: 'deterministic' as CapabilityFailureClass,
    }
  )
}

async function tryTypeIntoNamedElements(
  context: CapabilityExecuteContext,
  operations: CapabilityOperation[],
  input: {
    names: string[]
    text: string
    windowTitle?: string
    controlType?: string
    matchMode?: 'contains' | 'exact'
    clear?: boolean
    pressEnter?: boolean
  },
) {
  let lastResult:
    | Awaited<ReturnType<typeof executeNestedTool>>
    | undefined

  for (const name of input.names) {
    const typeResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'windows.type_element_by_name',
      {
        name,
        text: input.text,
        windowTitle: input.windowTitle,
        controlType: input.controlType,
        matchMode: input.matchMode ?? 'contains',
        clear: input.clear,
        pressEnter: input.pressEnter,
      },
    )
    operations.push({
      type: 'tool',
      target: 'windows.type_element_by_name',
      ok: typeResult.ok,
      summary: typeResult.summary,
    })
    if (typeResult.ok) {
      return typeResult
    }
    lastResult = typeResult
  }

  return (
    lastResult ?? {
      ok: false,
      summary: 'No named input element candidate succeeded.',
      error: 'WINDOW_ELEMENT_NOT_FOUND',
      failureClass: 'deterministic' as CapabilityFailureClass,
    }
  )
}

async function tryExplorerStyleFileSelection(
  context: CapabilityExecuteContext,
  operations: CapabilityOperation[],
  absolutePath: string,
  fileName: string,
) {
  const parentDirectory = dirname(absolutePath)

  const addressInputResult = await tryTypeIntoNamedElements(context, operations, {
    names: ['地址', 'Address', '地址: 此电脑', '地址: This PC', '地址:'],
    text: parentDirectory,
    clear: true,
    pressEnter: true,
  })
  if (!addressInputResult.ok) {
    const navigatedByTree = await tryExplorerTreePathSelection(
      context,
      operations,
      absolutePath,
      fileName,
    )
    if (navigatedByTree.ok) {
      return navigatedByTree
    }
    return addressInputResult
  }

  await executeNestedTool(context.runtime, context.toolContext, 'windows.wait', {
    durationSeconds: 1,
  })

  const selectFileResult = await tryClickNamedElements(context, operations, {
    names: [fileName],
    matchMode: 'exact',
  })
  if (!selectFileResult.ok) {
    return selectFileResult
  }

  const openSelectedFileResult = await executeNestedTool(
    context.runtime,
    context.toolContext,
    'windows.shortcut',
    { shortcut: 'enter' },
  )
  operations.push({
    type: 'tool',
    target: 'windows.shortcut',
    ok: openSelectedFileResult.ok,
    summary: openSelectedFileResult.summary,
  })
  return openSelectedFileResult.ok ? openSelectedFileResult : selectFileResult
}

async function tryExplorerTreePathSelection(
  context: CapabilityExecuteContext,
  operations: CapabilityOperation[],
  absolutePath: string,
  fileName: string,
) {
  const normalizedPath = absolutePath.replace(/\//g, '\\')
  const match = /^([A-Za-z]):\\(.+)$/.exec(normalizedPath)
  if (!match) {
    return {
      ok: false,
      summary: `Unsupported explorer fallback path: ${absolutePath}`,
      error: 'WINDOW_ELEMENT_NOT_FOUND',
      failureClass: 'deterministic' as CapabilityFailureClass,
    }
  }

  const drive = `${match[1].toUpperCase()} (${match[1].toUpperCase()}:)`
  const segments = match[2].split('\\').filter(Boolean)
  const directorySegments = segments.slice(0, -1)

  const driveResult = await tryClickNamedElements(context, operations, {
    names: [drive],
    controlType: '树项目',
    matchMode: 'exact',
  })
  if (!driveResult.ok) {
    return driveResult
  }

  await executeNestedTool(context.runtime, context.toolContext, 'windows.wait', {
    durationSeconds: 1,
  })

  for (const segment of directorySegments) {
    const segmentResult = await tryClickNamedElements(context, operations, {
      names: [segment],
      matchMode: 'exact',
    })
    if (!segmentResult.ok) {
      return segmentResult
    }
    await executeNestedTool(context.runtime, context.toolContext, 'windows.wait', {
      durationSeconds: 1,
    })
  }

  const fileResult = await tryClickNamedElements(context, operations, {
    names: [fileName],
    matchMode: 'exact',
  })
  if (!fileResult.ok) {
    return fileResult
  }

  const confirmResult = await executeNestedTool(
    context.runtime,
    context.toolContext,
    'windows.shortcut',
    { shortcut: 'enter' },
  )
  operations.push({
    type: 'tool',
    target: 'windows.shortcut',
    ok: confirmResult.ok,
    summary: confirmResult.summary,
  })
  return confirmResult.ok ? confirmResult : fileResult
}

async function tryBrowserFormSubmitRecovery(
  context: CapabilityExecuteContext,
  input: {
    browserWindowTitle: string
    transformedText: string | undefined
    pressEnter: boolean
  },
): Promise<
  | {
      summary: string
      operations: CapabilityOperation[]
      verificationEvidence: string[]
    }
  | undefined
> {
  if (!input.transformedText?.trim()) {
    return undefined
  }

  const candidateNames = ['Message', 'message', 'Input', 'input', 'Reply', 'reply']
  const operations: CapabilityOperation[] = []

  for (const name of candidateNames) {
    const clickResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'skill.browser.click_element_by_name',
      {
        name,
        windowTitle: input.browserWindowTitle,
      },
    )
    operations.push({
      type: 'tool',
      target: 'skill.browser.click_element_by_name',
      ok: clickResult.ok,
      summary: clickResult.summary,
    })
    if (!clickResult.ok) {
      continue
    }

    const transferResult = await executeNestedTool(
      context.runtime,
      context.toolContext,
      'skill.cross_app.transfer_text',
      {
        text: input.transformedText,
        targetWindowTitle: input.browserWindowTitle,
        pressEnter: input.pressEnter,
      },
    )
    operations.push({
      type: 'tool',
      target: 'skill.cross_app.transfer_text',
      ok: transferResult.ok,
      summary: transferResult.summary,
    })

    if (transferResult.ok && readCapabilityVerificationPassed(transferResult.data) !== false) {
      return {
        summary: `Read browser form payload and submitted it into ${input.browserWindowTitle} through a visible browser form field.`,
        operations,
        verificationEvidence: [
          `formField=${name}`,
          'recovery=browser-form-submit',
          ...readCapabilityVerificationEvidence(transferResult.data),
        ],
      }
    }
  }

  return undefined
}
