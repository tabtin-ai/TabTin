/**
 * IPC 调用超时保护工具
 *
 * 为所有 renderer → main process 的 IPC 调用提供统一的超时保护，
 * 避免因主进程无响应导致 renderer 永久阻塞。
 */

/** 默认 IPC 超时：30 秒 */
export const DEFAULT_IPC_TIMEOUT = 30_000

/** 长操作超时：60 秒（如脚本执行、内容获取等） */
export const LONG_IPC_TIMEOUT = 60_000

/**
 * 为 Promise 添加超时保护。
 * 超时后 reject 并附带操作标签及可选上下文，方便排查。
 */
export function withTimeout<T>(promise: Promise<T>, ms = DEFAULT_IPC_TIMEOUT, label = 'IPC', context?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    const contextSuffix = context ? ` [${context}]` : ''
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms${contextSuffix}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
