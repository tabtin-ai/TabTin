/**
 * useStorageData — 存储管理面板的统一数据 hook（2026-05 v5 精简版）。
 *
 * 单一职责：
 *   - 拉所有 buckets descriptor（含 hideFromList=true，让 buildTopItems
 *     自己决定怎么处理）
 *   - 并发跑 sizeFn 度量容量
 *   - 暴露 onClear / onListItems / onExport 三个操作回调
 *
 * **不再做**（v5 移除）：
 *   - `summary` 字段：双重计数 bug 的源头——它会把 `*:summary-export` 类
 *     hideFromList bucket 的 bytes 累加进 totalBytes，但那些 bucket 实际
 *     和 shadow-git / conversations 等真实 bucket 测的是同一份磁盘数据。
 *     现在由 index.tsx 自行算 effective totalBytes（过滤 hideFromList=true）。
 *   - `suggestions` 字段：原本是"智能建议卡片"用，但 v3 减压重设后 UI 没消费方了。
 *   - `computeSuggestions` 函数 + `SUGGESTION_THRESHOLDS` 常量：随之删除。
 *
 * 设计细节：
 *   - **bridge 模块单例**——hook 第一次实例化时在模块层 lazy 创建，
 *     后续渲染都复用同一个 bridge，避免多组件同时挂载时反复调
 *     `createMainProcessBridge`；
 *   - **size 度量是 lazy + 并发限流**：listAllBuckets 拿到 30+ bucket 后
 *     再批量 getBucketSize，串行 4 路并发（不打满 IPC 队列也不顺序卡死）；
 *   - 整体不抖动：没度量完时 size === undefined，UI 显示骨架；度量完成
 *     后一次 setState 灌入全部，避免每个 bucket 单独触发 re-render。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RendererStorageBridge,
  createDaemonBridge,
  createMainProcessBridge,
  type IpcRendererInvoker,
} from '@tabtin/storage-manager'
import type {
  BucketClearReport,
  BucketDescriptor,
  BucketItemListReport,
  BucketSizeReport,
  ClearOptions,
  ExportPayload,
} from './components/types'

// ── Bridge 模块单例 ─────────────────────────────────────────────

/**
 * window.electron.ipcRenderer 在 preload 层注入；renderer 直接调用即可。
 * @electron-toolkit/preload 的 electronAPI.ipcRenderer.invoke 形态等价于
 * `IpcRendererInvoker`。
 */
function getInvoker(): IpcRendererInvoker | null {
  // 测试 / 服务端渲染环境兜底
  if (typeof window === 'undefined') return null
  const electron = (window as unknown as {
    electron?: { ipcRenderer?: { invoke: IpcRendererInvoker['invoke'] } }
  }).electron
  if (!electron?.ipcRenderer?.invoke) return null
  return { invoke: (channel, ...args) => electron.ipcRenderer!.invoke(channel, ...args) }
}

let _bridge: RendererStorageBridge | null = null

function getBridge(): RendererStorageBridge {
  if (_bridge) return _bridge
  const invoker = getInvoker()
  // F-1（daemon-bridge）的接入约定：先创建 bridge 占位，主进程后续
  // 通过 setDaemonStorageFetcher 注入真实 fetcher 时本桥透明接通。
  _bridge = new RendererStorageBridge({
    mainBridge: invoker ? createMainProcessBridge(invoker) : undefined,
    daemonBridge: createDaemonBridge(),
  })
  return _bridge
}

// ── 容量度量并发控制 ────────────────────────────────────────────

/**
 * 4 路并发跑 bucket size 度量。
 *
 * 取舍：
 *   - 串行 → 30 个 bucket 累计 IPC RTT 太高，UI 进面板要等 1+ 秒；
 *   - 全并发 → 同时 30+ 个 IPC handler 跑可能撞上文件系统限速；
 *   - 4 并发是经验值。
 */
async function measureSizesConcurrently(
  bucketIds: string[],
  measure: (id: string) => Promise<BucketSizeReport>,
  concurrency = 4,
): Promise<{ sizes: Map<string, BucketSizeReport>; errors: Map<string, string> }> {
  const sizes = new Map<string, BucketSizeReport>()
  const errors = new Map<string, string>()
  const queue = [...bucketIds]

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift()
      if (!id) return
      try {
        const size = await measure(id)
        sizes.set(id, size)
      } catch (err) {
        errors.set(id, err instanceof Error ? err.message : String(err))
      }
    }
  })

  await Promise.all(workers)
  return { sizes, errors }
}

// ── 视图类型 ────────────────────────────────────────────────────

/**
 * 一个 bucket 的"完整 UI 切片"——descriptor + 最近一次 size 测量。
 *
 * 字段语义：
 *   - `size === undefined` → 还没度量过 / 度量出错（UI 显示骨架或 "—"）
 *   - `sizeError` → 度量失败原因（错误态展示用，可空）
 */
export interface BucketView extends BucketDescriptor {
  size?: BucketSizeReport
  sizeError?: string
}

// ── Hook 主体 ───────────────────────────────────────────────────

export interface UseStorageDataResult {
  /** descriptor + 已度量的 size */
  views: BucketView[]
  /** descriptors 还没拉到（首次进面板时 true） */
  isLoadingBuckets: boolean
  /** sizes 还在度量中（descriptors 已就绪，但 sizeFn 还没批量跑完） */
  isMeasuring: boolean
  /** descriptors 拉取失败时的错误（IPC 异常等） */
  loadError?: string
  /** 手动触发刷新（用户点"重新计算"按钮） */
  refresh: () => Promise<void>
  /**
   * 操作回调——直接转发 RendererStorageBridge 单例。
   * 暴露在 hook 层是为了让子组件不必再 import bridge，单测时可整个 hook mock。
   */
  onClear: (id: string, options?: ClearOptions) => Promise<BucketClearReport>
  onListItems: (id: string) => Promise<BucketItemListReport>
  onExport: (id: string) => Promise<ExportPayload>
}

export function useStorageData(): UseStorageDataResult {
  const [descriptors, setDescriptors] = useState<BucketDescriptor[]>([])
  const [sizesByBucket, setSizesByBucket] = useState<Map<string, BucketSizeReport>>(
    () => new Map(),
  )
  const [sizeErrorsByBucket, setSizeErrorsByBucket] = useState<Map<string, string>>(
    () => new Map(),
  )
  const [isLoadingBuckets, setIsLoadingBuckets] = useState(true)
  const [isMeasuring, setIsMeasuring] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)

  // 卸载守卫
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const bridge = getBridge()
    setIsLoadingBuckets(true)
    setLoadError(undefined)
    try {
      // includeHidden: true — buildTopItems / index.tsx 都会自己过滤
      // hideFromList=true 的 bucket（如 *:summary-export），但 Voice 等
      // 在 FORCE_VISIBLE_BUCKET_IDS 白名单里的需要露出。带上让上层自己决定。
      const list = await bridge.listAllBuckets({ includeHidden: true })
      if (!aliveRef.current) return
      setDescriptors(list)
      setIsLoadingBuckets(false)

      setIsMeasuring(true)
      const ids = list.map((d) => d.id)
      const { sizes, errors } = await measureSizesConcurrently(
        ids,
        (id) => bridge.getBucketSize(id),
      )
      if (!aliveRef.current) return
      setSizesByBucket(sizes)
      setSizeErrorsByBucket(errors)
      setIsMeasuring(false)
    } catch (err) {
      if (!aliveRef.current) return
      setLoadError(err instanceof Error ? err.message : String(err))
      setIsLoadingBuckets(false)
      setIsMeasuring(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const views = useMemo<BucketView[]>(() => {
    return descriptors.map((d) => ({
      ...d,
      size: sizesByBucket.get(d.id),
      sizeError: sizeErrorsByBucket.get(d.id),
    }))
  }, [descriptors, sizesByBucket, sizeErrorsByBucket])

  // 操作回调——固定指向 bridge 单例，引用稳定（不依赖 state）。
  const onClear = useCallback(
    (id: string, options?: ClearOptions) => getBridge().clearBucket(id, options),
    [],
  )
  const onListItems = useCallback((id: string) => getBridge().listBucketItems(id), [])
  const onExport = useCallback((id: string) => getBridge().exportBucket(id), [])

  return {
    views,
    isLoadingBuckets,
    isMeasuring,
    loadError,
    refresh,
    onClear,
    onListItems,
    onExport,
  }
}

// ── helper：人类可读的容量字符串 ────────────────────────────────

/**
 * bytes → "1.2 GB" 之类的人类可读字符串。
 *
 * 设计取舍：
 *   - 不引入 numbro / pretty-bytes 第三方库——本场景用法窄，
 *     5 行代码自己实现避免拉依赖；
 *   - 单位用 KB / MB / GB / TB（1024 进制，符合磁盘语境），不用 KiB/MiB；
 *   - 0 字节显式返回 `'0 B'`（避免落到 NaN GB）。
 *
 * 被 components/types.ts re-export；UI 组件应从那里 import 保持单一来源。
 */
export { formatBytes } from './utils/formatBytes'
