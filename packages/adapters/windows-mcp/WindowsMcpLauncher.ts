import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  DEFAULT_WINDOWS_MCP_HOST,
  DEFAULT_WINDOWS_MCP_PORT,
} from './WindowsMcpDefaults.js'
import { probeWindowsMcpEndpoint } from './WindowsMcpEndpointProbe.js'

type LaunchCandidate = {
  command: string
  args: string[]
  cwd?: string
}

export interface WindowsMcpLauncherOptions {
  endpointUrl: string
  repoPath?: string
  command?: string
  args?: string[]
  cwd?: string
  startupTimeoutMs?: number
  host?: string
  port?: number
}

export interface WindowsMcpLaunchedServer {
  endpointUrl: string
  process: ChildProcessWithoutNullStreams
  stop(): Promise<void>
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000
const DEFAULT_WINDOWS_MCP_CACHE_EXE =
  'C:\\Users\\Gu haipeng\\AppData\\Local\\uv\\cache\\archive-v0\\hrHl0gouWvZzYQMMVRcQW\\Scripts\\windows-mcp.exe'
const DEFAULT_WINDOWS_MCP_LOCAL_BIN_EXE = join(
  homedir(),
  '.local',
  'bin',
  'windows-mcp.exe',
)

export function buildDefaultWindowsMcpServeArgs(
  host: string = DEFAULT_WINDOWS_MCP_HOST,
  port: number = DEFAULT_WINDOWS_MCP_PORT,
): string[] {
  return [
    'windows-mcp',
    'serve',
    '--transport',
    'streamable-http',
    '--host',
    host,
    '--port',
    String(port),
  ]
}

export class WindowsMcpLauncher {
  constructor(private readonly options: WindowsMcpLauncherOptions) {}

  async start(): Promise<WindowsMcpLaunchedServer> {
    const candidates = this.buildCandidates()
    const errors: string[] = []

    for (const candidate of candidates) {
      try {
        const child = spawn(candidate.command, candidate.args, {
          cwd: candidate.cwd,
          stdio: 'pipe',
          windowsHide: true,
        })

        const stderrLines: string[] = []
        child.stderr.on('data', chunk => {
          stderrLines.push(String(chunk))
        })

        const startError = await this.waitForProcessOrError(child)
        if (startError) {
          errors.push(
            `Command failed to start: ${candidate.command} ${candidate.args.join(' ')} -> ${startError}`,
          )
          continue
        }

        try {
          await this.waitForReady()
          return {
            endpointUrl: this.options.endpointUrl,
            process: child,
            stop: async () => {
              await this.stopChild(child)
            },
          }
        } catch (error) {
          await this.stopChild(child)
          errors.push(
            `Service did not become ready: ${candidate.command} ${candidate.args.join(' ')} -> ${this.stringifyError(error)}\n${stderrLines.join('')}`.trim(),
          )
        }
      } catch (error) {
        errors.push(
          `Command raised an exception: ${candidate.command} ${candidate.args.join(' ')} -> ${this.stringifyError(error)}`,
        )
      }
    }

    throw new Error(
      `Windows-MCP failed to start. Tried these command candidates:\n${errors.join('\n\n')}`,
    )
  }

  private buildCandidates(): LaunchCandidate[] {
    if (this.options.command) {
      return [
        {
          command: this.options.command,
          args: this.options.args ?? [],
          cwd: this.options.cwd,
        },
      ]
    }

    const host = this.options.host ?? DEFAULT_WINDOWS_MCP_HOST
    const port = this.options.port ?? DEFAULT_WINDOWS_MCP_PORT
    const commonArgs = buildDefaultWindowsMcpServeArgs(host, port)

    const candidates: LaunchCandidate[] = []

    if (existsSync(DEFAULT_WINDOWS_MCP_CACHE_EXE)) {
      candidates.push({
        command: DEFAULT_WINDOWS_MCP_CACHE_EXE,
        args: commonArgs.slice(1),
        cwd: this.options.cwd,
      })
    }

    if (existsSync(DEFAULT_WINDOWS_MCP_LOCAL_BIN_EXE)) {
      candidates.push({
        command: DEFAULT_WINDOWS_MCP_LOCAL_BIN_EXE,
        args: commonArgs.slice(1),
        cwd: this.options.cwd,
      })
    }

    candidates.push({
      command: 'uvx',
      args: commonArgs,
      cwd: this.options.cwd,
    })

    if (this.options.repoPath) {
      candidates.push({
        command: 'uv',
        args: [
          '--directory',
          this.options.repoPath,
          'run',
          ...commonArgs,
        ],
        cwd: this.options.cwd,
      })
    }

    return candidates
  }

  private async waitForProcessOrError(
    child: ChildProcessWithoutNullStreams,
  ): Promise<string | null> {
    return await new Promise(resolve => {
      let settled = false

      const cleanup = () => {
        child.off('error', onError)
        child.off('exit', onExit)
      }

      const onError = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(error.message)
      }

      const onExit = (code: number | null) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(`Process exited early, exitCode=${String(code)}`)
      }

      child.once('error', onError)
      child.once('exit', onExit)

      void sleep(500).then(() => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(null)
      })
    })
  }

  private async waitForReady(): Promise<void> {
    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    let lastError: unknown

    while (Date.now() < deadline) {
      const probe = await probeWindowsMcpEndpoint(this.options.endpointUrl)
      if (probe.ready) {
        return
      }

      lastError = new Error(probe.detail)
      await sleep(500)
    }

    throw new Error(
      `Timed out waiting for Windows-MCP readiness (${timeoutMs}ms): ${this.stringifyError(lastError)}`,
    )
  }

  private async stopChild(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (child.killed || child.exitCode !== null) {
      return
    }

    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>(resolve => {
        child.once('exit', () => resolve(true))
      }),
      sleep(1000).then(() => false),
    ])

    if (!exited && !child.killed && child.exitCode === null) {
      child.kill('SIGKILL')
    }
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return String(error)
  }
}
