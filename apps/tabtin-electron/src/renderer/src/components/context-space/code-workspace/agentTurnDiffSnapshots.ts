/**
 * 会话切代码根时的 diff_summary 冻结记录。
 *
 * Agent 视图不再读这里：本轮最终 Diff 走编辑工具账本（`agentTurnEditorOps`）。
 * 本 store 仍给 worktree 切换等调用方用：首次看到带 diff_summary 的 assistant
 * 时冻结当时的代码根 / 分支 / checkpoint_hash，避免旧根记录混入新根。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { normalizePathForCompare } from '@components/tabcode/utils/worktreePaths'
import { create } from 'zustand'

type DiffSummary = NonNullable<ChatMessage['diff_summary']>

export interface AgentTurnDiffSnapshot {
  messageId: string
  sessionId: string
  codeRootPath: string
  branch: string | null
  baseCommit: string | null
  createdAt: string
  diff: DiffSummary
}

interface AgentTurnDiffState {
  byMessageId: Record<string, AgentTurnDiffSnapshot>
  /** 会话最近一次切换代码根的时刻；晚于该时刻的消息才允许按「当前根」冻结，避免错绑。 */
  rootSwitchedAtBySession: Record<string, string>
  captureFromMessages: (
    sessionId: string,
    messages: ChatMessage[] | undefined,
    context: { codeRootPath: string | null; branch: string | null },
  ) => void
  markCodeRootSwitched: (sessionId: string, at?: string) => void
  listForSessionRoot: (
    sessionId: string,
    codeRootPath: string | null,
  ) => AgentTurnDiffSnapshot[]
  clearForRoot: (codeRootPath: string) => void
}

function readMessageCodeRoot(message: ChatMessage): string | null {
  const meta = message.metadata
  if (!meta || typeof meta !== 'object') return null
  const raw =
    (meta as Record<string, unknown>).code_root_path
    ?? (meta as Record<string, unknown>).bound_code_root
    ?? (meta as Record<string, unknown>).codeRootPath
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function readMessageBranch(message: ChatMessage): string | null {
  const meta = message.metadata
  if (!meta || typeof meta !== 'object') return null
  const raw =
    (meta as Record<string, unknown>).git_branch
    ?? (meta as Record<string, unknown>).branch
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function isUsableDiff(diff: ChatMessage['diff_summary']): diff is DiffSummary {
  return Boolean(diff && typeof diff.changed === 'number' && diff.changed > 0)
}

export function buildAgentTurnDiffSnapshot(
  sessionId: string,
  message: ChatMessage,
  context: { codeRootPath: string; branch: string | null },
): AgentTurnDiffSnapshot | null {
  if (!isUsableDiff(message.diff_summary)) return null
  const codeRootPath = context.codeRootPath.trim()
  if (!codeRootPath) return null
  return {
    messageId: message.id,
    sessionId,
    codeRootPath,
    branch: context.branch,
    baseCommit: typeof message.checkpoint_hash === 'string' ? message.checkpoint_hash : null,
    createdAt: message.created_at || new Date().toISOString(),
    diff: message.diff_summary,
  }
}

export const useAgentTurnDiffStore = create<AgentTurnDiffState>((set, get) => ({
  byMessageId: {},
  rootSwitchedAtBySession: {},

  markCodeRootSwitched: (sessionId, at) => {
    if (!sessionId) return
    set((state) => ({
      rootSwitchedAtBySession: {
        ...state.rootSwitchedAtBySession,
        [sessionId]: at || new Date().toISOString(),
      },
    }))
  },

  captureFromMessages: (sessionId, messages, context) => {
    if (!sessionId || !messages?.length) return
    const fallbackRoot = context.codeRootPath?.trim() || ''
    if (!fallbackRoot) return

    const switchedAt = get().rootSwitchedAtBySession[sessionId] || null
    const next: Record<string, AgentTurnDiffSnapshot> = { ...get().byMessageId }
    let changed = false
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      if (next[message.id]) continue
      if (!isUsableDiff(message.diff_summary)) continue

      const metaRoot = readMessageCodeRoot(message)
      let codeRootPath = metaRoot
      let branch = readMessageBranch(message) ?? context.branch

      if (!codeRootPath) {
        // 切根之后：只把「切根之后产生」的消息冻到新根，避免晚到旧回合错绑。
        if (switchedAt && message.created_at && message.created_at < switchedAt) {
          continue
        }
        codeRootPath = fallbackRoot
      }

      const snapshot = buildAgentTurnDiffSnapshot(sessionId, message, {
        codeRootPath,
        branch,
      })
      if (!snapshot) continue
      next[message.id] = snapshot
      changed = true
    }
    if (changed) set({ byMessageId: next })
  },

  listForSessionRoot: (sessionId, codeRootPath) => {
    if (!sessionId || !codeRootPath) return []
    const needle = normalizePathForCompare(codeRootPath)
    return Object.values(get().byMessageId)
      .filter(
        (item) =>
          item.sessionId === sessionId
          && normalizePathForCompare(item.codeRootPath) === needle,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  },

  clearForRoot: (codeRootPath) => {
    const needle = normalizePathForCompare(codeRootPath)
    if (!needle) return
    const next: Record<string, AgentTurnDiffSnapshot> = {}
    for (const [id, item] of Object.entries(get().byMessageId)) {
      if (normalizePathForCompare(item.codeRootPath) !== needle) {
        next[id] = item
      }
    }
    set({ byMessageId: next })
  },
}))
