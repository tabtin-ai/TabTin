/**
 * Space 指针对齐副作用编排（从 useChatPanelLifecycle 下沉）。
 *
 * 读 store 快照 → 用纯函数 `resolveSpaceSessionPointerAction` 决策 →
 * 调 store action 落地（草稿 / 恢复）。`spaceSessionsLoaded` 由 store 里是否
 * 已有该 Space 的会话桶推导，因此同一函数天然覆盖「桶未加载（缓存兜底闪帧）」
 * 与「桶已加载（权威判定）」两种时序。
 *
 * `visibleSessions` 是面板可见会话（organization scope 下为 org 合并列表），
 * 属 React 派生值、不在 store，故由调用方传入。
 *
 * ：本函数只执行 resolve 的决策，不再用「本地有消息」否决 draft——
 * 那会把跨组织旧会话正文留在空 Space（反转 ）。#6697 首发保护在
 * resolve（local-pending → noop）。
 *
 * ：`syncSpaceCanonicalPointers` 只对齐 `sessions` 规范引用，不再用
 * React 快照回写 `currentSessionId`（陈旧旧 id 会盖掉 draft/null）。
 */

import { getExternalOpenedSessionIds } from '@components/onboarding/external-import/externalOpenedSessionRegistry'
import { createLogger } from '@/utils/logger'
import { useChatStore } from '@/stores/chat/useChatStore'
import { getOpenChatSessionIntent } from './openChatSessionIntent'
import { resolveSpaceSessionPointerAction } from './resolveSpaceSessionPointer'

const log = createLogger('ReconcileSpacePointer')

export function reconcileSpacePointer(
  spaceId: string,
  visibleSessions: ReadonlyArray<{ id: string }>,
): void {
  const state = useChatStore.getState()
  const spaceSessionsLoaded = Object.prototype.hasOwnProperty.call(
    state.sessionsBySpaceId,
    spaceId,
  )
  const spaceSessions = state.sessionsBySpaceId[spaceId] ?? []
  const trackerRunSessions = state.trackerRunSessionsBySpaceId[spaceId] ?? []
  const openIntent = getOpenChatSessionIntent()
  const explicitTargetSessionId = openIntent?.spaceId === spaceId
    ? openIntent.sessionId
    : null

  const action = resolveSpaceSessionPointerAction({
    globalCurrentSessionId: state.currentSessionId,
    rememberedSessionId: state.currentSessionIdBySpaceId[spaceId] ?? null,
    inDraft: Boolean(state.draftSessionBySpaceId[spaceId]),
    spaceSessions,
    trackerRunSessions,
    visibleSessions,
    spaceSessionsLoaded,
    // ：与 prefetch excludeSessionIds 同源，避免外部展开会话被 list 竞态打回草稿
    externallyOpenedSessionIds: getExternalOpenedSessionIds(),
    explicitTargetSessionId,
  })

  if (action.type === 'noop') {
    if (explicitTargetSessionId) {
      log.info('reconcile-skipped', { spaceId, sessionId: explicitTargetSessionId })
    }
    return
  }
  if (action.type === 'draft') {
    log.warn('fallback-draft', { spaceId })
    state.startDraftSessionForSpace(spaceId)
    return
  }
  void state.selectSession(spaceId, action.sessionId)
}

/**
 * 侧栏选中 Workspace 后对齐 chat 指针。
 *
 * 传入本 Space 桶（而非 org 合并列表），避免「全局仍是他 Workspace 会话且
 * 出现在合并列表」时被 resolve 当成 noop，消息继续打进旧对话。
 */
export function alignChatPointerToWorkspace(spaceId: string): void {
  const state = useChatStore.getState()
  const spaceSessions = state.sessionsBySpaceId[spaceId] ?? []
  reconcileSpacePointer(spaceId, spaceSessions)
}

/**
 * 把全局 `state.sessions` 对齐到当前聚焦 Space 的规范引用。
 *
 * 只同步 store 里 `sessionsBySpaceId[spaceId]` 的**原始引用**（而非 ChatPanel 为
 * 跨 Space 展示派生出来的合并数组——后者每次 render 都是新引用，写回会触发派生
 * useMemo 重算再回写，形成无限渲染循环）。指针的 draft / restore 决策见
 * `reconcileSpacePointer`；本函数**不**回写 `currentSessionId`。
 */
export function syncSpaceCanonicalPointers(spaceId: string): void {
  const state = useChatStore.getState()
  const hasLoadedSpaceSessions = Object.prototype.hasOwnProperty.call(
    state.sessionsBySpaceId,
    spaceId,
  )
  const canonicalSpaceSessions = state.sessionsBySpaceId[spaceId]
  if (hasLoadedSpaceSessions && canonicalSpaceSessions && state.sessions !== canonicalSpaceSessions) {
    state.setSpaceSessions(spaceId, canonicalSpaceSessions, true)
  }
}
