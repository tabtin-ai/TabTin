/**
 * useCloseAnimation —— ContextTabs 关闭动画状态机
 *
 * 设计目标：
 * 1. 用户点 X 时**视觉立刻**开始收起（max-width / opacity / padding 一起收到 0），
 *    不等业务流程（dispatchBeforeClose / dispatchClose 可能有 dialog / 网络）完成
 * 2. 业务流程通过、items 中该 tab 消失时，phantom 接管最后的过渡，DOM 在
 *    `durationMs` 后真正 unmount
 * 3. 业务流程被 beforeClose 阻止（item 仍在 items 里），等 `cancelTimeoutMs` 后
 *    撤销 closing 标记 → CSS 反向回弹
 * 4. 外部直接关闭（⌘W / 中键 / 右键菜单）：items 突然减少，hook 也要把消失的
 *    item 自动转为 phantom 播 leave 动画（用户用键盘也能看到平滑收起）
 *
 * 三种"在 DOM 里"的来源：
 *   - alive items（来自 props.items）
 *   - phantom items（已从 items 消失但仍在 leave 动画中，期满 unmount）
 *   - 已 alive 但用户主动点击 X 触发 closing 标记的（视觉先行）
 *
 * 与业务解耦：本 hook 不调用 onCloseItem，只暴露 `requestClose(item, performClose)`，
 * `performClose` 由父组件包装真正的关闭动作（onCloseItem(item) 等）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContextItem } from '@components/context-space/registry'

interface PhantomEntry {
  item: ContextItem
  /** 消失前在 items 数组里的 0-based index（保留用于排序兜底） */
  lastIndex: number
  /**
   * 消失前**紧邻的前一个**未折叠 tabKey；null 表示它本身是首个 item。
   *
   * 为什么不直接用 lastIndex？
   *   orchestrator 渲染时会把同一 canvas group 的多个 item 折叠成单个 GroupTab slot，
   *   slot 序列长度通常 ≠ items 长度。Triple Review 第 3 视角 P0：直接拿 items 索引
   *   插入 slot 列表，在分屏 + 关闭场景下 phantom 位置会错位。
   *
   * 改用 tabKey 锚点：orchestrator 渲染时找到该 tabKey 对应的 slot 位置，
   * 在它**后面**插入 phantom。前邻居本身也消失（也是 phantom）时按 lastIndex 排序
   * 兜底（递归追溯成本太高，且 phantom 通常只持续 ~120ms，错 1 个位置可接受）。
   */
  predecessorTabKey: string | null
}

interface UseCloseAnimationOptions {
  /** CSS transition 时长（ms），同时也是 phantom 在 DOM 里保留的时长 */
  durationMs?: number
  /** 用户点 X 后，等多久判定 beforeClose 是否阻止以决定回弹（默认 durationMs * 3） */
  cancelTimeoutMs?: number
}

interface UseCloseAnimationResult {
  /** 给定 tabKey 当前是否处于"closing"视觉态（应用 closing className） */
  isClosing: (tabKey: string) => boolean
  /** 已从 items 消失但仍在播放 leave 动画的 items（带 lastIndex 用于排序） */
  phantomItems: PhantomEntry[]
  /**
   * 用户主动请求关闭某 tab。
   * - 立刻把 tabKey 加入 closing 集合（视觉收起）
   * - 立刻调用 performClose（业务流程）
   * - cancelTimeoutMs 后若该 tab 仍在 items 里且未进入 phantom（说明 beforeClose 阻止），
   *   自动从 closing 集合移除 → CSS 反向回弹
   */
  requestClose: (item: ContextItem, performClose: () => void) => void
}

const DEFAULT_DURATION_MS = 120

export function useCloseAnimation(
  items: readonly ContextItem[],
  options: UseCloseAnimationOptions = {},
): UseCloseAnimationResult {
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS
  const cancelTimeoutMs = options.cancelTimeoutMs ?? durationMs * 3

  const [closingKeys, setClosingKeys] = useState<Set<string>>(() => new Set())
  const [phantomMap, setPhantomMap] = useState<Map<string, PhantomEntry>>(() => new Map())

  // 用 ref 持有最新 items，requestClose 的 setTimeout 回调里需要无 stale closure 地判断
  const itemsRef = useRef(items)
  itemsRef.current = items

  // phantom unmount 定时器
  const phantomTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // requestClose 的"是否需要回弹"判定定时器
  const cancelTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 上一轮 items 快照，用来识别"消失"的 keys 与它们的 lastIndex
  const prevItemsRef = useRef<readonly ContextItem[]>(items)
  // phantomMap 的 ref 镜像，让 reuse 检测无需把 phantomMap 放进 effect deps
  const phantomMapRef = useRef(phantomMap)
  phantomMapRef.current = phantomMap

  // Effect A：仅监听 items diff（添加 phantom + 注册 unmount 定时器）。
  // 拆出来的目的：避免依赖 phantomMap 导致 setPhantomMap → effect 重跑 → 再次 diff 的浪费循环。
  // Triple Review 第 3 视角 P0：reducer 会更优雅，但当前正确性已被 12 条单测锁定，
  // 本次仅做"effect 拆分 + ref 解耦"的最小重构。
  useEffect(() => {
    const prevItems = prevItemsRef.current
    const currentKeys = new Set<string>()
    items.forEach(item => currentKeys.add(item.tabKey))

    // 找出"上一轮在但本轮不在"的 items → 转为 phantom；记录每个 lost item 的前邻居 tabKey
    const lostItemsWithMeta: Array<{
      item: ContextItem
      lastIndex: number
      predecessorTabKey: string | null
    }> = []
    prevItems.forEach((item, idx) => {
      if (!currentKeys.has(item.tabKey)) {
        const predecessor = idx > 0 ? prevItems[idx - 1] : null
        lostItemsWithMeta.push({
          item,
          lastIndex: idx,
          predecessorTabKey: predecessor?.tabKey ?? null,
        })
      }
    })

    if (lostItemsWithMeta.length > 0) {
      setPhantomMap(prev => {
        const next = new Map(prev)
        lostItemsWithMeta.forEach(({ item, lastIndex, predecessorTabKey }) => {
          // 若同 tabKey 已有 phantom 则保留更早的 entry（避免重复 close 时位置反复跳）
          if (!next.has(item.tabKey)) {
            next.set(item.tabKey, { item, lastIndex, predecessorTabKey })
          }
        })
        return next
      })
      setClosingKeys(prev => {
        const next = new Set(prev)
        lostItemsWithMeta.forEach(({ item }) => next.add(item.tabKey))
        return next
      })

      // 注册 phantom 的 unmount 定时器
      lostItemsWithMeta.forEach(({ item }) => {
        const tabKey = item.tabKey
        const oldTimer = phantomTimersRef.current.get(tabKey)
        if (oldTimer) clearTimeout(oldTimer)
        const timer = setTimeout(() => {
          phantomTimersRef.current.delete(tabKey)
          setPhantomMap(prev => {
            if (!prev.has(tabKey)) return prev
            const next = new Map(prev)
            next.delete(tabKey)
            return next
          })
          setClosingKeys(prev => {
            if (!prev.has(tabKey)) return prev
            const next = new Set(prev)
            next.delete(tabKey)
            return next
          })
        }, durationMs)
        phantomTimersRef.current.set(tabKey, timer)
      })
    }

    prevItemsRef.current = items
  }, [items, durationMs])

  // Effect B：监听 items 与 phantomMap 同时变化，处理 reopen（已 phantom 又出现在 items 里）。
  // reused 场景下 phantomMap 必然 size>0，把判断短路在前能让大部分 render 早退；
  // 用 phantomMapRef.current 读快照，避免依赖 phantomMap 导致循环更新。
  useEffect(() => {
    if (phantomMapRef.current.size === 0) return
    const currentKeys = new Set<string>()
    items.forEach(item => currentKeys.add(item.tabKey))

    const reusedKeys: string[] = []
    phantomMapRef.current.forEach((_, key) => {
      if (currentKeys.has(key)) reusedKeys.push(key)
    })
    if (reusedKeys.length === 0) return

    setPhantomMap(prev => {
      let changed = false
      const next = new Map(prev)
      reusedKeys.forEach(k => {
        if (next.delete(k)) changed = true
      })
      return changed ? next : prev
    })
    setClosingKeys(prev => {
      let changed = false
      const next = new Set(prev)
      reusedKeys.forEach(k => {
        if (next.delete(k)) changed = true
      })
      return changed ? next : prev
    })
    reusedKeys.forEach(k => {
      const t = phantomTimersRef.current.get(k)
      if (t) {
        clearTimeout(t)
        phantomTimersRef.current.delete(k)
      }
    })
  }, [items, phantomMap])

  const requestClose = useCallback(
    (item: ContextItem, performClose: () => void) => {
      const tabKey = item.tabKey

      // 立即标记 closing（视觉立刻开始收起）
      setClosingKeys(prev => {
        if (prev.has(tabKey)) return prev
        const next = new Set(prev)
        next.add(tabKey)
        return next
      })

      // 立即触发业务流程（dispatchBeforeClose 可能立刻弹对话框；不阻塞）
      try {
        performClose()
      } catch (err) {
        console.warn('[useCloseAnimation] performClose threw:', err)
      }

      // 注册"回弹判定"定时器：cancelTimeoutMs 后若 item 仍在 alive items 里 ∧ 未进入 phantom
      // → 视为 beforeClose 阻止 → 撤销 closing 标记 → CSS 反向回弹
      const oldTimer = cancelTimersRef.current.get(tabKey)
      if (oldTimer) clearTimeout(oldTimer)
      const timer = setTimeout(() => {
        cancelTimersRef.current.delete(tabKey)
        const stillAlive = itemsRef.current.some(i => i.tabKey === tabKey)
        const isPhantom = phantomTimersRef.current.has(tabKey)
        if (stillAlive && !isPhantom) {
          setClosingKeys(prev => {
            if (!prev.has(tabKey)) return prev
            const next = new Set(prev)
            next.delete(tabKey)
            return next
          })
        }
      }, cancelTimeoutMs)
      cancelTimersRef.current.set(tabKey, timer)
    },
    [cancelTimeoutMs],
  )

  // 卸载时清理所有定时器。React 的 ref 引用本身在组件存活期内稳定，
  // 显式拷贝一份本地引用是为了让 react-hooks/exhaustive-deps 不再警告，
  // 同时防止 cleanup 时 ref.current 被某个未捕获的逻辑替换。
  useEffect(() => {
    const phantomTimers = phantomTimersRef.current
    const cancelTimers = cancelTimersRef.current
    return () => {
      phantomTimers.forEach(t => clearTimeout(t))
      phantomTimers.clear()
      cancelTimers.forEach(t => clearTimeout(t))
      cancelTimers.clear()
    }
  }, [])

  const phantomItems = useMemo(() => {
    return Array.from(phantomMap.values())
  }, [phantomMap])

  const isClosing = useCallback(
    (tabKey: string) => closingKeys.has(tabKey),
    [closingKeys],
  )

  return { isClosing, phantomItems, requestClose }
}
