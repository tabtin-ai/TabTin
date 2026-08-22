/**
 *  草稿首发编排入口
 *
 * 决策在 `draftSessionTargetPolicy`；此处只做 in-flight 等待 + 读 store 再决策。
 * prefetch 编排留在 `sessionPrefetchAction`（直接调 policy），避免与 latch 循环依赖。
 */

import {
  resolveFirstSendExistingSessionId,
  type DraftSessionLike,
} from './draftSessionTargetPolicy'
import { waitForInFlightSessionCreate } from './actions/sessionLifecycleAction'
import { getExternalOpenedSessionIds } from '@components/onboarding/external-import/externalOpenedSessionRegistry'

export interface DraftSessionCoordinatorStoreSlice {
  currentSessionIdBySpaceId: Record<string, string | null>
  sessionsBySpaceId: Record<string, DraftSessionLike[] | undefined>
}

/**
 * 首发前解析真 session id：先等 in-flight 预建收口，再读指针 / 单槽空会话。
 * 仍无候选时返回 null——调用方应 ensure 出真 id 后再 bootstrap，勿造 local-pending 壳。
 */
export async function resolveExistingSessionIdForDraftFirstSend(input: {
  spaceId: string
  getState: () => DraftSessionCoordinatorStoreSlice
}): Promise<string | null> {
  await waitForInFlightSessionCreate(input.spaceId).catch(() => {
    /* 失败由后续 ensure 重试 */
  })
  const state = input.getState()
  return resolveFirstSendExistingSessionId({
    spacePointer: state.currentSessionIdBySpaceId[input.spaceId] ?? null,
    spaceSessions: state.sessionsBySpaceId[input.spaceId] ?? [],
    excludeSessionIds: getExternalOpenedSessionIds(),
  })
}
