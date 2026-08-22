import { createLogger } from '../logger'

const log = createLogger('PromiseMutex')

/**
 * 基于 Promise 链的互斥锁，保证异步操作串行执行。
 *
 * 特点：
 * - acquire 返回 release 函数，必须在 finally 中调用
 * - 支持超时，防止前序操作卡死导致永久阻塞
 * - 超时时不破坏锁链，后续等待者继续排队等当前持有者完成
 * - 持有者超时保护（safetyTimeoutMs）防止死锁
 */
export class PromiseMutex {
  private chain = Promise.resolve()

  async acquire(timeoutMs = 30_000, safetyTimeoutMs = 60_000): Promise<() => void> {
    let release!: () => void
    let released = false
    const prev = this.chain
    this.chain = new Promise<void>((r) => {
      release = () => {
        if (released) return
        released = true
        r()
      }
    })

    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Mutex acquire timeout after ${timeoutMs}ms`)),
        timeoutMs,
      )
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    })

    try {
      await Promise.race([prev, timeout])
      clearTimeout(timer!)
    } catch (err) {
      clearTimeout(timer!)
      // 超时者不进入临界区，但必须保持锁链完整：
      // 当前持有者完成后自动传递给下一个等待者
      prev.then(release, release)
      throw err
    }

    let safetyTimer: ReturnType<typeof setTimeout> | null = null
    if (safetyTimeoutMs > 0) {
      safetyTimer = setTimeout(() => {
        if (!released) {
          log.error(`Safety timeout: lock held for >${safetyTimeoutMs}ms, force releasing`)
          release()
        }
      }, safetyTimeoutMs)
      if (typeof safetyTimer === 'object' && 'unref' in safetyTimer) safetyTimer.unref()
    }

    return () => {
      if (safetyTimer) clearTimeout(safetyTimer)
      release()
    }
  }
}
