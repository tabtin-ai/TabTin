/**
 * reserveQuotaOrThrow 算法模型：全局硬限 reject → 腾位 → 复检
 *
 * 与 ViewFactory.reserveQuotaOrThrow 一致的最小模型，不实例化 Electron。
 */

import { describe, it, expect, vi } from 'vitest'
import { evaluateViewQuota, isGlobalViewQuotaReject } from '../view-quota'
import { QUOTA_RECLAIM_PROFILES } from '../lifecycle'

type ViewProfile = string

function makeReserveModel(options: {
  globalLimit: number
  initialViews: Array<{ id: string; profile: ViewProfile }>
}) {
  const views = new Map<string, ViewProfile>()
  for (const v of options.initialViews) {
    views.set(v.id, v.profile)
  }
  const reservations = new Set<string>()
  const runManager = {
    getQuota: () => ({ enabled: true, maxTotalViews: options.globalLimit }),
    checkQuotaForNewView: () => ({ allowed: true }),
  }

  const cleanupCalls: Array<{ allowedProfiles: readonly string[] }> = []
  let mutexHeld = false

  const tryReserveSync = (id: string) => {
    const decision = evaluateViewQuota(
      views.size + reservations.size,
      { id } as any,
      runManager,
      50,
    )
    if (decision.decision === 'allow') reservations.add(id)
    return decision
  }

  const forceCleanupForQuota = async (allowedProfiles: readonly string[]) => {
    cleanupCalls.push({ allowedProfiles: [...allowedProfiles] })
    for (const [id, profile] of [...views.entries()]) {
      if (allowedProfiles.includes(profile)) {
        views.delete(id)
        break // 腾 1 个即可
      }
    }
  }

  const reserveQuotaOrThrow = async (id: string) => {
    const first = tryReserveSync(id)
    if (first.decision === 'allow') return

    const shouldCleanup =
      first.decision === 'needCleanup' ||
      (first.decision === 'reject' && isGlobalViewQuotaReject(first.reason))

    if (!shouldCleanup) {
      throw new Error(first.reason)
    }

    if (mutexHeld) throw new Error('mutex already held')
    mutexHeld = true
    try {
      await forceCleanupForQuota(QUOTA_RECLAIM_PROFILES)
      const retry = tryReserveSync(id)
      if (retry.decision === 'allow') return
      throw new Error(retry.decision === 'reject' ? retry.reason : 'View 数量已达上限')
    } finally {
      mutexHeld = false
    }
  }

  return {
    views,
    reservations,
    cleanupCalls,
    reserveQuotaOrThrow,
    tryReserveSync,
  }
}

describe('reserveQuotaOrThrow model: global reject → cleanup → allow', () => {
  it('global reject enters cleanup then can allow', async () => {
    const m = makeReserveModel({
      globalLimit: 5,
      initialViews: [
        { id: 'user-1', profile: 'user-tab' },
        { id: 'user-2', profile: 'user-tab' },
        { id: 'user-3', profile: 'user-tab' },
        { id: 'user-4', profile: 'user-tab' },
        { id: 'preview-1', profile: 'temporary-preview' },
      ],
    })

    await m.reserveQuotaOrThrow('new-view')

    expect(m.cleanupCalls).toHaveLength(1)
    expect(m.cleanupCalls[0].allowedProfiles).toEqual([...QUOTA_RECLAIM_PROFILES])
    expect(m.views.has('preview-1')).toBe(false)
    expect(m.views.has('user-1')).toBe(true)
    expect(m.reservations.has('new-view')).toBe(true)
  })

  it('run-level reject throws immediately without cleanup', async () => {
    const views = new Map<string, ViewProfile>([['v1', 'user-tab']])
    const reservations = new Set<string>()
    const runManager = {
      getQuota: () => ({ enabled: true, maxTotalViews: 50 }),
      checkQuotaForNewView: () => ({ allowed: false, reason: 'Run 超限' }),
    }
    const cleanup = vi.fn()

    const tryReserveSync = (id: string) => {
      const decision = evaluateViewQuota(
        views.size + reservations.size,
        { id, runId: 'run-1' } as any,
        runManager,
        50,
      )
      if (decision.decision === 'allow') reservations.add(id)
      return decision
    }

    const reserveQuotaOrThrow = async (id: string) => {
      const first = tryReserveSync(id)
      if (first.decision === 'allow') return
      const shouldCleanup =
        first.decision === 'needCleanup' ||
        (first.decision === 'reject' && isGlobalViewQuotaReject(first.reason))
      if (!shouldCleanup) throw new Error(first.reason)
      await cleanup()
    }

    await expect(reserveQuotaOrThrow('new')).rejects.toThrow('配额不足: Run 超限')
    expect(cleanup).not.toHaveBeenCalled()
  })
})
