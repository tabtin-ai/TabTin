import { useEffect, useRef } from 'react'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { ScopedHookOptions } from './types'

/**
 * useScopedInterval —— 按 Space 活动作用域控制的 setInterval 包装
 *
 * 行为：
 * - scope 进入 + delay 非 null → 启动定时器
 * - scope 离开 / delay 变 null / unmount → 自动 clearInterval
 * - callback 自动持稳，无需 useCallback
 *
 * @param callback 回调函数
 * @param delay 间隔毫秒；传 `null` 暂停
 * @param options scope / enabled
 *
 * @example
 * ```ts
 * useScopedInterval(() => {
 *   refreshHeartbeat()
 * }, 5000)  // 默认 foreground 作用域，inactive 时自动暂停
 *
 * useScopedInterval(tickStreaming, 1000, { scope: 'hot' })  // hot 时也跑
 * ```
 */
export function useScopedInterval(
  callback: () => void,
  delay: number | null,
  options?: ScopedHookOptions,
): void {
  const { scope = 'foreground', enabled = true } = options ?? {}
  const { isForeground, isHot } = useSpaceActivity()
  const shouldRun = enabled && (scope === 'foreground' ? isForeground : isHot)

  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (!shouldRun || delay === null) return
    const id = setInterval(() => cbRef.current(), delay)
    return () => clearInterval(id)
  }, [shouldRun, delay])
}
