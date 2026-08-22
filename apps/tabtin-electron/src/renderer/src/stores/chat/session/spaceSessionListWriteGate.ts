/**
 * Space 会话列表写回门控。
 *
 * epoch 层借鉴 `messageWriteGate`：本地列表成员变更 bump；`GET /sessions`
 * 发起前 capture，写回时不一致则**整份丢弃**（飞行中的陈旧 list）。
 *
 * 会话列表还需要第二层——`mergeServerSpaceSessionSnapshot` +
 * `observedServerIds`：epoch 匹配时，服务端 payload 仍可能因写入滞后 /
 * 分页未含本地刚 upsert 的 id。消息层没有「list 缺一条仍保留本地」的需求，
 * 故消息只需 epoch；会话必须 epoch **且** 按 id 合并。二者守的是不同竞态，
 * 删掉任一层都会回归 。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('SpaceSessionListWriteGate')

const _epochs = new Map<string, number>()
/** 最近一次成功提交的服务端 list 所含 sessionId（用于区分「本地新建」与「服务端已移除」）。 */
const _observedServerIds = new Map<string, Set<string>>()

export function getSpaceSessionListEpoch(spaceId: string): number {
  return _epochs.get(spaceId) ?? 0
}

/**
 * 登记一次本地列表成员变更（upsert / 删除 / 恢复 / fork / purge），
 * 使所有在此之前发起、尚未写回的服务端 list 作废。
 */
export function recordSpaceSessionListMutation(spaceId: string, label: string): void {
  const next = getSpaceSessionListEpoch(spaceId) + 1
  _epochs.set(spaceId, next)
  log.info(`list mutation [${label}] space=${spaceId.slice(0, 8)} epoch=${next}`)
}

export type SpaceSessionListMergeOutcome = 'committed' | 'stale-epoch'

/**
 * 服务端 list 写回的唯一入口。`fetchEpoch` 为发起 fetch 前捕获的 epoch；
 * 校验通过才执行 `apply`，否则丢弃。
 */
export function commitSpaceSessionListMerge(
  spaceId: string,
  fetchEpoch: number,
  apply: () => void,
): SpaceSessionListMergeOutcome {
  const currentEpoch = getSpaceSessionListEpoch(spaceId)
  if (currentEpoch !== fetchEpoch) {
    log.warn(
      `server list dropped (stale epoch ${fetchEpoch} != ${currentEpoch}) space=${spaceId.slice(0, 8)}`,
    )
    return 'stale-epoch'
  }
  apply()
  return 'committed'
}

export function getObservedServerSessionIds(spaceId: string): ReadonlySet<string> {
  return _observedServerIds.get(spaceId) ?? new Set()
}

export function replaceObservedServerSessionIds(
  spaceId: string,
  ids: Iterable<string>,
): void {
  _observedServerIds.set(spaceId, new Set(ids))
}

/** Test-only：清空 epoch / 观察集。 */
export function __resetSpaceSessionListWriteGateForTest(): void {
  _epochs.clear()
  _observedServerIds.clear()
}
