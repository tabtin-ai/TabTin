/**
 * 配额紧急腾位 profile 白名单 — lifecycle 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  powerMonitor: { getSystemIdleTime: vi.fn().mockReturnValue(120) },
  webContents: { fromId: vi.fn() },
}))

vi.mock('../session-preload-registry', () => ({
  cleanupRegisteredSessionPreloads: vi.fn().mockResolvedValue(undefined),
}))

const mockVsrGetState = vi.fn().mockReturnValue(undefined)
const mockVsrCleanupOrphans = vi.fn().mockReturnValue([])
vi.mock('../../webcontents/ViewStateRegistry', () => ({
  getViewStateRegistry: () => ({
    getState: mockVsrGetState,
    cleanupOrphans: mockVsrCleanupOrphans,
  }),
}))

import {
  cleanupIdleViews,
  forceCleanupForQuota,
  isQuotaReclaimableProfile,
  QUOTA_RECLAIM_PROFILES,
  type CleanupContext,
} from '../lifecycle'
import type { ViewEntry } from '../types'

function makeViewEntry(id: string, profile: string): ViewEntry {
  return {
    id,
    view: { webContents: { isDestroyed: () => false, isCurrentlyAudible: () => false, isLoading: () => false } } as any,
    profile: profile as ViewEntry['profile'],
    config: { id, profile: profile as ViewEntry['profile'] } as ViewEntry['config'],
    createdAt: Date.now() - 400_000,
    attachedToMainWindow: false,
    reused: false,
    discarded: false,
  }
}

function makeCleanupCtx(views: Map<string, ViewEntry>, destroyView = vi.fn()): CleanupContext {
  return {
    views,
    idleTimeout: 300_000,
    maxPreviewViews: 2,
    destroyView: destroyView.mockResolvedValue(undefined),
    log: vi.fn(),
    performanceCollector: { recordCleanup: vi.fn() } as any,
  }
}

describe('isQuotaReclaimableProfile', () => {
  it('allows agent/preview/background', () => {
    expect(isQuotaReclaimableProfile('agent-workspace')).toBe(true)
    expect(isQuotaReclaimableProfile('temporary-preview')).toBe(true)
    expect(isQuotaReclaimableProfile('background-task')).toBe(true)
  })

  it('never allows user-tab', () => {
    expect(isQuotaReclaimableProfile('user-tab')).toBe(false)
  })

  it('QUOTA_RECLAIM_PROFILES matches reclaimable set', () => {
    expect([...QUOTA_RECLAIM_PROFILES]).toEqual([
      'agent-workspace',
      'background-task',
      'temporary-preview',
    ])
  })
})

describe('cleanupIdleViews allowedProfiles', () => {
  beforeEach(() => {
    mockVsrGetState.mockReset()
    mockVsrCleanupOrphans.mockReturnValue([])
  })

  it('skips user-tab when allowedProfiles whitelist is set', async () => {
    const views = new Map<string, ViewEntry>()
    views.set('user-1', makeViewEntry('user-1', 'user-tab'))
    views.set('preview-1', makeViewEntry('preview-1', 'temporary-preview'))

    mockVsrGetState.mockImplementation((id: string) => ({
      inUse: false,
      lastAccessTime: Date.now() - 400_000,
    }))

    const destroyView = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCleanupCtx(views, destroyView)

    await cleanupIdleViews(ctx, {
      bypassIdleCheck: true,
      forceFullDestroy: true,
      allowedProfiles: [...QUOTA_RECLAIM_PROFILES],
    })

    expect(destroyView).toHaveBeenCalledTimes(1)
    expect(destroyView).toHaveBeenCalledWith('preview-1', { force: true, discard: false })
    expect(destroyView).not.toHaveBeenCalledWith('user-1', expect.anything())
  })

  it('cleans all idle profiles when allowedProfiles is unset (legacy path)', async () => {
    const views = new Map<string, ViewEntry>()
    views.set('user-1', makeViewEntry('user-1', 'user-tab'))
    views.set('preview-1', makeViewEntry('preview-1', 'temporary-preview'))

    mockVsrGetState.mockImplementation(() => ({
      inUse: false,
      lastAccessTime: Date.now() - 400_000,
    }))

    const destroyView = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCleanupCtx(views, destroyView)

    await cleanupIdleViews(ctx, { bypassIdleCheck: true, forceFullDestroy: true })

    expect(destroyView).toHaveBeenCalledTimes(2)
    expect(destroyView).toHaveBeenCalledWith('user-1', { force: true, discard: false })
    expect(destroyView).toHaveBeenCalledWith('preview-1', { force: true, discard: false })
  })
})

describe('forceCleanupForQuota', () => {
  beforeEach(() => {
    mockVsrGetState.mockReset()
    mockVsrCleanupOrphans.mockReturnValue([])
  })

  it('defaults to QUOTA_RECLAIM_PROFILES whitelist', async () => {
    const views = new Map<string, ViewEntry>()
    views.set('user-1', makeViewEntry('user-1', 'user-tab'))
    views.set('agent-1', makeViewEntry('agent-1', 'agent-workspace'))

    mockVsrGetState.mockImplementation(() => ({
      inUse: false,
      lastAccessTime: Date.now() - 400_000,
    }))

    const destroyView = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCleanupCtx(views, destroyView)

    await forceCleanupForQuota(ctx)

    expect(destroyView).toHaveBeenCalledTimes(1)
    expect(destroyView).toHaveBeenCalledWith('agent-1', { force: true, discard: false })
    expect(destroyView).not.toHaveBeenCalledWith('user-1', expect.anything())
  })
})
