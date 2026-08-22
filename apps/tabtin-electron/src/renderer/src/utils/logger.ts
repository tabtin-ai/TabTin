/**
 * 条件日志工具
 * 生产环境自动禁用，避免性能损耗
 *
 * 两种使用方式:
 *   import { logger } from '@/utils/logger'       — 单例，无前缀
 *   import { createLogger } from '@/utils/logger'  — 工厂，自动加 [Module] 前缀
 *
 * 对象序列化由 preload 全局 console 拦截统一处理，
 * 此处无需关心 [object Object] 问题。
 */

import { recordLog } from '@/services/logCollector'

const isDev = import.meta.env.DEV
const isDebugEnabled = isDev && import.meta.env.VITE_DEBUG_LOGS !== 'false'

// 生产环境下 log/info/debug 不打 console（devtools 无人看 + 避免主进程 stdout 噪声），
// 但要喂给 logCollector 环形缓冲，让诊断包能拿到界面层日志。
// warn/error 始终走 console，会被 installConsoleCapture() 的包裹自动收集，无需重复 record。
export const logger = {
  log: (...args: unknown[]) => {
    if (isDebugEnabled) console.log(...args)
    else recordLog('log', args)
  },

  error: (...args: unknown[]) => {
    console.error(...args)
  },

  warn: (...args: unknown[]) => {
    console.warn(...args)
  },

  info: (...args: unknown[]) => {
    if (isDebugEnabled) console.info(...args)
    else recordLog('info', args)
  },

  debug: (...args: unknown[]) => {
    if (isDebugEnabled) console.debug(...args)
    else recordLog('debug', args)
  },
}

/**
 * 模块级 logger 工厂，自动添加 [Module] 前缀。
 * API 与主进程 createLogger 对齐。
 */
export function createLogger(module: string) {
  const prefix = `[${module}]`
  return {
    log:   (...args: any[]) => logger.log(prefix, ...args),
    debug: (...args: any[]) => logger.debug(prefix, ...args),
    info:  (...args: any[]) => logger.info(prefix, ...args),
    warn:  (...args: any[]) => logger.warn(prefix, ...args),
    error: (...args: any[]) => logger.error(prefix, ...args),
  }
}

// 性能测量工具
export const perf = {
  start: (label: string) => {
    if (isDebugEnabled) {
      performance.mark(`${label}-start`)
    }
  },

  end: (label: string) => {
    if (isDebugEnabled) {
      performance.mark(`${label}-end`)
      performance.measure(label, `${label}-start`, `${label}-end`)
      const measure = performance.getEntriesByName(label)[0]
      console.log(`⏱️ ${label}: ${measure.duration.toFixed(2)}ms`)
    }
  },
}
