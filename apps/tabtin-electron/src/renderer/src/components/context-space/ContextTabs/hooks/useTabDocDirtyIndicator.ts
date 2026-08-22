/**
 * useTabDocDirtyIndicator —— 标签条 dirty 指示符的订阅 hook
 *
 * 输入：ContextItem
 * 输出：
 *   - 非 tabdoc → 始终返回 null（指示符不显示）
 *   - tabdoc → 返回当前 saveState 派生的 indicator 信息（dirty / saving / error / null）
 *
 * 实现：
 *   - 用 `subscribeTabDocDirty(documentId, listener)` 订阅 registry 的变化事件
 *   - mount 时主动同步一次 snapshot（避免错过 register 时机）
 *   - 仅依赖 `documentId`，避免每次 ContextTabs render 重订阅
 *
 * 不直接 export snapshot —— 只暴露派生状态（避免组件依赖 snapshot 内部字段而难以演进）。
 */
import { useEffect, useState } from 'react'
import type { ContextItem } from '@components/context-space/registry'
import {
  getTabDocDirtySnapshot,
  shouldConfirmTabDocClose,
  subscribeTabDocDirty,
  type TabDocDirtySnapshot,
} from '@components/context-space/tabdoc/tabdocDirtyRegistry'

export type TabDocDirtyIndicatorStatus = 'dirty' | 'saving' | 'error' | 'idle'

export interface TabDocDirtyIndicatorInfo {
  /** 推断出的展示状态：dirty=普通圆点 / saving=旋转 / error=红色 / idle=不显示（一般不返回） */
  status: TabDocDirtyIndicatorStatus
  /** 是否在协作模式（未来可用于差异化文案） */
  isCollaborating: boolean
}

/**
 * 由 snapshot 派生指示符状态。
 *   - `error` 优先级最高（保存失败要明显提示）
 *   - `saving` 其次（让用户知道正在写入，关闭前会被 beforeClose 拦截）
 *   - `dirty` 普通脏标（含 isDirty=true 但 saveState=idle 的兜底情形）
 *   - 其他 → 不显示（idle）
 *
 * 抽出为纯函数方便单测；不依赖 snapshot 字段顺序。
 */
export function deriveTabDocIndicatorStatus(
  snapshot: TabDocDirtySnapshot | null,
): TabDocDirtyIndicatorStatus {
  if (!snapshot) return 'idle'
  if (snapshot.saveState === 'error') return 'error'
  if (snapshot.saveState === 'saving') return 'saving'
  // 与 shouldConfirmTabDocClose 一致：'dirty' 或 (isDirty=true && state 非 saved/saving/error)
  if (shouldConfirmTabDocClose(snapshot)) return 'dirty'
  return 'idle'
}

export function useTabDocDirtyIndicator(item: ContextItem | null): TabDocDirtyIndicatorInfo | null {
  const isTabDoc = item?.type === 'tabdoc'
  const documentId = isTabDoc ? item?.id ?? '' : ''

  const [snapshot, setSnapshot] = useState<TabDocDirtySnapshot | null>(() =>
    documentId ? getTabDocDirtySnapshot(documentId) : null,
  )

  useEffect(() => {
    if (!documentId) {
      setSnapshot(null)
      return
    }
    // 同步初始值（防止订阅错过早期 register / 切到不同 documentId 时的初值）
    setSnapshot(getTabDocDirtySnapshot(documentId))
    return subscribeTabDocDirty(documentId, snap => setSnapshot(snap))
  }, [documentId])

  if (!documentId) return null
  const status = deriveTabDocIndicatorStatus(snapshot)
  if (status === 'idle') return null
  return { status, isCollaborating: snapshot?.isCollaborating ?? false }
}
