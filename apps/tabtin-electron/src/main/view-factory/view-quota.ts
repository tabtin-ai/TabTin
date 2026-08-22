/**
 * view-quota — View 创建配额检查
 *
 * 从 ViewFactory.createView 提取，负责 RunSessionManager 全局配额 + 单 Run 配额 + ViewFactory 兜底配额检查。
 */

import type { ViewFactoryConfig } from './types'

export type ViewQuotaConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> &
  Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>

type RunManagerLike = {
  getQuota: () => { enabled: boolean; maxTotalViews: number }
  checkQuotaForNewView: (runId: string, autoCreate: boolean) => { allowed: boolean; reason?: string }
}

/**
 * 配额判定结果：
 * - `allow`：可以立即占坑创建；
 * - `reject`：硬性超限（全局 / Run 配额），带原因，应直接抛错；
 * - `needCleanup`：达到 ViewFactory 兜底上限，需要先驱逐空闲 View 再复检。
 */
export type QuotaDecision =
  | { decision: 'allow' }
  | { decision: 'reject'; reason: string }
  | { decision: 'needCleanup' }

/** 全局 maxTotalViews 硬限 reject 的原因前缀，用于区分 Run 级「配额不足:」立即抛错。 */
export function isGlobalViewQuotaReject(reason: string): boolean {
  return reason.includes('达到全局最大 View 数限制')
}

/**
 * 纯同步配额判定——不 await、无副作用。
 *
 * 供 ViewFactory 在**同步段**内完成「判定 + 占坑」：因为 `await` 会在微任务边界让出，
 * 一旦判定与占坑之间存在 await，并发创建就能读到过期计数而绕过配额（AA-008）。
 * 把判定做成同步纯函数，调用方即可在单条同步语句序列里「判定通过就立刻占坑」，
 * 借单线程原子性替代全局互斥锁。
 */
export function evaluateViewQuota(
  currentSize: number,
  config: Pick<ViewQuotaConfig, 'runId'>,
  runManager: RunManagerLike,
  maxViews: number,
): QuotaDecision {
  const quota = runManager.getQuota()

  if (quota.enabled) {
    if (currentSize >= quota.maxTotalViews) {
      return { decision: 'reject', reason: `达到全局最大 View 数限制 (${quota.maxTotalViews})` }
    }
    if (config.runId) {
      const quotaCheck = runManager.checkQuotaForNewView(config.runId, true)
      if (!quotaCheck.allowed) {
        return { decision: 'reject', reason: `配额不足: ${quotaCheck.reason}` }
      }
    }
  }

  if (currentSize >= maxViews) {
    return { decision: 'needCleanup' }
  }

  return { decision: 'allow' }
}
