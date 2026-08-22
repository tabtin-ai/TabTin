/**
 * useRunManager - Run 生命周期管理
 *
 * 统一管理 runId 的创建、复用、清理。
 *
 * # cleanup 守卫（Wave 3.2）
 *
 * React 19.2 `<Activity mode="hidden">` 让组件子树「挂着但不可见」：useState/
 * useRef 保留，但 effect 走 cleanup（visible 时再重 setup）。原本的 effect
 * cleanup 写死「unmount = endRun」，Activity hidden 也走这条路 → hot Space
 * 切走时 Run 被误杀，违背产品决策"切走但仍 hot 时 Run 不结束"。
 *
 * 引入 `shouldKeepRunOnCleanup?: () => boolean`：cleanup 触发时调一次，返回
 * true 则跳过 endRun 且**不清空 runIdRef**——这样 visible 时同一 hook 实例
 * 的 ensureRun() 直接复用旧 runId，不会重建主进程 Run。
 *
 * 调用方（CrawlspaceWorkspace）传一个查"spaceId 在 hot 集合 && crawlspace
 * config 还在 store"的双条件闭包：
 * - Activity hidden（hot 仍在、config 仍在）→ 保活 ✓
 * - hot LRU 驱逐（不在 hot）→ endRun ✓
 * - 用户关 crawlspace（config 不在）→ endRun ✓
 * - 删 Space（config 不在）→ endRun ✓
 *
 * 真 unmount 走的是新 hook 实例，ref 是新建的（值 null），逻辑天然分离。
 *
 * # 当前生效范围
 *
 * 守卫闭包跑在 effect cleanup 时机，触发条件分两类：
 *
 * 1. 真 unmount（**当下就生效**）：
 *    - hot LRU 驱逐：第 4 个 Space 激活把第 1 个挤出 → SpaceWorkbenchHost 不再
 *      渲染该 Space 子树 → CrawlspaceWorkspace unmount → cleanup 跑
 *    - 用户删 Space：spaces 列表剔除 → 同上
 *    - 用户关 crawlspace：crawlspaceConfig 失效 → SpaceWorkbenchHost 内的
 *      `crawlspaceId && crawlspaceConfig` 判空不渲染 → 同上
 *
 * 2. Activity hidden（**Wave 2c 落地后才生效**）：
 *    截至 Wave 3.2 落地时，`SpaceWorkbenchHost` 还是 `display:none` 切换 visible，
 *    没用 React 19.2 `<Activity>` 包裹——所以"前台 ↔ 后台-hot 切换"这条路径**当
 *    前不会触发** cleanup。Wave 2c 把容器改成 `<Activity>` 后才会触发，那时守卫
 *    才能真正区分"hidden 应保活"vs"真销毁"。
 *
 * 如果排查"切走 hot Space 后 Run 被错误结束"——分两种情形：Wave 2c 之前 hot
 * 仍含的 Space 走 `display:none` 不卸载、effect 不跑 cleanup（Run 自然保活）；
 * Wave 2c 之后改 `<Activity hidden>` 才会触发 cleanup，那时守卫闭包返 true 保活。
 * 真 unmount（hot 驱逐 / 删 Space / 关 cs）三种 Wave 之前/之后行为一致：触发
 * cleanup → 守卫闭包返 false → endRun。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunId, RunManagerReturn } from '../types'

export interface RunSessionAdapter {
  create?: (runId: string, sessionId?: string) => Promise<{ success: boolean; error?: string }>
  endRun?: (runId: string, options?: { reason?: string }) => Promise<{ success: boolean; error?: string }>
}

export interface UseRunManagerOptions {
  runPrefix: string
  userId?: string
  onRunCreated?: (runId: RunId) => void
  onRunCleanup?: (runId: RunId) => void
  isActive?: boolean
  adapter?: RunSessionAdapter
  /**
   * 组件 unmount / effect cleanup 时，调用方判断是否保活当前 Run。
   *
   * 返回 true：跳过 endRun，runIdRef 保留——配合 React 19.2 `<Activity>`
   * 的 hidden 语义，让 visible 时同一 hook 实例继续复用旧 runId。
   *
   * 返回 false / 不传：cleanup 时调 endRun 并清空 runIdRef（默认行为）。
   *
   * 业务侧典型实现：
   *   () => spaceIdInHotScenes && crawlspaceConfigStillExists
   */
  shouldKeepRunOnCleanup?: () => boolean
}

export function useRunManager(options: UseRunManagerOptions): RunManagerReturn {
  const { runPrefix, userId, onRunCreated, onRunCleanup, isActive = true, adapter } = options

  // 🔧 修复：使用 useState 而不是 useRef，确保触发重渲染
  const [runId, setRunId] = useState<RunId | null>(null)
  const runIdRef = useRef<RunId | null>(null)
  const pendingPromiseRef = useRef<Promise<RunId | null> | null>(null)

  // Wave 3.2 守卫：用 ref 持有最新闭包，让 cleanup 能严格只在 mount/unmount
  // 触发（依赖空数组）。否则 adapter / onRunCleanup 引用飘移会误触发 cleanup
  // → 误调 endRun，跟 Activity hidden 的误杀同源。
  const adapterRef = useRef(adapter)
  const onRunCleanupRef = useRef(onRunCleanup)
  const shouldKeepRunOnCleanupRef = useRef(options.shouldKeepRunOnCleanup)
  useEffect(() => {
    adapterRef.current = adapter
    onRunCleanupRef.current = onRunCleanup
    shouldKeepRunOnCleanupRef.current = options.shouldKeepRunOnCleanup
  })

  /**
   * 确保 Run 存在（懒加载创建）
   */
  const ensureRun = useCallback(async (): Promise<RunId | null> => {
    if (!isActive) {
      console.warn('[useRunManager] inactive, skipping run creation')
      return null
    }
    // 如果已存在，直接返回
    if (runIdRef.current) {
      return runIdRef.current
    }

    // CC-007: pending promise 模式防并发 — 后续调用等待首次创建的同一个 promise
    if (pendingPromiseRef.current) {
      return pendingPromiseRef.current
    }

    const createPromise = (async (): Promise<RunId | null> => {
      try {
        // 生成 runId
        const newRunId = `run-${runPrefix}-${Date.now()}`

        const sessionId = `session-${runPrefix}-${userId || 'anonymous'}`

        // 调用宿主创建 Run（推荐走 adapter 注入）
        const createResult = await adapter?.create?.(newRunId, sessionId)

        // adapter 未提供时，仍生成 runId 供前端逻辑使用（但不会创建主进程 Run）
        if (!adapter?.create) {
          setRunId(newRunId)
          runIdRef.current = newRunId
          console.warn('[useRunManager] runSession adapter not provided, runId only valid on renderer side:', newRunId)
          onRunCreated?.(newRunId)
          return newRunId
        }

        if (createResult?.success) {
          setRunId(newRunId)
          runIdRef.current = newRunId
          onRunCreated?.(newRunId)
          return newRunId
        } else {
          console.warn('[useRunManager] run creation failed:', createResult?.error)
          return null
        }
      } catch (err) {
        console.error('[useRunManager] run creation error:', err)
        return null
      } finally {
        pendingPromiseRef.current = null
      }
    })()

    pendingPromiseRef.current = createPromise
    return createPromise
  }, [runPrefix, userId, onRunCreated, isActive, adapter])

  /**
   * 清理 Run（显式销毁，跟 effect cleanup 不同：cleanupRun 一定结束 Run，
   * 不查保活闭包——业务侧主动调用就是"现在就要关"的语义）。
   *
   * 健壮性对齐 effect cleanup 路径（Wave 3.2 + 三视角 Review 加固）：
   * - onRunCleanup 抛错 → 警告但继续 endRun，避免业务回调把整个 cleanup 流程拖死
   * - endRun 失败 → 仍清 setRunId / runIdRef，避免留孤儿 ref 让下次 ensureRun
   *   返回 stale runId，主进程已认为 Run 结束但 renderer 还在用旧 runId 发命令
   */
  const cleanupRun = useCallback(async (): Promise<void> => {
    if (!runIdRef.current) {
      return
    }

    const runId = runIdRef.current

    try {
      onRunCleanup?.(runId)
    } catch (err) {
      console.warn('[useRunManager] onRunCleanup 抛错（忽略，继续 endRun）:', err)
    }

    if (adapter?.endRun) {
      try {
        await adapter.endRun(runId, { reason: 'cleanup' })
      } catch (err) {
        console.warn('[useRunManager] endRun(cleanup) 失败（忽略，仍清 runId 状态）:', err)
      }
    } else {
      console.warn('[useRunManager] runSession.endRun adapter not provided, skipping main process cleanup:', runId)
    }

    setRunId(null)
    runIdRef.current = null
  }, [onRunCleanup, adapter])

  // 组件 unmount / effect cleanup 时清理 Run。
  // 严格空依赖——靠上面 ref sync effect 保证读到最新 adapter / onRunCleanup /
  // shouldKeepRunOnCleanup。否则依赖飘移会误触发 cleanup → 误调 endRun。
  useEffect(() => {
    return () => {
      if (!runIdRef.current) return

      // 调用方主张「保活」（典型场景：Space 仍在 hot 且 crawlspace config
      // 仍在 store）→ 跳过 endRun，runIdRef 保留以备 visible 时复用。
      if (shouldKeepRunOnCleanupRef.current?.()) {
        return
      }

      const runId = runIdRef.current
      try {
        onRunCleanupRef.current?.(runId)
      } catch (err) {
        console.warn('[useRunManager] onRunCleanup 抛错（忽略，继续 endRun）:', err)
      }
      // fire-and-forget：cleanup 不能 await，但要 catch 避免 unhandled rejection
      // 污染日志和 error reporter。endRun 失败时只能等主进程超时清理（已知账）。
      adapterRef.current?.endRun?.(runId, { reason: 'unmount' }).catch(err => {
        console.warn('[useRunManager] endRun(unmount) IPC 失败（忽略）:', err)
      })
      // state 与 ref 必须一起清。Wave 3.2 复核加固：原本只清 ref，遇到 Activity
      // 同实例 cleanup（不是真 unmount，比如 ref 同步 effect 触发的依赖飘移）后
      // visible 时，state.runId 还是旧值但 ref 已 null —— 下次 ensureRun 会创建
      // 新 runId 覆盖 state，但中间渲染窗口里 UI 显示的是 stale runId（指向已结
      // 束的 Run），下游消费方拿到错的 id 发命令会失败。
      setRunId(null)
      runIdRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    runId,
    ensureRun,
    cleanupRun
  }
}
