/**
 * openSubagentTab — 子 Agent 详情 tab 的统一打开入口（PRD §4.6 / §4.7 / §4.14）。
 *
 * 让 caller（SubagentProgressCard / SubagentAggregateView / SubagentDetailPane
 *「在工作台标签打开」按钮）只看一份 API：
 *   → 直接调 `useSpaceContextTabsStore.getState().openResourceTab(spaceId, ...)`
 *   → 注意 spaceId 必须由 caller 用 useSpaceIdForSession 解析后传入（不依赖 URL）
 *
 * `silent` 语义（PRD §4.14 决策 13 / 红线 #10）：
 *   透传给 openResourceTab，dedup 命中时也不改 active。
 */

import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { resolveWorkspaceContextState } from '@components/layout/workspaceContextState'
import type { SubagentSessionMeta } from '@/stores/contextTabs/types'
import { logger } from '@/utils/logger'

/**
 * 解析 subagent tab 应落入的 UI 标签 scope（桌面 / 对话 / Space 边界 Phase 2）。
 *
 * 前台工作台标签按 scope（desktop 共享池 / `conversation:{sessionId}`）读取（见
 * useTabSync / SpaceContextContainer 的 effectiveTabScopeKey）。若 subagent drill-in
 * 仍按 legacy `spaceId` 写入标签桶，会出现「点『在工作台打开完整对话』但标签不出现 /
 * active 不变」的静默失效。这里复用 AppLayout 同款 `resolveWorkspaceContextState`，按该
 * Space 当前 foreground 的 sidebarMode + 当前 session 算出 scope key，与前台读取口径对齐。
 *
 * 注意：运行载体仍 per-Space（Phase 3/4），本函数只决定「标签落哪个桶」，不影响载体归属。
 */
export function resolveForegroundTabScopeKey(
  spaceId: string | null | undefined,
  sessionIdOverride?: string | null,
): string {
  if (!spaceId) return ''
  try {
    const spaceState = useSpaceStore.getState()
    const selected = spaceState.selectedSpace
    const space = spaceState.spaces.find(s => s.id === spaceId)
      ?? (selected?.id === spaceId ? selected : null)
    // 列表尚未水合时，用当前选中 Space 的 org，避免落成 desktop:…:unknown-organization。
    const organizationId = space?.organization_id
      ?? (selected?.id === spaceId ? selected.organization_id : null)
      ?? null
    const userId = useAuthStore.getState().user?.id ?? null
    const sidebarMode = useSpaceViewPrefsStore.getState().getSidebarMode(organizationId, userId, spaceId)
    const currentSessionId = sessionIdOverride === undefined
      ? useChatStore.getState().currentSessionId
      : sessionIdOverride
    const ctx = resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode,
      organizationId,
      userId,
      executionSpaceId: spaceId,
      sessionId: currentSessionId,
    })
    return ctx.kind === 'non-space' ? spaceId : ctx.key
  } catch {
    return spaceId
  }
}

/**
 * 打开内置浏览器 / ResourceRouter 落点用的 tab scope。
 *
 * 前台工作台读 `desktop:` / `conversation:` 桶；若调用方仍传 legacy 裸 `spaceId`
 *（或未传 scope），会把 view 建进 `cs-scope-<uuid>`，再 `setActiveKey(uuid, tabweb:…)`，
 * 出现「key not in tabOrder」且用户看不见标签。
 *
 * 规则：空 / 等于 spaceId 的 legacy 桶 → 升到 `resolveForegroundTabScopeKey`；
 * 已是 desktop:/conversation: 等显式 scope 则原样使用。
 */
export function resolveBrowserOpenTabScopeKey(
  spaceId: string | null | undefined,
  tabScopeKey?: string | null,
): string {
  if (!spaceId) return (tabScopeKey || '').trim()
  const foreground = resolveForegroundTabScopeKey(spaceId) || spaceId
  const raw = (tabScopeKey || '').trim()
  if (!raw) return foreground
  if (raw === spaceId && foreground !== spaceId) return foreground
  return raw
}

export interface OpenSubagentTabParams {
  parentSessionId: string
  subagentRunId: string
  /** 子 Agent 身份名（caller 算好的 speaker.display_name / role / label）——tab 标题 + Pane header 首选。 */
  displayName?: string
  label?: string
  task?: string
  parentToolCallId?: string
  speakerId?: string
  /** openResourceTab 用的 spaceId。caller 需用 useSpaceIdForSession 解析后传入。 */
  spaceId: string | null
  silent?: boolean
}

export type OpenSubagentTabResult =
  | { ok: true }
  | { ok: false; reason: 'no_space_id' | 'invalid_payload' }

const buildTabTitle = (params: OpenSubagentTabParams): string => {
  // 优先「身份名」：displayName（speaker.display_name / role / label 算好的）→ label。
  // **不用 task**——那是主 Agent 下达的指令 prompt，长且不是名字。
  if (params.displayName && params.displayName.trim().length > 0) return params.displayName.trim()
  if (params.label && params.label.trim().length > 0) return params.label.trim()
  return `Subagent ${params.subagentRunId.slice(0, 8)}`
}

const buildMeta = (params: OpenSubagentTabParams): SubagentSessionMeta => ({
  kind: 'subagent_session',
  parentSessionId: params.parentSessionId,
  ...(params.parentToolCallId ? { parentToolCallId: params.parentToolCallId } : {}),
  ...(params.displayName ? { displayName: params.displayName } : {}),
  ...(params.label ? { label: params.label } : {}),
  ...(params.task ? { task: params.task } : {}),
  ...(params.speakerId ? { speakerId: params.speakerId } : {}),
})

/**
 * 统一打开入口。同步 set 后立即 resolve（保留 Promise 返回以兼容既有 await / then 调用方）。
 *
 * 用法：
 * ```ts
 * const result = await openSubagentTab({ parentSessionId, subagentRunId, spaceId, ... })
 * if (!result.ok) {
 *   // reason: 'no_space_id' | 'invalid_payload'——均为调用方参数缺失，属开发期问题
 * }
 * ```
 */
export async function openSubagentTab(params: OpenSubagentTabParams): Promise<OpenSubagentTabResult> {
  if (!params.parentSessionId || !params.subagentRunId) {
    return { ok: false, reason: 'invalid_payload' }
  }

  if (!params.spaceId) {
    logger.warn('[openSubagentTab] missing spaceId', {
      parentSessionId: params.parentSessionId,
      subagentRunId: params.subagentRunId,
    })
    return { ok: false, reason: 'no_space_id' }
  }

  // 点击入口已经携带权威的父会话，不能再用可能属于另一侧栏现场的全局 currentSessionId。
  const tabScopeKey = resolveForegroundTabScopeKey(params.spaceId, params.parentSessionId)
  useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
    type: 'subagent_session',
    id: params.subagentRunId,
    title: buildTabTitle(params),
    meta: buildMeta(params),
    ...(params.silent ? { silent: true } : {}),
  })
  // 前台打开必须把右侧工作台从 chat-focus 折叠态拉回可见；silent 预创建仍保持
  // 不抢焦点、不改变用户布局。复用 tab 的同一 scope，避免展开到别的会话画布。
  if (!params.silent) {
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(tabScopeKey, false)
  }
  logger.info('[openSubagentTab] opened', {
    parentSessionId: params.parentSessionId,
    subagentRunId: params.subagentRunId,
    tabScopeKey,
    expandedCanvas: !params.silent,
  })
  return { ok: true }
}
