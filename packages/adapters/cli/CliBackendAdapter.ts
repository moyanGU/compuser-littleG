import { spawn } from 'node:child_process'

export interface CliBackendScriptOptions {
  cwd?: string
  timeoutMs?: number
}

export interface CliBackendScriptResult {
  ok: boolean
  commandLine: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  summary: string
}

export interface CliBackendAdapter {
  runPowerShell(
    script: string,
    options?: CliBackendScriptOptions,
  ): Promise<CliBackendScriptResult>
}

export class PowerShellCliBackendAdapter implements CliBackendAdapter {
  async runPowerShell(
    script: string,
    options: CliBackendScriptOptions = {},
  ): Promise<CliBackendScriptResult> {
    const timeoutMs = options.timeoutMs ?? 15_000
    const candidateExecutables = [
      process.env.COMPUSER_CLI_POWERSHELL_PATH,
      'powershell.exe',
      'powershell',
      'pwsh.exe',
      'pwsh',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ].filter((value): value is string => Boolean(value))

    let lastError: unknown
    for (const executable of candidateExecutables) {
      try {
        return await runPowerShellProcess(executable, script, options, timeoutMs)
      } catch (error) {
        lastError = error
        if (!isCommandNotFoundError(error)) {
          throw error
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('找不到可用的 PowerShell 可执行文件。')
  }
}

async function runPowerShellProcess(
  executable: string,
  script: string,
  options: CliBackendScriptOptions,
  timeoutMs: number,
): Promise<CliBackendScriptResult> {
  const commandLine = [
    executable,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ].join(' ')

  return await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })

    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })

    child.once('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(error)
    })

    child.once('close', exitCode => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)

      const trimmedStdout = stdout.trim()
      const trimmedStderr = stderr.trim()
      const ok = !timedOut && exitCode === 0
      const summarySource = ok
        ? trimmedStdout || 'PowerShell 脚本执行成功。'
        : trimmedStderr || trimmedStdout || 'PowerShell 脚本执行失败。'

      resolve({
        ok,
        commandLine,
        exitCode,
        stdout,
        stderr,
        timedOut,
        summary: summarySource.slice(0, 240),
      })
    })
  })
}

function isCommandNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: unknown }).code === 'ENOENT'
  )
}
