/**
 * terminalSplitActions - 分屏创建/关闭的共享逻辑
 *
 * 从 TerminalSplitContainer 和 TerminalPaneHeader 中抽取，
 * 消除重复代码（ER-13 + ER-14）。
 */

import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import {
  useTerminalSessionStore,
  killPtySession,
} from '@components/context-space/sources/terminal'
import { useTerminalPaneStatusStore } from '@stores/useTerminalPaneStatusStore'
import { destroyTerminalSession } from '@components/terminal/terminalRegistry'
import type { SplitDirection, SplitSide } from '@/utils/split-layout'

// B2: 防重入守卫——正在关闭中的 sessionId 集合
const closingSessions = new Set<string>()

// B2: kill 超时上限，防止 IPC 挂起导致 dispose 永远不执行
const KILL_TIMEOUT_MS = 5000

/**
 * 创建分屏 session 并插入到布局树中。
 *
 * @returns 新创建的 paneId，如果创建失败返回 null
 */
export function createSplitPane(opts: {
  rootSessionId: string
  targetPaneId: string
  direction: SplitDirection
  side: SplitSide
  /**
   * 标签桶 key（Phase 4 起可能是 desktop/conversation scope 或真实 spaceId）。
   * 由 TerminalSplitContainer 的 resolvedSpaceId 跨桶解析得到——sub-pane 落进与
   * root 相同的桶，保证 split 在 scope 化后仍一致。
   */
  spaceId: string
  defaultTitle: string
  inheritFromSessionId?: string
}): string | null {
  const { rootSessionId, targetPaneId, direction, side, spaceId, defaultTitle, inheritFromSessionId } = opts

  // sessionId 不能内嵌桶 key——scope 桶 key 含冒号，会污染以 sessionId 命名的快照文件。
  // 用无冒号的唯一 id（桶归属由 addSpaceSession 的 key 参数决定，不靠 id 编码）。
  const newSessionId = `terminal-split-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const sessionStore = useTerminalSessionStore.getState()

  // 继承当前 pane 的 cwd 与执行 Space 绑定（executionSpaceId），保证分屏 pane 的 PTY
  // 与 root 在同一 working_dir / 同一 TABTIN_SPACE_ID 下起。
  const parent = inheritFromSessionId
    ? sessionStore.sessionsBySpace[spaceId]?.find(s => s.id === inheritFromSessionId)
    : undefined
  sessionStore.addSpaceSession(
    spaceId,
    newSessionId,
    defaultTitle,
    'user',
    parent?.cwd,
    parent?.executionSpaceId,
  )

  return useTerminalSplitStore
    .getState()
    .splitPane(rootSessionId, targetPaneId, direction, side, newSessionId)
}

/**
 * 关闭一个分屏 pane：kill PTY、从布局树中移除、清理状态。
 *
 * 时序保证（B2 修复）：
 *   1. 防重入守卫——同一 session 不会被并发关闭
 *   2. 立即更新 UI 状态（closePane / removeStatus / removeSession），保证用户体感即时
 *   3. 等待 killPtySession 完成（带超时），确保 PTY 进程被杀死后再 dispose
 *   4. dispose 终端实例——幂等，Portal 层延迟清理若先于此执行也安全
 */
export function closeSplitPane(opts: {
  rootSessionId: string
  paneId: string
  sessionId: string
  spaceId: string
}): void {
  const { rootSessionId, paneId, sessionId, spaceId } = opts

  // B2-1: 防重入——快速双击关闭同一 session 时忽略后续调用
  if (closingSessions.has(sessionId)) return
  closingSessions.add(sessionId)

  // B2-2: 立即更新 UI 状态，让用户看到 pane 消失
  useTerminalSplitStore.getState().closePane(rootSessionId, paneId)
  useTerminalPaneStatusStore.getState().removeStatus(sessionId)
  if (sessionId !== rootSessionId) {
    useTerminalSessionStore.getState().removeSpaceSession(spaceId, sessionId)
  }

  // B2-3: kill PTY → 等待确认 → 再 dispose（与 handleRestartPane 保持一致的时序）
  // 使用 timeout 兜底，防止 IPC 挂起导致永远不 dispose
  Promise.race([
    killPtySession(sessionId),
    new Promise<void>(resolve => setTimeout(resolve, KILL_TIMEOUT_MS)),
  ])
    .catch(() => {})
    .finally(() => {
      try {
        destroyTerminalSession(sessionId)
      } catch (err) {
        console.warn('[terminalSplitActions] destroyTerminalSession failed:', sessionId, err)
      }
      closingSessions.delete(sessionId)
    })
}

/** 检查某 session 是否正在 closeSplitPane 的 kill→dispose 流程中 */
export function isSessionClosing(sessionId: string): boolean {
  return closingSessions.has(sessionId)
}
