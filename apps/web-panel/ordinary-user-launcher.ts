import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  CLI_WORKSPACE_ROOT,
  getDefaultWindowsMcpServiceConfigPath,
} from '../cli/workspaceRoot.js'
import { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js'
import { PANEL_DEFAULT_PORT, PANEL_DEFAULT_SESSION_ID } from './defaults.js'

const PANEL_URL = `http://127.0.0.1:${PANEL_DEFAULT_PORT}`
const PANEL_STATE_URL = `${PANEL_URL}/session/${PANEL_DEFAULT_SESSION_ID}/state`
const CHECKLIST_PATH = resolve(CLI_WORKSPACE_ROOT, 'docs', '普通用户实机测试清单.md')
const execFile = promisify(execFileCallback)

type PanelServerChild = ChildProcessByStdio<null, Readable, Readable>

async function main(): Promise<void> {
  console.log('compuser 启动器：正在准备桌面服务和任务面板。')
  console.log('请先不要关闭这个窗口。关闭后，面板服务也会停止。')

  await mkdir(resolve(CLI_WORKSPACE_ROOT, 'memory'), { recursive: true })

  const windowsMcpService = new WindowsMcpService({
    configPath: getDefaultWindowsMcpServiceConfigPath(),
    endpointUrl: process.env.COMPUSER_WINDOWS_MCP_ENDPOINT,
  })

  let launchedPanelChild: PanelServerChild | undefined
  let cleanupStarted = false

  const cleanup = async () => {
    if (cleanupStarted) {
      return
    }
    cleanupStarted = true

    if (launchedPanelChild && launchedPanelChild.exitCode === null && !launchedPanelChild.killed) {
      launchedPanelChild.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolveExit => {
          launchedPanelChild?.once('exit', () => resolveExit())
        }),
        delay(1500).then(() => undefined),
      ])

      if (launchedPanelChild.exitCode === null && !launchedPanelChild.killed) {
        launchedPanelChild.kill('SIGKILL')
      }
    }

    await windowsMcpService.dispose()
  }

  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143))
  })

  const windowsStatus = await windowsMcpService.ensureReady({ launchIfNeeded: true })
  if (windowsStatus.state === 'ready') {
    console.log(`桌面服务已就绪：${windowsStatus.endpointUrl}`)
  } else {
    console.log(`桌面服务当前状态：${windowsStatus.state}`)
    console.log(`说明：${windowsStatus.detail}`)
    console.log('面板仍会打开；如果状态不对，可在面板里点“重启桌面服务”。')
  }

  if (await isPanelReady()) {
    console.log(`检测到旧的任务面板，先重启：${PANEL_URL}`)
    const stoppedExistingPanel = await stopExistingPanelProcess()
    if (!stoppedExistingPanel) {
      throw new Error(`任务面板已在运行但无法自动重启，请手动关闭后再试：${PANEL_URL}`)
    }
    await waitForPanelToStop()
  }

  const panelChild = spawn(
    process.execPath,
    [
      'dist/apps/web-panel/server.js',
      '--port',
      String(PANEL_DEFAULT_PORT),
      '--permission-mode',
      process.env.COMPUSER_PERMISSION_MODE ?? 'default',
      '--windows-mcp-endpoint',
      windowsStatus.endpointUrl,
    ],
    {
      cwd: CLI_WORKSPACE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  )
  launchedPanelChild = panelChild

  panelChild.stdout.on('data', chunk => {
    process.stdout.write(String(chunk))
  })
  panelChild.stderr.on('data', chunk => {
    process.stderr.write(String(chunk))
  })

  await waitForPanelReady(panelChild)

  console.log(`任务面板已打开：${PANEL_URL}`)
  console.log(`测试清单：${CHECKLIST_PATH}`)
  console.log('如果运行中发现明显跑偏，直接按 Esc 或点“紧急中止 (Esc)”。')
  openBrowser(PANEL_URL)
  console.log(`如果浏览器没有自动打开，请手动访问：${PANEL_URL}`)

  const exitCode = await new Promise<number>(resolveExit => {
    panelChild.once('exit', code => resolveExit(code ?? 0))
  })

  await cleanup()
  process.exit(exitCode)
}

async function isPanelReady(): Promise<boolean> {
  try {
    const response = await fetch(PANEL_STATE_URL)
    return response.ok
  } catch {
    return false
  }
}

async function waitForPanelReady(child: PanelServerChild): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`任务面板提前退出，exitCode=${String(child.exitCode)}`)
    }

    if (await isPanelReady()) {
      return
    }

    await delay(300)
  }

  throw new Error('任务面板启动超时，请检查终端输出。')
}

async function waitForPanelToStop(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await isPanelReady())) {
      return
    }

    await delay(200)
  }

  throw new Error(`旧的任务面板在 ${PANEL_URL} 仍未停止`)
}

async function stopExistingPanelProcess(): Promise<boolean> {
  const script = [
    '$processes = Get-CimInstance Win32_Process | Where-Object {',
    "  $_.Name -eq 'node.exe' -and",
    "  $_.CommandLine -like '*dist/apps/web-panel/server.js*' -and",
    `  $_.CommandLine -like '*--port ${String(PANEL_DEFAULT_PORT)}*'`,
    '}',
    'if (-not $processes) {',
    '  Write-Output "not_found"',
    '  exit 0',
    '}',
    '$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    'Write-Output "stopped"',
  ].join('\n')

  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ])
    return stdout.includes('stopped') || stdout.includes('not_found')
  } catch {
    return false
  }
}

function openBrowser(url: string): void {
  const child = spawn('cmd', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
