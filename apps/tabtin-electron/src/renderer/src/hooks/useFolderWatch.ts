import { useEffect, useMemo, useRef } from 'react'
import { reportFsWatchSetupFailed } from './fs-watch-telemetry'
import type { FolderWatchEvent } from '@shared/fs-watch-types'
import { createLogger } from '@/utils/logger'

const log = createLogger('FolderWatch')

export type { FolderWatchEvent } from '@shared/fs-watch-types'

/**
 * useFolderWatch — 监听一个或多个根目录的文件变化，给上层一个统一 callback。
 *
 * 抽象动机（B 方案下一刀）：tabfolder（FileTree / useFolderTreeData）和
 * tabcode（TabCodeFileTree / useFileWatcher）历史上各自实现 watch 启动 /
 * 失败容错 / unwatch / 防抖 一套逻辑——四处加起来上百行的样板，且对
 * `fs:watch-event` payload 语义理解微妙不一致（FileTree 误用 dirPath、
 * tabcode 自己 dirname、useFolderTreeData 多根 inline 路由），dogfood 反馈
 * "侧边栏不自动更新"的 bug 就是从这种实现分歧里长出来的。
 *
 * 收敛后：
 *   - 单根 / 多根统一 API（接 `string | { id, rootPath }[]`）
 *   - 防抖（按 root 独立累积事件）下沉到 hook，caller 不用各自再写一次
 *   - watch 启动失败 fail-soft + telemetry 上报，caller 不需要管
 *   - watchId 路由 / 多 watcher 防窜事件 / cancelled race 全部 hook 内部处理
 *
 * 跟 `useFileContentWatch` 的关系：那是个**只订阅不创建**的轻 hook（依赖
 * 别处已创建的 watcher 发出的事件流）；本 hook 是**watcher 创建者**。
 *
 * **callback 语义**：每次调用 callback，events[] 里的所有事件**属于同一个
 * root**（按 rootId 区分）。caller 自己决定要不要按 isGlobal / parentDir
 * 进一步分组——hook 不替 caller 做"哪些目录已展开"这种状态层判断。
 */

export interface FolderWatchRootSpec {
  /** 区分多根的稳定 id，用于 callback 里告诉 caller "这批事件属于哪个根" */
  id: string
  /** 监听的根目录绝对路径 */
  rootPath: string
}

export type FolderWatchInput = string | null | FolderWatchRootSpec[]

export interface UseFolderWatchOptions {
  recursive?: boolean
  /**
   * 防抖窗口 ms。每个 root 独立累积事件，最后一条事件起静默 `debounceMs`
   * 后 flush 一次。默认 200ms（与 caller 历史防抖保持一致）。
   *
   * 设 0 关闭防抖：每条事件立即触发 callback（events[] 长度恒为 1）。极少
   * 场景需要；当前 caller 都用默认值。
   */
  debounceMs?: number
}

/**
 * 单根 caller 的 callback 语义：events 里全是同一个 root 的事件批，rootId
 * 等于内部固定值（无意义）。多根 caller 的 callback 语义：每次只回一个
 * root 的事件批，按 rootId 路由。
 *
 * @param rootId   单根模式下固定为 `'__single__'`，多根时是 spec.id
 * @param events   防抖窗口内累积的事件，按到达顺序排列（已按 main 端
 *                 `pendingByParent` Map 顺序排）
 */
export type FolderWatchCallback = (rootId: string, events: FolderWatchEvent[]) => void

const SINGLE_ROOT_ID = '__single__'

/**
 * 把多形态 input 归一成内部 spec 数组。string null/empty 都返空数组（=不
 * 启动 watcher）；非空 string 包成单根；array 直接 pass 但过滤掉空 rootPath。
 */
function normalizeInput(input: FolderWatchInput): FolderWatchRootSpec[] {
  if (Array.isArray(input)) {
    return input.filter((spec) => spec.rootPath && spec.rootPath.length > 0)
  }
  if (typeof input === 'string' && input.length > 0) {
    return [{ id: SINGLE_ROOT_ID, rootPath: input }]
  }
  return []
}

export function useFolderWatch(
  input: FolderWatchInput,
  onBatch: FolderWatchCallback,
  options?: UseFolderWatchOptions,
): void {
  const onBatchRef = useRef(onBatch)
  onBatchRef.current = onBatch

  const recursive = options?.recursive ?? true
  const debounceMs = options?.debounceMs ?? 200

  // 把 input 归一化 + 用稳定 key 决定 effect 重启时机。array 引用变化不应
  // 让 watcher 重启——按 (id, rootPath) 拼 key 才是真依赖。
  const specs = useMemo(() => normalizeInput(input), [input])
  const specsKey = useMemo(
    () => specs.map((s) => `${s.id}\0${s.rootPath}`).join('\u001f'),
    [specs],
  )

  useEffect(() => {
    if (specs.length === 0) return

    const fileSystem = window.tabtin?.fileSystem
    if (!fileSystem?.watch || !fileSystem?.unwatch || !fileSystem?.onWatchEvent) {
      log.warn('window.tabtin.fileSystem.watch 不可用，跳过启动')
      for (const spec of specs) {
        reportFsWatchSetupFailed({
          rootPath: spec.rootPath,
          error: 'window.tabtin.fileSystem watch API not available',
          source: 'result_failed',
        })
      }
      return
    }

    let cancelled = false
    /** watchId → rootId 路由表（多 watcher 防窜事件 + 多根分发） */
    const watchIdToRootId = new Map<string, string>()
    /** rootId → 启动结果（用于 unmount cleanup 时知道有哪些 watchId 需要 unwatch） */
    const rootIdToWatchId = new Map<string, string>()
    /** 每个 root 独立的 pending events 队列 */
    const pendingByRoot = new Map<string, FolderWatchEvent[]>()
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const flushRoot = (rootId: string) => {
      debounceTimers.delete(rootId)
      const events = pendingByRoot.get(rootId)
      if (!events || events.length === 0) return
      pendingByRoot.set(rootId, [])
      try {
        onBatchRef.current(rootId, events)
      } catch (err) {
        // caller 抛错不应让 hook 内部状态崩——上报日志，下一批照常。
        log.error('caller onBatch threw:', err)
      }
    }

    // 全局事件订阅（一份 listener 路由到 N 个 root），比 N 个独立 listener
    // 内存少。watchId 路由 + cancelled 守卫保证多 watcher 共存不窜。
    const unsubEvent = fileSystem.onWatchEvent((payload) => {
      if (cancelled) return
      const rootId = watchIdToRootId.get(payload.watchId)
      if (!rootId) return

      let queue = pendingByRoot.get(rootId)
      if (!queue) {
        queue = []
        pendingByRoot.set(rootId, queue)
      }
      queue.push(payload)

      // 防抖：每根独立 timer。debounceMs=0 直接 flush。
      if (debounceMs <= 0) {
        flushRoot(rootId)
        return
      }
      const existing = debounceTimers.get(rootId)
      if (existing) clearTimeout(existing)
      debounceTimers.set(
        rootId,
        setTimeout(() => flushRoot(rootId), debounceMs),
      )
    })

    // 异步启动每个 watcher。先订阅再 watch（防 burst 期丢首批）。
    for (const spec of specs) {
      fileSystem
        .watch(spec.rootPath, { recursive })
        .then((result) => {
          if (cancelled) {
            // 组件已 unmount —— 立即 unwatch，别留孤儿
            if (result?.success && result.watchId) {
              fileSystem.unwatch(result.watchId).catch(() => {})
            }
            return
          }
          if (result?.success && result.watchId) {
            watchIdToRootId.set(result.watchId, spec.id)
            rootIdToWatchId.set(spec.id, result.watchId)
          } else if (!result?.success) {
            // fail-soft + telemetry。caller 看不到错误，dogfood 期从 window
            // 快照排查（见 fs-watch-telemetry.ts）。
            log.warn('fs:watch 失败:', spec.rootPath, result?.error)
            reportFsWatchSetupFailed({
              rootPath: spec.rootPath,
              error: result?.error ?? '',
              source: 'result_failed',
            })
          }
        })
        .catch((err) => {
          if (cancelled) return
          log.warn('fs:watch 异常:', spec.rootPath, err)
          reportFsWatchSetupFailed({
            rootPath: spec.rootPath,
            error: err,
            source: 'thrown',
          })
        })
    }

    return () => {
      cancelled = true
      unsubEvent()
      for (const t of debounceTimers.values()) clearTimeout(t)
      debounceTimers.clear()
      for (const watchId of rootIdToWatchId.values()) {
        fileSystem.unwatch(watchId).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey, recursive, debounceMs])
}
