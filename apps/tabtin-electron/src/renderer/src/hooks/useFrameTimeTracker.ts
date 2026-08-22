import { useEffect, useRef, useState } from 'react'

const WINDOW_SIZE = 16
const STATE_FLUSH_INTERVAL_MS = 500

/**
 * rAF 循环采样，返回最近 WINDOW_SIZE 帧的平均帧时间（毫秒）。
 * - document.hidden 时暂停采样，避免后台 tab 产生异常值
 * - 状态更新节流至 ~500ms，避免每帧触发 React 渲染
 * - 返回 0 表示尚无有效数据（首次渲染 / 未启用）
 */
export function useFrameTimeTracker(enabled = true): number {
  const [avg, setAvg] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setAvg(0)
      return
    }

    const ring = new Float64Array(WINDOW_SIZE)
    let idx = 0
    let filled = 0
    let prevTs = 0
    let lastFlush = 0

    const tick = (now: number): void => {
      if (document.hidden) {
        prevTs = 0
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      if (prevTs > 0) {
        const dt = now - prevTs
        if (dt > 0 && dt < 500) {
          ring[idx] = dt
          idx = (idx + 1) % WINDOW_SIZE
          if (filled < WINDOW_SIZE) filled++
        }
      }
      prevTs = now

      if (filled > 0 && now - lastFlush >= STATE_FLUSH_INTERVAL_MS) {
        lastFlush = now
        let sum = 0
        for (let i = 0; i < filled; i++) sum += ring[i]
        const rounded = Math.round(sum / filled)
        setAvg((prev) => (prev === rounded ? prev : rounded))
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [enabled])

  return avg
}
