import { useEffect, useRef } from 'react'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { ScopedHookOptions } from './types'

type ScopedListenerTarget = EventTarget | null | undefined

interface ScopedEventListenerOptions extends ScopedHookOptions {
  capture?: boolean
  passive?: boolean
  once?: boolean
}

/**
 * useScopedEventListener —— 按 Space 活动作用域控制的 addEventListener 包装
 *
 * 行为：
 * - scope 进入 + target 存在 → 注册 listener
 * - scope 离开 / target 变空 / unmount → 自动 removeEventListener
 * - listener 函数自动持稳（用 ref），无需 useCallback——但要注意 listener
 *   内部读到的是最新值（闭包陷阱不存在）
 *
 * 类型注解：默认事件类型是 `Event`。需要更精确类型时通过泛型显式指定：
 * ```ts
 * useScopedEventListener<KeyboardEvent>(window, 'keydown', e => {
 *   if (e.key === 'Escape') close()
 * })
 * ```
 *
 * @param target 监听目标。`null` / `undefined` 时不注册（适合 ref.current 模式）
 * @param type 事件类型
 * @param listener 监听器
 * @param options 选项（scope / enabled / capture / passive / once）
 */
export function useScopedEventListener<E extends Event = Event>(
  target: ScopedListenerTarget,
  type: string,
  listener: (event: E) => void,
  options?: ScopedEventListenerOptions,
): void {
  const {
    scope = 'foreground',
    enabled = true,
    capture,
    passive,
    once,
  } = options ?? {}

  const { isForeground, isHot } = useSpaceActivity()
  const shouldRun = enabled && (scope === 'foreground' ? isForeground : isHot)

  const listenerRef = useRef(listener)
  listenerRef.current = listener

  useEffect(() => {
    if (!shouldRun || !target) return
    const handler = (event: Event) => listenerRef.current(event as E)
    const opts: AddEventListenerOptions = {}
    if (capture !== undefined) opts.capture = capture
    if (passive !== undefined) opts.passive = passive
    if (once !== undefined) opts.once = once
    target.addEventListener(type, handler, opts)
    return () => target.removeEventListener(type, handler, opts)
  }, [shouldRun, target, type, capture, passive, once])
}
