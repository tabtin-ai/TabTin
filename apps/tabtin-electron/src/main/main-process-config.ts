import { app } from 'electron'
import { join } from 'path'

import {
  installGlobalWindowRecoveryHooks,
  type MainWindowLogger,
} from './main-window'
import { resolveDevCdpPortWithMeta } from './dev-cdp-port'
import { STEALTH_ARGS } from '@tabtin/anti-detect'

export interface MainProcessConfigLogger extends MainWindowLogger {}

export interface ConfigureMainProcessOptions {
  isDev: boolean
  log: MainProcessConfigLogger
  cdpPort?: number
}

/**
 * Electron 不适用的 Chromium flags。
 *
 * 这些参数在 Daemon 端（headless 纯 Agent/采集）完全合理，
 * 但 Electron 端有用户 UI，不应该全局生效。
 *
 * - `--test-type`：影响 crash-reporter 和 dialog
 * - `--mute-audio`：全局静音，用户看视频没声音
 * - `--hide-scrollbars`：用户浏览时看不到滚动条
 * - `--lang` / `--accept-lang`：强制英文，中文用户网站返回英文版
 * - `--disable-threaded-animation/scrolling`：滚动/动画卡顿
 * - `--start-maximized`：对 Electron 嵌入式 WebContentsView 无意义
 * - `--disable-logging`：与基础配置重复
 * - `--ignore-gpu-blocklist`：与基础配置重复
 */
const ELECTRON_EXCLUDED_FLAGS: string[] = [
  '--test-type',
  '--mute-audio',
  '--hide-scrollbars',
  '--lang',
  '--accept-lang',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--start-maximized',
  '--disable-logging',
  '--ignore-gpu-blocklist',
]

/**
 * 将 STEALTH_ARGS 拆分为 simple switches 和 key=value 对，
 * 并把 `--enable-features` / `--disable-features` 这类需要合并的 flag 单独提取。
 */
function parseStealthArgs(args: string[]): {
  simple: string[]
  enableFeatures: string[]
  disableFeatures: string[]
} {
  const simple: string[] = []
  const enableFeatures: string[] = []
  const disableFeatures: string[] = []

  for (const arg of args) {
    if (ELECTRON_EXCLUDED_FLAGS.includes(arg.split('=')[0])) continue

    if (arg.startsWith('--enable-features=')) {
      enableFeatures.push(...arg.replace('--enable-features=', '').split(','))
    } else if (arg.startsWith('--disable-features=')) {
      disableFeatures.push(...arg.replace('--disable-features=', '').split(','))
    } else {
      simple.push(arg)
    }
  }

  return { simple, enableFeatures, disableFeatures }
}

export function configureMainProcess(options: ConfigureMainProcessOptions): void {
  const chromiumLogFile = join(app.getPath('userData'), 'chromium.log')
  let cdpPort = options.cdpPort
  let cdpFallbackUsed = false
  if (options.isDev && cdpPort === undefined) {
    const resolved = resolveDevCdpPortWithMeta()
    cdpPort = resolved.port
    cdpFallbackUsed = resolved.fallbackUsed
  }

  // --- 基础 Chromium 配置 ---
  app.commandLine.appendSwitch('log-file', chromiumLogFile)
  app.commandLine.appendSwitch('disable-logging')
  app.commandLine.appendSwitch('log-level', '3')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')

  // --- Stealth flags（共享 @tabtin/anti-detect 配置） ---
  const { simple, enableFeatures, disableFeatures } = parseStealthArgs(STEALTH_ARGS)

  for (const flag of simple) {
    const eqIdx = flag.indexOf('=')
    if (eqIdx > 0) {
      const key = flag.slice(2, eqIdx)   // strip leading '--'
      const value = flag.slice(eqIdx + 1)
      app.commandLine.appendSwitch(key, value)
    } else {
      app.commandLine.appendSwitch(flag.replace(/^--/, ''))
    }
  }

  // 合并 enable-features：基础 + stealth
  const mergedEnableFeatures = ['VaapiVideoDecoder', ...enableFeatures]
  app.commandLine.appendSwitch('enable-features', mergedEnableFeatures.join(','))

  // 合并 disable-features：基础 + stealth
  const mergedDisableFeatures = ['UseChromeOSDirectVideoDecoder', ...disableFeatures]
  app.commandLine.appendSwitch('disable-features', mergedDisableFeatures.join(','))

  if (options.isDev && cdpPort !== undefined) {
    app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    if (cdpFallbackUsed) {
      options.log.warn(
        `CDP 默认端口已被占用，dev 已改用 127.0.0.1:${cdpPort}；` +
          `探针请读 DevToolsActivePort 或设置 TABTIN_CDP_PORT=${cdpPort}`,
      )
    }
    options.log.info(`CDP 调试端口已启用: 127.0.0.1:${cdpPort}`)
    process.env.TABTIN_CDP_ACTIVE_PORT = String(cdpPort)
  }

  if (options.isDev) {
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
  }

  installGlobalWindowRecoveryHooks(options.log)
}
