import { useEffect, useRef } from 'react'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { ScopedHookOptions } from './types'

/**
 * useScopedTimeout —— 按 Space 活动作用域控制的 setTimeout 包装
 *
 * 适用于「持续型」一次性定时器——挂载即起、超时即触发；scope 离开会取消。
 * 不适合 effect 内部的瞬时 setTimeout（直接用 setTimeout 即可）。
 *
 * 行为：
 * - scope 进入 + delay 非 null → 启动定时器
 * - scope 离开 / delay 变 null / unmount → 自动 clearTimeout
 * - 触发后定时器自动失效（不会重复触发，除非 deps 变化重启）
 *
 * @param callback 触发回调
 * @param delay 延时毫秒；传 `null` 暂停
 * @param options scope / enabled
 *
 * @example
 * ```ts
 * useScopedTimeout(() => {
 *   if (stillStuck()) markInterrupted()
 * }, 65_000, { scope: 'hot' })  // 65s 兜底，hot 时也跑
 * ```
 */
export function useScopedTimeout(
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
    const id = setTimeout(() => cbRef.current(), delay)
    return () => clearTimeout(id)
  }, [shouldRun, delay])
}
