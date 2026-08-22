import { useEffect, useRef } from 'react'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { ScopedHookOptions } from './types'

type ScopedObserverTarget = Element | null | undefined

/**
 * useScopedResizeObserver —— 按 Space 活动作用域控制的 ResizeObserver
 *
 * 行为：
 * - scope 进入 + target 存在 → observe(target)
 * - scope 离开 / target 变空 / unmount → 自动 disconnect
 * - 默认 foreground 作用域——后台 Space 的 layout 测量没意义，应该停掉
 *
 * @param target 观察目标。null/undefined 时不注册
 * @param callback ResizeObserver 回调
 * @param options scope / enabled / box
 *
 * @example
 * ```ts
 * const ref = useRef<HTMLDivElement>(null)
 * useScopedResizeObserver(ref.current, entries => {
 *   setWidth(entries[0].contentRect.width)
 * })
 * ```
 */
export function useScopedResizeObserver(
  target: ScopedObserverTarget,
  callback: ResizeObserverCallback,
  options?: ScopedHookOptions & { box?: ResizeObserverBoxOptions },
): void {
  const { scope = 'foreground', enabled = true, box } = options ?? {}
  const { isForeground, isHot } = useSpaceActivity()
  const shouldRun = enabled && (scope === 'foreground' ? isForeground : isHot)

  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (!shouldRun || !target || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries, obs) => cbRef.current(entries, obs))
    observer.observe(target, box ? { box } : undefined)
    return () => observer.disconnect()
  }, [shouldRun, target, box])
}
