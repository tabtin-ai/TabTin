/**
 * Space / 组织切换后，决定全局 currentSessionId 与当前 Space 记忆如何对齐。
 *
 * Wave 3：切组织不清整份 chat store；靠 currentSessionIdBySpaceId 记忆。
 * 展示仍读全局 currentSessionId，因此进入新 Space 时必须显式 draft / restore，
 * 否则会出现「页签已换、正文仍是旧组织会话」的串台。
 *
 * 纯函数：无副作用、不读 store —— 副作用编排见同目录 `reconcileSpacePointer.ts`。
 */

import { isLocalPendingSessionId } from './actions/pendingFirstSend'

export type SpaceSessionPointerAction =
  | { type: 'noop' }
  | { type: 'draft' }
  | { type: 'restore'; sessionId: string }

export interface SpaceSessionPointerInput {
  globalCurrentSessionId: string | null
  /** currentSessionIdBySpaceId[spaceId] */
  rememberedSessionId: string | null
  inDraft: boolean
  /** 当前 Space 主会话列表（sessionsBySpaceId） */
  spaceSessions: ReadonlyArray<{ id: string }>
  /** Tracker Run 分桶（可不在主列表） */
  trackerRunSessions: ReadonlyArray<{ id: string }>
  /**
   * 面板可见会话（organization scope 下为 org 内合并列表）。
   *  起「无记忆保持」只认本 Space 桶；此字段保留给调用方兼容，resolve 不再依赖它做 noop。
   */
  visibleSessions?: ReadonlyArray<{ id: string }>
  /** sessionsBySpaceId 是否已有该 Space 的桶（含空数组） */
  spaceSessionsLoaded: boolean
  /**
   * ：外部历史已展开会话（本机注入、服务端 message_count 常为 0）。
   * loadSessions 竞态下可能短暂不在 sessionsBySpaceId，绝不能当成失效指针打回草稿。
   */
  externallyOpenedSessionIds?: ReadonlySet<string>
  /**
   * ：用户正在打开的指定会话。对齐器只服务「只切了 Workspace」；
   * 有显式目标时必须 noop，不能 draft，也不能按旧记忆 restore。
   */
  explicitTargetSessionId?: string | null
}

function isKnown(
  sessionId: string | null,
  lists: ReadonlyArray<ReadonlyArray<{ id: string }>>,
): boolean {
  if (!sessionId) return false
  return lists.some(list => list.some(session => session.id === sessionId))
}

/**
 * 根据当前 Space 的草稿 / 记忆 / 已加载列表，决定应对全局指针做什么。
 */
export function resolveSpaceSessionPointerAction(
  input: SpaceSessionPointerInput,
): SpaceSessionPointerAction {
  const {
    globalCurrentSessionId,
    rememberedSessionId,
    inDraft,
    spaceSessions,
    trackerRunSessions,
    spaceSessionsLoaded,
    externallyOpenedSessionIds,
    explicitTargetSessionId,
  } = input

  const spaceLists = [spaceSessions, trackerRunSessions]
  const isExternallyOpened = (sessionId: string | null | undefined): boolean => (
    Boolean(sessionId && externallyOpenedSessionIds?.has(sessionId))
  )

  // ：首发乐观占位 session 不在 sessions 列表里；绝不能当成「外组织 /
  // 失效指针」打回草稿，否则 bootstrap 同帧被 lifecycle reconcile 抹掉，
  // 欢迎态看起来「完全没变化」。
  if (isLocalPendingSessionId(globalCurrentSessionId)) {
    return { type: 'noop' }
  }

  // ：点开指定会话时，空桶 / 失效指针 / 草稿旗标都不得抢走前台。
  if (explicitTargetSessionId) {
    return { type: 'noop' }
  }

  // ── 用户已点「新任务」进入草稿：显式草稿意图优先于一切记忆恢复 ──
  // 外部档案展开会话 message_count 常为 0，草稿预热若误写回记忆，
  // 若仍先走  restore 会把「新任务」瞬间拉回外来历史。
  if (inDraft) {
    if (globalCurrentSessionId == null) return { type: 'noop' }
    // ：只清「仍指着本 Space 旧记忆」的全局指针。
    // 全局已是他 Space / 共享会话时再 draft，会让多棵 ChatPanel 互抢
    // currentSessionId，同帧打出 React 。
    return globalCurrentSessionId === rememberedSessionId
      ? { type: 'draft' }
      : { type: 'noop' }
  }

  // ：仅当「本 Space 记忆」是外部已展开会话时保活 / 恢复。
  // 不可只凭全局 current 判断——切到空 Space 时全局仍可能是他 Space 的外部会话，
  // 必须继续走 draft 清串台；否则会把外 Space 正文留在空页。
  if (isExternallyOpened(rememberedSessionId)) {
    return globalCurrentSessionId === rememberedSessionId
      ? { type: 'noop' }
      : { type: 'restore', sessionId: rememberedSessionId! }
  }

  // ── 列表尚未写入桶：只用缓存尽快消掉跨 Space 串台闪帧 ──
  if (!spaceSessionsLoaded) {
    if (rememberedSessionId) {
      return globalCurrentSessionId === rememberedSessionId
        ? { type: 'noop' }
        : { type: 'restore', sessionId: rememberedSessionId }
    }
    if (globalCurrentSessionId != null) {
      return { type: 'draft' }
    }
    return { type: 'noop' }
  }

  // ── 有本 Space 记忆且仍在列表 / tracker 桶中 → 切回恢复 ──
  if (rememberedSessionId && isKnown(rememberedSessionId, spaceLists)) {
    return globalCurrentSessionId === rememberedSessionId
      ? { type: 'noop' }
      : { type: 'restore', sessionId: rememberedSessionId }
  }

  // 记忆不在主列表，但全局已对齐到该记忆 → 用户正在看，保持。
  // Project 任务「执行」会话常先以 conversations[] stub 出现在侧栏，点选后
  // 尚未写入 sessionsBySpaceId[team]；若此处打回草稿，侧栏会表现为「点了切不过去」。
  if (rememberedSessionId && globalCurrentSessionId === rememberedSessionId) {
    return { type: 'noop' }
  }

  // 记忆失效（会话已不在本 Space，且当前也没在看）→ 草稿
  if (rememberedSessionId) {
    return { type: 'draft' }
  }

  // ── 无记忆：本 Space 主列表与 tracker 皆空 → 进草稿 ──
  // 新建 Workspace / 空 Space：ChatPanel 的 visibleSessions 常是 organization
  // 合并列表，仍含他 Workspace 会话。若先按「全局仍可见」noop，创建后会停在
  // 旧对话，看起来像「没有自动点开新对话」。
  if (spaceSessions.length === 0 && trackerRunSessions.length === 0) {
    return { type: 'draft' }
  }

  // ── 无记忆：本 Space 已有会话时，全局仅当属于本 Space 桶才保持 ──
  // ：不可用 org 合并 visibleSessions——侧栏切到 Workspace B 时全局仍可能
  // 是 A 的会话且出现在合并列表，noop 会让发送继续打进旧对话。
  if (isKnown(globalCurrentSessionId, spaceLists)) {
    return { type: 'noop' }
  }

  // 外组织 / 他 Workspace 会话 / 全局 null → 进草稿（必须清全局，否则串台）
  return { type: 'draft' }
}
