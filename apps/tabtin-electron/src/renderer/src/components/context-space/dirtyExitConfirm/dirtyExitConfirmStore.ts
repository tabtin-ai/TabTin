/**
 * 退出 / 删除 Space 时的"合并 dirty 对话框"状态机
 *
 * 与 tab 级 close-confirm（tabdocCloseConfirm）的区别：
 * - tab 级：每次关一个 tab 弹一次，并发关 N 个会连续 FIFO 弹 N 次
 * - 退出级：把所有 dirty 资源**列**在同一个对话框里，让用户一次决策
 *           （"全部保存 / 全部放弃 / 取消"），避免被对话框轰炸
 *
 * 触发点（W2.5 T9）：
 * - Main 进程 before-quit 拦截 → exitGuardListener 弹此对话框
 * - 本地 UI 删除 Space → SpaceManagementView / SpaceSettingsPane 调
 *   confirmDirtyBeforeSpaceDelete → 弹此对话框
 *
 * 注意：WS push 'deleted'（其他端/管理员删除）路径**不弹**对话框（无用户交互上下文），
 * 由 adapters/app-shell-init.ts::onSpaceDeleted 自动调 saveAllDirty 兜底
 *
 * 设计：
 * - 单例：同一时刻只允许一个退出对话框在飞，重复调用直接返回当前 promise
 *   （avoid 用户疯狂按 ⌘Q 时叠出多个 host）
 * - reason 字段 'app-quit' / 'space-delete' 让 Host 切换标题与按钮文案
 * - progress 字段在 saving 阶段实时更新，UI 显示"正在保存 3 / 5..."
 */
import { create } from 'zustand'
import type { DirtyResource } from '../dirtyRegistry'

export type DirtyExitChoice = 'save-all' | 'discard' | 'cancel'

export type DirtyExitReason = 'app-quit' | 'space-delete' | 'window-close' | 'app-relaunch'

export interface DirtyExitConfirmResult {
  choice: DirtyExitChoice
  /** 仅 choice='save-all' 时有意义；记录每条资源的保存结果，调用方决定如何提示 */
  saveResults?: Array<{ resource: DirtyResource; ok: boolean }>
}

export interface DirtyExitProgress {
  done: number
  total: number
  /** 当前正在保存的资源标题，UI 显示用 */
  currentTitle: string
}

/**
 * 'idle'    — 无 active 对话框
 * 'awaiting' — 对话框已展示，等用户三选
 * 'saving'  — 用户选了"全部保存"，正在串行 saveAllDirty；按钮禁用
 *
 * 注：'done' 状态在早期设计中预留，实际 settle 后 store 直接重置为 'idle'，已删除。
 */
export type DirtyExitPhase = 'idle' | 'awaiting' | 'saving'

interface DirtyExitConfirmState {
  open: boolean
  /** 待确认的资源列表（已经过 dedupe，可能为空 —— 见 requestDirtyExitConfirm） */
  resources: readonly DirtyResource[]
  reason: DirtyExitReason
  /** 关联的 spaceId / spaceName（删 space 场景显示，'app-quit' 场景为 null） */
  spaceName: string | null
  phase: DirtyExitPhase
  progress: DirtyExitProgress | null
}

const initialState: DirtyExitConfirmState = {
  open: false,
  resources: [],
  reason: 'app-quit',
  spaceName: null,
  phase: 'idle',
  progress: null,
}

export const useDirtyExitConfirmStore = create<DirtyExitConfirmState>(() => initialState)

let activeResolve: ((result: DirtyExitConfirmResult) => void) | null = null

export interface RequestDirtyExitConfirmParams {
  resources: readonly DirtyResource[]
  reason: DirtyExitReason
  /** 删 Space 场景的 space 名（用于对话框副标题） */
  spaceName?: string | null
}

/**
 * 唤起合并对话框；resources 为空数组时立即 resolve('discard')
 * （没东西要保存，相当于"无 dirty 直接退"，由调用方决定语义）。
 *
 * 重复调用：
 * - 已有对话框开启 → 返回新 promise，但不替换 active resolve（避免丢失第一个调用方）。
 *   实际产品场景：同时触发 ⌘Q + delete-space 几乎不可能；如果发生第二个调用方
 *   会拿到与第一个一样的结果。这是有意为之的简化（用户对第二个上下文也已表态）。
 */
export function requestDirtyExitConfirm(
  params: RequestDirtyExitConfirmParams,
): Promise<DirtyExitConfirmResult> {
  return new Promise((resolve) => {
    // 空列表 → 直接 discard（调用方继续退出 / 删除）
    if (params.resources.length === 0) {
      resolve({ choice: 'discard' })
      return
    }
    if (activeResolve) {
      // 已有对话框，挂起新调用，等当前对话框 settle 时一并 resolve
      const prevResolve = activeResolve
      activeResolve = (result) => {
        prevResolve(result)
        resolve(result)
      }
      return
    }
    activeResolve = resolve
    useDirtyExitConfirmStore.setState({
      open: true,
      resources: [...params.resources],
      reason: params.reason,
      spaceName: params.spaceName ?? null,
      phase: 'awaiting',
      progress: null,
    })
  })
}

/**
 * 设置进度（saveAllDirty 的 onProgress 回调用）。
 * 仅在 phase='saving' 时有效，其他阶段静默忽略。
 */
export function setDirtyExitConfirmProgress(progress: DirtyExitProgress | null): void {
  useDirtyExitConfirmStore.setState((state) => {
    if (state.phase !== 'saving') return {}
    return { progress }
  })
}

/**
 * 把 phase 切到 'saving'（用户点了"全部保存"，进入保存中状态）。
 * 此时按钮应禁用，防止用户重复点；ESC 也忽略（不能取消进行中的保存）。
 */
export function markDirtyExitConfirmSaving(): void {
  useDirtyExitConfirmStore.setState({ phase: 'saving' })
}

/**
 * Settle 当前对话框。
 *
 * @param choice 用户选择的最终结果
 * @param saveResults 仅 choice='save-all' 时传入；记录每条资源保存结果
 */
export function settleDirtyExitConfirm(
  choice: DirtyExitChoice,
  saveResults?: Array<{ resource: DirtyResource; ok: boolean }>,
): void {
  if (!activeResolve) return
  const resolve = activeResolve
  activeResolve = null
  useDirtyExitConfirmStore.setState({ ...initialState })
  resolve({ choice, saveResults })
}

/** 测试用 —— 重置内部状态 */
export function _resetDirtyExitConfirm(): void {
  activeResolve = null
  useDirtyExitConfirmStore.setState({ ...initialState })
}

/** 测试用 —— 是否有 active 对话框（pending） */
export function _isDirtyExitConfirmActive(): boolean {
  return activeResolve !== null
}
