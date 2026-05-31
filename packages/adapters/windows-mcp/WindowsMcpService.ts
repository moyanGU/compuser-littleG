import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_WINDOWS_MCP_ENDPOINT,
  DEFAULT_WINDOWS_MCP_HOST,
  DEFAULT_WINDOWS_MCP_PORT,
} from './WindowsMcpDefaults.js'
import {
  WindowsMcpLauncher,
  type WindowsMcpLaunchedServer,
  type WindowsMcpLauncherOptions,
} from './WindowsMcpLauncher.js'
import {
  probeWindowsMcpEndpoint,
  type WindowsMcpEndpointProbeResult,
} from './WindowsMcpEndpointProbe.js'

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000

export type WindowsMcpServiceState =
  | 'disconnected'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'failed'

export interface WindowsMcpServiceConfig {
  transport: 'streamable-http'
  endpointUrl: string
  host: string
  port: number
  repoPath?: string
  command?: string
  args?: string[]
  cwd?: string
  startupTimeoutMs?: number
}

export interface WindowsMcpServiceStatus {
  state: WindowsMcpServiceState
  endpointUrl: string
  transport: 'streamable-http'
  host: string
  port: number
  detail: string
  checkedAt: string
  configPath: string
  launchedByService: boolean
  reusedExistingEndpoint: boolean
  pid?: number
  lastError?: string
}

export interface WindowsMcpServiceOptions
  extends Partial<Omit<WindowsMcpServiceConfig, 'transport'>> {
  configPath: string
  fetchImpl?: typeof fetch
  launcherFactory?: (
    options: WindowsMcpLauncherOptions,
  ) => Pick<WindowsMcpLauncher, 'start'>
  onStatusChange?: (status: WindowsMcpServiceStatus) => void
}

export interface WindowsMcpEnsureReadyOptions {
  launchIfNeeded?: boolean
}

type PersistedWindowsMcpServiceConfig = Partial<WindowsMcpServiceConfig> & {
  updatedAt?: string
}

export class WindowsMcpService {
  private readonly configPath: string
  private readonly fetchImpl: typeof fetch
  private readonly launcherFactory: NonNullable<
    WindowsMcpServiceOptions['launcherFactory']
  >
  private readonly listeners = new Set<(status: WindowsMcpServiceStatus) => void>()
  private readonly explicitConfig: Partial<Omit<WindowsMcpServiceConfig, 'transport'>>
  private ownedServer?: WindowsMcpLaunchedServer
  private status: WindowsMcpServiceStatus

  constructor(options: WindowsMcpServiceOptions) {
    this.configPath = options.configPath
    this.fetchImpl = options.fetchImpl ?? fetch
    this.launcherFactory =
      options.launcherFactory ??
      (launcherOptions => new WindowsMcpLauncher(launcherOptions))
    this.explicitConfig = {
      endpointUrl: options.endpointUrl,
      host: options.host,
      port: options.port,
      repoPath: options.repoPath,
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      startupTimeoutMs: options.startupTimeoutMs,
    }
    const initialConfig = resolveEffectiveConfig(this.explicitConfig, undefined)
    const checkedAt = new Date().toISOString()
    this.status = {
      state: 'disconnected',
      endpointUrl: initialConfig.endpointUrl,
      transport: initialConfig.transport,
      host: initialConfig.host,
      port: initialConfig.port,
      detail: 'Windows-MCP service not connected.',
      checkedAt,
      configPath: this.configPath,
      launchedByService: false,
      reusedExistingEndpoint: false,
    }

    if (options.onStatusChange) {
      this.listeners.add(options.onStatusChange)
    }
  }

  getStatus(): WindowsMcpServiceStatus {
    return { ...this.status }
  }

  subscribe(listener: (status: WindowsMcpServiceStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async loadConfig(): Promise<WindowsMcpServiceConfig> {
    const persisted = await readPersistedConfig(this.configPath)
    return resolveEffectiveConfig(this.explicitConfig, persisted)
  }

  async saveConfig(
    overrides: Partial<Omit<WindowsMcpServiceConfig, 'transport'>> = {},
  ): Promise<WindowsMcpServiceConfig> {
    const persisted = await readPersistedConfig(this.configPath)
    const config = resolveEffectiveConfig(
      {
        ...this.explicitConfig,
        ...overrides,
      },
      persisted,
    )

    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(
      this.configPath,
      JSON.stringify(
        {
          ...config,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    )

    return config
  }

  async healthcheck(): Promise<WindowsMcpServiceStatus> {
    const config = await this.loadConfig()
    const probe = await probeWindowsMcpEndpoint(config.endpointUrl, this.fetchImpl)
    return this.updateStatus(
      this.buildStatusFromProbe(
        config,
        probe,
        this.status.launchedByService,
        this.ownedServer?.process.pid ?? undefined,
      ),
    )
  }

  async ensureReady(
    options: WindowsMcpEnsureReadyOptions = {},
  ): Promise<WindowsMcpServiceStatus> {
    const config = await this.saveConfig()
    const status = await this.healthcheck()

    if (status.state === 'ready') {
      return status
    }

    if (options.launchIfNeeded !== true) {
      return status
    }

    return this.startWithConfig(config)
  }

  async restart(): Promise<WindowsMcpServiceStatus> {
    const config = await this.saveConfig()
    await this.stopOwnedServer()
    return this.startWithConfig(config)
  }

  async dispose(): Promise<void> {
    await this.stopOwnedServer()
    const config = await this.loadConfig()
    this.updateStatus({
      ...this.status,
      state: 'disconnected',
      endpointUrl: config.endpointUrl,
      transport: config.transport,
      host: config.host,
      port: config.port,
      detail: 'Windows-MCP service stopped by owner.',
      checkedAt: new Date().toISOString(),
      launchedByService: false,
      reusedExistingEndpoint: false,
      pid: undefined,
      lastError: undefined,
    })
  }

  private async startWithConfig(
    config: WindowsMcpServiceConfig,
  ): Promise<WindowsMcpServiceStatus> {
    this.updateStatus({
      ...this.status,
      state: 'starting',
      endpointUrl: config.endpointUrl,
      transport: config.transport,
      host: config.host,
      port: config.port,
      detail: `Starting Windows-MCP on ${config.endpointUrl}.`,
      checkedAt: new Date().toISOString(),
      launchedByService: true,
      reusedExistingEndpoint: false,
      pid: undefined,
      lastError: undefined,
    })

    try {
      const launched = await this.launcherFactory({
        endpointUrl: config.endpointUrl,
        repoPath: config.repoPath,
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        startupTimeoutMs: config.startupTimeoutMs,
        host: config.host,
        port: config.port,
      }).start()

      this.ownedServer = launched
      const probe = await probeWindowsMcpEndpoint(
        config.endpointUrl,
        this.fetchImpl,
      )

      return this.updateStatus(
        this.buildStatusFromProbe(config, probe, true, launched.process.pid ?? undefined),
      )
    } catch (error) {
      return this.updateStatus({
        state: 'failed',
        endpointUrl: config.endpointUrl,
        transport: config.transport,
        host: config.host,
        port: config.port,
        detail: `Windows-MCP failed to start: ${stringifyError(error)}`,
        checkedAt: new Date().toISOString(),
        configPath: this.configPath,
        launchedByService: false,
        reusedExistingEndpoint: false,
        lastError: stringifyError(error),
      })
    }
  }

  private buildStatusFromProbe(
    config: WindowsMcpServiceConfig,
    probe: WindowsMcpEndpointProbeResult,
    launchedByService: boolean,
    pid?: number,
  ): WindowsMcpServiceStatus {
    if (probe.ready) {
      return {
        state: 'ready',
        endpointUrl: config.endpointUrl,
        transport: config.transport,
        host: config.host,
        port: config.port,
        detail: probe.detail,
        checkedAt: probe.checkedAt,
        configPath: this.configPath,
        launchedByService,
        reusedExistingEndpoint: !launchedByService,
        pid,
      }
    }

    if (probe.reachable) {
      return {
        state: 'degraded',
        endpointUrl: config.endpointUrl,
        transport: config.transport,
        host: config.host,
        port: config.port,
        detail: probe.detail,
        checkedAt: probe.checkedAt,
        configPath: this.configPath,
        launchedByService,
        reusedExistingEndpoint: false,
        pid,
        lastError: probe.error ?? probe.detail,
      }
    }

    return {
      state: 'disconnected',
      endpointUrl: config.endpointUrl,
      transport: config.transport,
      host: config.host,
      port: config.port,
      detail: probe.detail,
      checkedAt: probe.checkedAt,
      configPath: this.configPath,
      launchedByService: false,
      reusedExistingEndpoint: false,
      lastError: probe.error ?? probe.detail,
    }
  }

  private updateStatus(status: WindowsMcpServiceStatus): WindowsMcpServiceStatus {
    this.status = status
    for (const listener of this.listeners) {
      listener({ ...status })
    }
    return { ...status }
  }

  private async stopOwnedServer(): Promise<void> {
    if (!this.ownedServer) {
      return
    }

    const ownedServer = this.ownedServer
    this.ownedServer = undefined
    await ownedServer.stop()
  }
}

function resolveEffectiveConfig(
  explicit: Partial<Omit<WindowsMcpServiceConfig, 'transport'>>,
  persisted: PersistedWindowsMcpServiceConfig | undefined,
): WindowsMcpServiceConfig {
  const endpointCandidate = explicit.endpointUrl ?? persisted?.endpointUrl
  const derivedEndpointParts = endpointCandidate
    ? parseEndpointUrl(endpointCandidate)
    : undefined
  const host =
    explicit.host ??
    derivedEndpointParts?.host ??
    persisted?.host ??
    DEFAULT_WINDOWS_MCP_HOST
  const port =
    explicit.port ??
    derivedEndpointParts?.port ??
    persisted?.port ??
    DEFAULT_WINDOWS_MCP_PORT

  return {
    transport: 'streamable-http',
    endpointUrl: endpointCandidate ?? buildEndpointUrl(host, port),
    host,
    port,
    repoPath: explicit.repoPath ?? persisted?.repoPath,
    command: explicit.command ?? persisted?.command,
    args: explicit.args ?? persisted?.args,
    cwd: explicit.cwd ?? persisted?.cwd,
    startupTimeoutMs:
      explicit.startupTimeoutMs ??
      persisted?.startupTimeoutMs ??
      DEFAULT_STARTUP_TIMEOUT_MS,
  }
}

function buildEndpointUrl(host: string, port: number): string {
  if (
    host === DEFAULT_WINDOWS_MCP_HOST &&
    port === DEFAULT_WINDOWS_MCP_PORT
  ) {
    return DEFAULT_WINDOWS_MCP_ENDPOINT
  }

  return `http://${host}:${String(port)}/mcp`
}

function parseEndpointUrl(
  endpointUrl: string,
): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(endpointUrl)
    const port = parsed.port ? Number(parsed.port) : 80
    if (Number.isNaN(port)) {
      return undefined
    }

    return {
      host: parsed.hostname,
      port,
    }
  } catch {
    return undefined
  }
}

async function readPersistedConfig(
  configPath: string,
): Promise<PersistedWindowsMcpServiceConfig | undefined> {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedWindowsMcpServiceConfig
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }

    throw error
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
