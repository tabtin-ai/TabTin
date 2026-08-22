/**
 * TabDoc 关闭确认浮层 —— Promise + zustand store 桥接，FIFO 队列。
 *
 * 模式参考 `tabPhoneCloseConfirm.ts`，但对话框三选项：
 *   - cancel  → 不关闭
 *   - discard → 关闭并丢弃本地未保存内容
 *   - save    → 触发 manualSave，成功后关闭，失败由调用方 toast 提示
 *
 * ESC / 点遮罩 → 视为 cancel（"默认不丢数据"原则）。
 *
 * 队列设计（W2 T5 三视角 Review 修复）：
 * `useCloseHandlers.batchClose` 用 Promise.all 并发对每个 tab 调
 * `dispatchBeforeClose`，会同时多次 `requestTabDocCloseConfirm`。
 * 早期实现里"后请求 cancel 前请求"会让用户对前一篇文档**从未见过**对话框就被
 * 当作"取消"处理 —— 既丢失"明确确认"语义又难以复现。改为 FIFO 队列后：
 * - 同一时刻只展示一个对话框
 * - 用户对当前文档做出选择后立即把队列中下一个 pop 出来展示
 * - 每个 documentId 都有机会被用户明确处置
 *
 * 仍然存在的限制（归入总控遗留项，未来 Wave 解决）：
 * 多 dirty tab 批量关闭时会**连续**弹 N 次对话框，理想 UX 应是"列表勾选 +
 * 一次操作"的合并对话框；本次只确保数据安全不丢失，UI 体验留待后续打磨。
 */
import { create } from 'zustand'

export type TabDocCloseChoice = 'cancel' | 'discard' | 'save'

interface TabDocCloseConfirmState {
  open: boolean
  /** 文档显示名（标题）；为空时由 Host 用 untitled fallback */
  displayName: string
  /** 队列中等待中的请求数（含当前展示的那个），UI 可以选择性展示"还有 N 个待确认" */
  pendingCount: number
}

export const useTabDocCloseConfirmStore = create<TabDocCloseConfirmState>(() => ({
  open: false,
  displayName: '',
  pendingCount: 0,
}))

interface PendingRequest {
  displayName: string
  resolve: (choice: TabDocCloseChoice) => void
}

const queue: PendingRequest[] = []
let active: PendingRequest | null = null

function presentNext(): void {
  const next = queue.shift()
  if (!next) {
    active = null
    useTabDocCloseConfirmStore.setState({ open: false, displayName: '', pendingCount: 0 })
    return
  }
  active = next
  useTabDocCloseConfirmStore.setState({
    open: true,
    displayName: next.displayName,
    pendingCount: queue.length + 1,
  })
}

export function requestTabDocCloseConfirm(displayName: string): Promise<TabDocCloseChoice> {
  return new Promise((resolve) => {
    queue.push({ displayName, resolve })
    if (!active) {
      presentNext()
    } else {
      // 已有展示中的请求，仅刷新计数让 Host 可显示"还有 N 个待确认"
      useTabDocCloseConfirmStore.setState({ pendingCount: queue.length + 1 })
    }
  })
}

export function settleTabDocCloseConfirm(choice: TabDocCloseChoice): void {
  if (!active) return
  const settled = active
  active = null
  presentNext()
  // 在 presentNext 之后再 resolve，避免上层同步链路重新 register 时把队列状态扰乱。
  settled.resolve(choice)
}

/** 测试用 —— 重置内部状态 */
export function _resetTabDocCloseConfirm(): void {
  queue.length = 0
  active = null
  useTabDocCloseConfirmStore.setState({ open: false, displayName: '', pendingCount: 0 })
}

/** 测试用 —— 当前队列长度（含展示中的） */
export function _getTabDocCloseConfirmQueueSize(): number {
  return queue.length + (active ? 1 : 0)
}
