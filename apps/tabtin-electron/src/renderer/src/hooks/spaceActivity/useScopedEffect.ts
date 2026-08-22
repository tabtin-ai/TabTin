import { useEffect } from 'react'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { ScopedHookOptions } from './types'

/**
 * useScopedEffect —— 按 Space 活动作用域控制的 useEffect
 *
 * 等价于：
 * ```ts
 * useEffect(() => {
 *   if (!shouldRun) return
 *   // ...effect body...
 *   return cleanup
 * }, [...deps])
 * ```
 * 但 `shouldRun` 由 SpaceActivityContext 自动派生，无需调用方手动管理。
 *
 * 行为：
 * - scope 进入（变 true）→ 跑 effect，注册 cleanup
 * - scope 离开（变 false）→ 跑 cleanup，effect 不再触发
 * - deps 变化（在 scope 内）→ 重跑 effect（cleanup 旧的、跑新的）
 *
 * 注意：与原生 useEffect 不同——传入 deps 时，`shouldRun` 会被自动加为额外依赖。
 *
 * @example
 * ```ts
 * useScopedEffect(() => {
 *   const id = setInterval(tick, 1000)
 *   return () => clearInterval(id)
 * }, [tick])
 * ```
 */
export function useScopedEffect(
  effect: () => void | (() => void),
  deps: React.DependencyList,
  options?: ScopedHookOptions,
): void {
  const { scope = 'foreground', enabled = true } = options ?? {}
  const { isForeground, isHot } = useSpaceActivity()
  const shouldRun = enabled && (scope === 'foreground' ? isForeground : isHot)

  useEffect(() => {
    if (!shouldRun) return
    return effect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, ...deps])
}
