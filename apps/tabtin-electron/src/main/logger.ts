/**
 * 主进程统一 Logger
 *
 * Node.js 中 console.debug === console.log，无级别过滤。
 * 此模块提供三级输出控制：
 *   debug  — 仅 ELECTRON_VERBOSE=true 时输出（周期性 / 高频 / 内部细节）
 *   info   — 开发环境输出到 console；生产环境写入日志文件（不输出到 console）
 *   warn   — 始终输出到 console，同时写入日志文件
 *   error  — 始终输出到 console，同时写入日志文件
 *
 * 生产环境日志文件由 electron-log 管理，路径：
 *   Linux:   ~/.config/{appName}/logs/main.log
 *   macOS:   ~/Library/Logs/{appName}/main.log
 *   Windows: %USERPROFILE%\AppData\Roaming\{appName}\logs\main.log
 */

import { existsSync, renameSync, rmSync } from 'node:fs'
import { join, parse } from 'node:path'
import { app } from 'electron'
import electronLog from 'electron-log'

// 防御式读取：日志基础设施在 import 期就会执行，此处绝不能因 `app` 尚未就绪
// （极早期启动 / worker / 测试里 electron mock 未导出 app）而抛错——那会反噬
// 任何 import 了本 logger 的业务模块。取不到一律按非打包（dev）处理。
function readIsPackaged(): boolean {
  try {
    return typeof app?.isPackaged === 'boolean' ? app.isPackaged : false
  } catch {
    return false
  }
}
const isPackaged = readIsPackaged()
const isDev = !isPackaged && process.env.NODE_ENV !== 'production'
const isVerbose = isDev && process.env.ELECTRON_VERBOSE === 'true'

const MAIN_LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024
const MAIN_LOG_ARCHIVE_COUNT = 5

type RotatableLogFile = {
  toString(): string
  crop?: (bytesAfter?: number) => void
}

type RotatableFileTransport = typeof electronLog.transports.file & {
  maxSize: number
  archiveLogFn?: (file: RotatableLogFile) => void
}

function archivePathFor(logPath: string, index: number): string {
  const parsed = parse(logPath)
  return join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`)
}

function rotateLogFile(file: RotatableLogFile): void {
  const currentPath = file.toString()
  for (let index = MAIN_LOG_ARCHIVE_COUNT; index >= 1; index -= 1) {
    const sourcePath = index === 1 ? currentPath : archivePathFor(currentPath, index - 1)
    const targetPath = archivePathFor(currentPath, index)
    if (!existsSync(sourcePath)) continue
    try {
      rmSync(targetPath, { force: true })
      renameSync(sourcePath, targetPath)
    } catch (error) {
      // 轮转失败时退回 electron-log 默认思路：裁掉当前文件尾部，避免无限增长。
      const fallbackBytes = Math.min(Math.round(MAIN_LOG_MAX_SIZE_BYTES / 4), 256 * 1024)
      file.crop?.(fallbackBytes)
      console.warn('[Logger] Could not rotate main log', error)
      break
    }
  }
}

const fileTransport = electronLog.transports.file as RotatableFileTransport
fileTransport.maxSize = MAIN_LOG_MAX_SIZE_BYTES
fileTransport.archiveLogFn = rotateLogFile

// 生产环境：仅保留 info 及以上级别写入文件，控制台静默
// 开发环境：console transport 保留全部级别（electron-log 默认行为）
if (!isDev) {
  electronLog.transports.console.level = false
  electronLog.transports.file.level = 'info'
} else {
  electronLog.transports.console.level = 'debug'
  electronLog.transports.file.level = false
}

export interface StartupTimingData {
  type: 'startup-timing'
  timestamps: Record<string, number>
  totalMs: number
}

/**
 * 启动链路性能打点工具。
 * 开发环境输出到 console；生产环境通过 electron-log 写入日志文件。
 * flush() 将所有已记录的 timing 数据作为结构化 JSON 一次性写入日志，
 * 并触发通过 onFlush() 注册的回调（用于远程上报等）。
 */
export const startupPerf: {
  mark: (label: string) => void
  measure: (label: string) => void
  sinceStart: (label: string) => void
  flush: () => void
  onFlush: (cb: (data: StartupTimingData) => void) => void
} = (() => {
  const t0 = performance.now()
  const marks = new Map<string, number>()
  const timestamps: Record<string, number> = {}
  const perfLog = electronLog.scope('StartupPerf')
  const emit = isDev
    ? (msg: string) => console.log(msg)
    : (msg: string) => perfLog.info(msg)
  const flushCallbacks: Array<(data: StartupTimingData) => void> = []

  return {
    mark: (label: string) => {
      marks.set(label, performance.now())
    },
    measure: (label: string) => {
      const start = marks.get(label)
      if (start == null) return
      const elapsed = performance.now() - start
      timestamps[label] = Math.round(elapsed)
      emit(`[Perf] ${label}: ${elapsed.toFixed(0)}ms`)
      marks.delete(label)
    },
    sinceStart: (label: string) => {
      const elapsed = performance.now() - t0
      timestamps[label] = Math.round(elapsed)
      emit(`[Perf] ${label}: +${elapsed.toFixed(0)}ms (since logger init)`)
    },
    flush: () => {
      const totalMs = Math.round(performance.now() - t0)
      const data: StartupTimingData = { type: 'startup-timing', timestamps: { ...timestamps }, totalMs }
      if (isDev) {
        console.log('[Perf] flush:', JSON.stringify(data))
      } else {
        perfLog.info(JSON.stringify(data))
      }
      for (const cb of flushCallbacks) {
        try {
          cb(data)
        } catch {
          // 回调异常不影响启动流程
        }
      }
    },
    onFlush: (cb) => {
      flushCallbacks.push(cb)
    },
  }
})()

export function createLogger(module: string) {
  const prefix = `[${module}]`
  const fileLog = electronLog.scope(module)
  return {
    debug: (...args: unknown[]) => {
      if (isVerbose) console.log(prefix, ...args)
    },
    info: (...args: unknown[]) => {
      if (isDev) {
        console.log(prefix, ...args)
      } else {
        fileLog.info(...args)
      }
    },
    log: (...args: unknown[]) => {
      if (isDev) {
        console.log(prefix, ...args)
      } else {
        fileLog.info(...args)
      }
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args)
      if (!isDev) fileLog.warn(...args)
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args)
      if (!isDev) fileLog.error(...args)
    },
  }
}
