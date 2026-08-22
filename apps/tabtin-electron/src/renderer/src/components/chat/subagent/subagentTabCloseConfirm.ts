/**
 * subagent tab 关闭确认浮层（PRD §4.10）—— 仿 tabdocCloseConfirm.ts 形态。
 *
 * 触发场景：running / queued 状态的 subagent_session tab 点 × 时由
 * handler.beforeClose 调起，弹"关闭标签不会停止子 Agent"确认对话框。
 * completed / failed / cancelled 等终态直接关，不弹窗。
 *
 * FIFO 队列：批量关 tab 时多个并发请求按顺序展示，每个都给用户明确处置机会。
 *
 * 二选交互（与 tabdoc 三选区分）：
 *   - keep   → 保留标签，不关闭
 *   - close  → 关闭标签（不停止子 Agent；要停止用户需先按 Pane 内 cancel 按钮）
 *
 * ESC / 点遮罩 → 视为 'keep'（保守默认）。
 */

import { create } from 'zustand'

export type SubagentTabCloseChoice = 'keep' | 'close'

interface SubagentTabCloseConfirmState {
  open: boolean
  /** 子 Agent 显示名（label || task 截断 || run id 短码） */
  displayName: string
  /** 队列中等待中的请求数（含当前展示的那个） */
  pendingCount: number
}

export const useSubagentTabCloseConfirmStore = create<SubagentTabCloseConfirmState>(() => ({
  open: false,
  displayName: '',
  pendingCount: 0,
}))

interface PendingRequest {
  displayName: string
  resolve: (choice: SubagentTabCloseChoice) => void
}

const queue: PendingRequest[] = []
let active: PendingRequest | null = null

function presentNext(): void {
  const next = queue.shift()
  if (!next) {
    active = null
    useSubagentTabCloseConfirmStore.setState({ open: false, displayName: '', pendingCount: 0 })
    return
  }
  active = next
  useSubagentTabCloseConfirmStore.setState({
    open: true,
    displayName: next.displayName,
    pendingCount: queue.length + 1,
  })
}

export function requestSubagentTabCloseConfirm(displayName: string): Promise<SubagentTabCloseChoice> {
  return new Promise((resolve) => {
    queue.push({ displayName, resolve })
    if (!active) {
      presentNext()
    } else {
      useSubagentTabCloseConfirmStore.setState({ pendingCount: queue.length + 1 })
    }
  })
}

export function settleSubagentTabCloseConfirm(choice: SubagentTabCloseChoice): void {
  if (!active) return
  const settled = active
  active = null
  presentNext()
  settled.resolve(choice)
}

/** 测试用 —— 重置内部状态 */
export function _resetSubagentTabCloseConfirm(): void {
  queue.length = 0
  active = null
  useSubagentTabCloseConfirmStore.setState({ open: false, displayName: '', pendingCount: 0 })
}

/** 测试用 —— 当前队列长度（含展示中的） */
export function _getSubagentTabCloseConfirmQueueSize(): number {
  return queue.length + (active ? 1 : 0)
}
