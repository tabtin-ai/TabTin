/**
 * app-shell 跨端日志
 *
 * console 行为：生产环境（NODE_ENV=production）静默 log/info/debug，warn/error 始终输出。
 *
 * 诊断 sink：宿主端（如 Electron）可通过 `setAppShellLogSink` 注入收集器，把 app-shell
 * 的日志接进宿主自己的诊断能力（例如 Electron 诊断包的环形缓冲）。跨端包本身不依赖
 * 任何平台——web / mobile 不注入即无副作用。
 *
 * 关键：sink **不受 isDebugEnabled 限制**——诊断包恰恰需要生产环境的 info/debug；
 * 且 sink 必须旁路安全（异常一律吞掉，绝不反噬业务）。
 */

const isDebugEnabled = typeof process !== 'undefined'
  ? process.env.NODE_ENV !== 'production'
  : true

export type AppShellLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
export type AppShellLogSink = (level: AppShellLogLevel, module: string, args: unknown[]) => void

let logSink: AppShellLogSink | null = null

/** 注入 / 清除诊断 sink（传 null 清除）。宿主端在启动时接入自己的日志收集器。 */
export function setAppShellLogSink(sink: AppShellLogSink | null): void {
  logSink = sink
}

function forwardToSink(level: AppShellLogLevel, module: string, args: unknown[]): void {
  if (!logSink) return
  try {
    logSink(level, module, args)
  } catch {
    // 旁路观测：sink 异常一律吞掉，绝不反噬业务
  }
}

export const logger = {
  log: (...args: unknown[]) => { if (isDebugEnabled) console.log(...args); forwardToSink('log', '', args) },
  error: (...args: unknown[]) => { console.error(...args); forwardToSink('error', '', args) },
  warn: (...args: unknown[]) => { console.warn(...args); forwardToSink('warn', '', args) },
  info: (...args: unknown[]) => { if (isDebugEnabled) console.info(...args); forwardToSink('info', '', args) },
  debug: (...args: unknown[]) => { if (isDebugEnabled) console.debug(...args); forwardToSink('debug', '', args) },
}

export function createLogger(module: string) {
  const prefix = `[${module}]`
  return {
    log:   (...args: unknown[]) => { if (isDebugEnabled) console.log(prefix, ...args); forwardToSink('log', module, args) },
    debug: (...args: unknown[]) => { if (isDebugEnabled) console.debug(prefix, ...args); forwardToSink('debug', module, args) },
    info:  (...args: unknown[]) => { if (isDebugEnabled) console.info(prefix, ...args); forwardToSink('info', module, args) },
    warn:  (...args: unknown[]) => { console.warn(prefix, ...args); forwardToSink('warn', module, args) },
    error: (...args: unknown[]) => { console.error(prefix, ...args); forwardToSink('error', module, args) },
  }
}
