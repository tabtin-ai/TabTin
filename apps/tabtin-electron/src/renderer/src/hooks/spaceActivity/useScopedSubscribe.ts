import { useEffect, useRef } from 'react'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { ScopedHookOptions } from './types'

/**
 * useScopedSubscribe —— 按 Space 活动作用域控制的通用订阅
 *
 * 适用于任意「subscribe → unsubscribe」模式——IPC、event bus、store
 * subscribe、自定义 emitter 等。
 *
 * 行为：
 * - scope 进入 → 调 subscribe，记录返回的 unsubscribe
 * - scope 离开 / unmount → 调 unsubscribe
 * - subscribe 函数自动持稳（用 ref）
 *
 * @param subscribe 订阅函数，返回 unsubscribe（或 void）
 * @param deps 依赖数组——变化时重新订阅
 * @param options scope / enabled。**注意 IPC 类业务订阅常用 scope: 'hot'**
 *
 * @example
 * ```ts
 * useScopedSubscribe(
 *   () => onResourceEvent('tabdata', reload, { spaceId }),
 *   [spaceId, reload],
 *   { scope: 'hot' },  // hot Space 也保留订阅，避免事件丢失
 * )
 * ```
 */
export function useScopedSubscribe(
  subscribe: () => (() => void) | void | undefined,
  deps: React.DependencyList,
  options?: ScopedHookOptions,
): void {
  const { scope = 'foreground', enabled = true } = options ?? {}
  const { isForeground, isHot } = useSpaceActivity()
  const shouldRun = enabled && (scope === 'foreground' ? isForeground : isHot)

  const subscribeRef = useRef(subscribe)
  subscribeRef.current = subscribe

  useEffect(() => {
    if (!shouldRun) return
    const unsubscribe = subscribeRef.current()
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, ...deps])
}
