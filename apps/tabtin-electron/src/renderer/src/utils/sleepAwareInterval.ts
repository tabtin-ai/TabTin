/**
 * sleepAwareInterval — 防雪崩定时器工具
 *
 * 系统睡眠期间，setInterval 回调被暂停。唤醒后浏览器可能会密集
 * 触发大量累积回调，导致主线程阻塞。
 *
 * 此工具在每次回调执行前检查距上次执行的真实时间间隔，如果远超预期
 * （说明刚从睡眠中恢复），则跳过本次执行，避免雪崩。
 */

export interface SleepAwareInterval {
  start: () => void
  stop: () => void
  isRunning: () => boolean
}

export function createSleepAwareInterval(
  callback: () => void,
  intervalMs: number,
  options?: { maxSkipRatio?: number },
): SleepAwareInterval {
  const skipRatio = options?.maxSkipRatio ?? 3
  let timerId: ReturnType<typeof setInterval> | null = null
  let lastRunAt = 0

  const wrappedCallback = () => {
    const now = Date.now()
    const elapsed = now - lastRunAt
    lastRunAt = now

    if (elapsed > intervalMs * skipRatio) {
      return
    }
    callback()
  }

  return {
    start() {
      if (timerId) return
      lastRunAt = Date.now()
      timerId = setInterval(wrappedCallback, intervalMs)
    },
    stop() {
      if (!timerId) return
      clearInterval(timerId)
      timerId = null
    },
    isRunning() {
      return timerId !== null
    },
  }
}
