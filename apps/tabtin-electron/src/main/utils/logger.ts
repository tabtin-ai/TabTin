/**
 * 主进程统一日志模块（tag 接口）
 *
 * 通过 LOG_LEVEL 环境变量控制输出级别（debug | info | warn | error）。
 * 开发模式默认 debug，打包后默认 info。
 *
 * 生产环境同步将 warn/error 写入 electron-log 文件：
 *   Linux:   ~/.config/{appName}/logs/main.log
 *   macOS:   ~/Library/Logs/{appName}/main.log
 *   Windows: %USERPROFILE%\AppData\Roaming\{appName}\logs\main.log
 */

import { app } from 'electron'
import electronLog from 'electron-log'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS
const isPackaged = typeof app?.isPackaged === 'boolean' ? app.isPackaged : false

function resolveLevel(): Level {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LEVELS) return env as Level
  return isPackaged ? 'info' : 'debug'
}

const isDev = !isPackaged && process.env.NODE_ENV !== 'production'

// In production: write info+ to file, suppress console. In dev: console only.
if (!isDev) {
  electronLog.transports.console.level = false
  electronLog.transports.file.level = 'info'
} else {
  electronLog.transports.console.level = 'debug'
  electronLog.transports.file.level = false
}

let currentLevel: Level | null = null
function getLevel(): Level {
  if (currentLevel === null) currentLevel = resolveLevel()
  return currentLevel
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[getLevel()]
}

function fmt(tag: string): string {
  return `[${tag}]`
}

export const logger = {
  debug(tag: string, ...args: unknown[]): void {
    if (shouldLog('debug')) console.debug(fmt(tag), ...args)
  },
  info(tag: string, ...args: unknown[]): void {
    if (!shouldLog('info')) return
    if (isDev) {
      console.log(fmt(tag), ...args)
    } else {
      electronLog.scope(tag).info(...args)
    }
  },
  warn(tag: string, ...args: unknown[]): void {
    if (!shouldLog('warn')) return
    console.warn(fmt(tag), ...args)
    if (!isDev) electronLog.scope(tag).warn(...args)
  },
  error(tag: string, ...args: unknown[]): void {
    if (!shouldLog('error')) return
    console.error(fmt(tag), ...args)
    if (!isDev) electronLog.scope(tag).error(...args)
  },
}
