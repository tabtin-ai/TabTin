import { existsSync } from 'fs'
import { resolve } from 'path'
import { config as dotenvConfig } from 'dotenv'
import fixPath from 'fix-path'
import { applyRuntimeAppIdentity } from './app-identity'
import { initSentryMain } from './sentry'
import { createLogger } from './logger'

const log = createLogger('main')

/**
 * 修复 Electron 主进程 `process.env.PATH`。
 *
 * **为什么必要**：macOS 上通过 Finder / Dock / LaunchServices 启动的 Electron app
 * 拿到的 PATH 是系统精简版 `/usr/bin:/bin:/usr/sbin:/sbin`，**不包含**
 * `/opt/homebrew/bin`、`~/.nvm/.../bin`、`~/.cargo/bin` 等用户在 shell rc 里
 * 配置的路径。这会导致：
 *   - tabcode `grep_search` 失败（rg 装在 /opt/homebrew/bin/rg）
 *   - `run_terminal_command` 调用户安装的 cli（pnpm / python3 / uv / cargo /
 *     gh / brew）一律 "command not found"
 *   - dev 模式下因为继承了启动 shell 的 PATH 不暴露问题，packaged production
 *     才崩——属于"上线才坏"的隐蔽 bug
 *
 * `fix-path` 通过 `shell-path` 跑用户默认 shell（`zsh -ilc 'echo $PATH'`）
 * 拿真实 PATH 注入到 `process.env.PATH`。VSCode / Slack / Atom / Hyper 标准
 * 防御。Windows 直接 no-op。
 *
 * 必须在任何 child_process spawn / `await import('./main-app')` 之前调。
 *
 * 同时也在 dev 模式下生效 —— dev 时 PATH 已完整，调 fix-path 几乎是 noop，
 * 但保证 dev 与 packaged 行为一致，避免"dev 测不出 packaged 才坏"。
 */
const fixMainProcessPath = () => {
  const before = process.env.PATH || ''
  try {
    fixPath()
    const after = process.env.PATH || ''
    if (before !== after) {
      log.info('fix-path: PATH 已从用户 shell 注入')
    }
  } catch (error) {
    log.warn('fix-path 失败（保留原 PATH）:', error)
  }
}

const installMainLogFilter = () => {
  const raw = process.env.TABTIN_LOG_FILTER || ''
  const tokens = raw.split('|').map(item => item.trim()).filter(Boolean)
  if (tokens.length === 0) {
    return
  }

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug?.bind(console) ?? console.log.bind(console),
  }

  const matchTokens = (args: unknown[]): boolean => {
    return args.some((arg) => {
      let text = ''
      if (typeof arg === 'string') {
        text = arg
      } else {
        try {
          text = JSON.stringify(arg)
        } catch {
          text = String(arg)
        }
      }
      return tokens.some(token => text.includes(token))
    })
  }

  const wrap = (method: 'log' | 'info' | 'debug') => {
    return (...args: unknown[]) => {
      if (matchTokens(args)) {
        original[method](...args)
      }
    }
  }

  console.log = wrap('log')
  console.info = wrap('info')
  console.debug = wrap('debug')
}

const appIdentity = applyRuntimeAppIdentity()

const loadRootEnvironment = () => {
  const projectRoot = resolve(import.meta.dirname, '../../../../')
  const rootEnvPath = resolve(projectRoot, '.env')
  const rootLocalEnvPath = resolve(projectRoot, '.env.local')
  const rootPackagePath = resolve(projectRoot, 'package.json')

  if (!process.env.TABTIN_WORKSPACE_ROOT && existsSync(rootPackagePath)) {
    process.env.TABTIN_WORKSPACE_ROOT = projectRoot
    log.info('已设置 TABTIN_WORKSPACE_ROOT:', projectRoot)
  }

  const envPaths = [rootEnvPath, rootLocalEnvPath].filter(path => existsSync(path))
  if (envPaths.length === 0) {
    log.warn('未找到 .env 文件:', rootEnvPath)
    return
  }

  // dotenv 默认不覆盖已有环境变量（override: false），避免覆盖 shell / electron-vite 已注入值。
  // 支持带引号的值、多行值和 \n 转义。
  let lastLoadedEnvPath: string | null = null
  for (const envPath of envPaths) {
    const result = dotenvConfig({ path: envPath, override: false })
    if (result.error) {
      log.warn('加载 .env 文件失败:', result.error)
      continue
    }
    lastLoadedEnvPath = envPath
  }

  if (lastLoadedEnvPath) {
    log.info('已加载环境变量，最后读取文件:', lastLoadedEnvPath)
  }
}

fixMainProcessPath()
installMainLogFilter()
log.info(
  `app identity: profile=${appIdentity.profile}, appId=${appIdentity.appId}, productName=${appIdentity.productName}`,
)
loadRootEnvironment()

// Sentry 错误上报：DSN 未配置时 no-op。必须**同步**初始化——
// SDK 要求在 app 'ready' 前完成，且要抢在 main-app（deep-link.ts 注册
// tabtin-file scheme）之前注册 sentry-ipc scheme，动态 import 无法保证这
// 两个先后关系（详见 ./sentry 模块头注释）。内部自 try/catch，不会阻塞启动。
initSentryMain()

void import('./main-app').catch((error) => {
  log.error('主进程运行时启动失败:', error)
  process.exit(1)
})
