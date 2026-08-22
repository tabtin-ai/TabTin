/**
 * view-reuse — Wave 3 复核 L-W3-9 测试
 *
 * 验证 partition 不一致时的 active run 守卫：
 *   - 有 active run → 复用旧 partition（不 destroy + warn 日志）
 *   - 无 active run → 走主战场行为（destroy 旧 view 让上层重建）
 *
 * 这条守卫与 `crawl-view/ipc-handlers.ts` 的 B1 守卫对称，避免 Agent /
 * action-tools 调 createView 时半路打断 run。
 */

import { describe, it, expect, vi } from 'vitest'

import { resolveViewReuse } from '../view-reuse'
import type { ViewEntry } from '../types'
import { AGENT_BACKGROUND_INTERACTIVE_BOUNDS } from '../background-interaction'

function makeEntry(overrides: Partial<ViewEntry> & { partition?: string; crawlspaceId?: string }): ViewEntry {
  const { partition, crawlspaceId, ...rest } = overrides
  return {
    id: 'view-1',
    view: { id: 'wc-1' } as any,
    profile: 'user-tab',
    config: {
      id: 'view-1',
      profile: 'user-tab',
      partition: partition ?? 'tabtin:env:old',
      metadata: { crawlspaceId: crawlspaceId ?? 'cs-1' },
    } as any,
    createdAt: Date.now(),
    attachedToMainWindow: true,
    tabNotified: false,
    registrations: {},
    ...rest,
  }
}

function makeFinalConfig(overrides: { partition?: string; crawlspaceId?: string; runId?: string }): any {
  return {
    id: 'view-1',
    profile: 'user-tab',
    partition: overrides.partition ?? 'tabtin:env:new',
    metadata: { crawlspaceId: overrides.crawlspaceId ?? 'cs-1' },
    runId: overrides.runId,
  }
}

function makeDeps(views: Map<string, ViewEntry>, opts: {
  destroyView?: ReturnType<typeof vi.fn>
  getRunIdByView?: ReturnType<typeof vi.fn>
  registerViewLocked?: ReturnType<typeof vi.fn>
  log?: ReturnType<typeof vi.fn>
}) {
  const destroyView = opts.destroyView ?? vi.fn().mockImplementation(async (id: string) => {
    views.delete(id)
  })
  const getRunIdByView = opts.getRunIdByView ?? vi.fn().mockReturnValue(undefined)
  const registerViewLocked = opts.registerViewLocked ?? vi.fn().mockResolvedValue(undefined)
  const log = opts.log ?? vi.fn()
  return {
    views,
    destroyView,
    getRunSessionManager: () => ({
      registerView: vi.fn(),
      registerViewLocked,
      getRunIdByView,
    }),
    performanceCollector: { recordViewCreation: vi.fn(), updateResourceUsage: vi.fn() } as any,
    getStats: () => ({ inUse: 0 }),
    enableReuse: true,
    log,
    getInUse: vi.fn().mockReturnValue(false),
    setInUse: vi.fn(),
    touchView: vi.fn(),
  }
}

describe('view-reuse — L-W3-9 active run 守卫', () => {
  it('partition 不一致 + 存在 active run → 复用旧 view，不 destroy', async () => {
    const views = new Map<string, ViewEntry>()
    views.set('view-1', makeEntry({ partition: 'tabtin:env:old' }))

    const destroyView = vi.fn()
    const log = vi.fn()
    const getRunIdByView = vi.fn().mockReturnValue('run-active-123')

    const handle = await resolveViewReuse(
      makeFinalConfig({ partition: 'tabtin:env:new' }),
      makeDeps(views, { destroyView, getRunIdByView, log }) as any
    )

    expect(getRunIdByView).toHaveBeenCalledWith('view-1')
    expect(destroyView).not.toHaveBeenCalled()
    expect(handle).not.toBeNull()
    expect(handle?.reused).toBe(true)
    expect(handle?.id).toBe('view-1')

    const matched = log.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('partition reuse defer')
    )
    expect(matched).toBeDefined()
    const payload = matched?.[1]
    expect(payload).toMatchObject({
      viewId: 'view-1',
      requestedPartition: 'tabtin:env:new',
      existingPartition: 'tabtin:env:old',
      runId: 'run-active-123',
    })
  })

  it('partition 不一致 + 无 active run → 走主战场 destroy + 重建路径', async () => {
    const views = new Map<string, ViewEntry>()
    views.set('view-1', makeEntry({ partition: 'tabtin:env:old' }))

    const destroyView = vi.fn().mockImplementation(async (id: string) => {
      views.delete(id)
    })
    const getRunIdByView = vi.fn().mockReturnValue(undefined)

    const handle = await resolveViewReuse(
      makeFinalConfig({ partition: 'tabtin:env:new' }),
      makeDeps(views, { destroyView, getRunIdByView }) as any
    )

    expect(getRunIdByView).toHaveBeenCalledWith('view-1')
    expect(destroyView).toHaveBeenCalledWith('view-1', { force: true })
    expect(handle).toBeNull()
  })

  it('crawlspaceId 不一致 → active run 守卫不优先，仍抛错（数据完整性）', async () => {
    const views = new Map<string, ViewEntry>()
    views.set('view-1', makeEntry({ partition: 'tabtin:env:old', crawlspaceId: 'cs-1' }))

    const destroyView = vi.fn()
    // 即使返回 active run，crawlspaceId 不一致仍走 throw 分支
    const getRunIdByView = vi.fn().mockReturnValue('run-active-456')

    await expect(
      resolveViewReuse(
        makeFinalConfig({ partition: 'tabtin:env:new', crawlspaceId: 'cs-2' }),
        makeDeps(views, { destroyView, getRunIdByView }) as any
      )
    ).rejects.toThrow(/crawlspaceId 不一致/)

    expect(destroyView).not.toHaveBeenCalled()
  })

  it('复用后台交互 View 时同步配置并升级仍离屏的原生画布', async () => {
    const getBounds = vi.fn(() => ({ x: -1, y: -1, width: 800, height: 600 }))
    const setBounds = vi.fn()
    const entry = makeEntry({
      partition: 'tabtin:env:old',
      view: { id: 'wc-1', getBounds, setBounds } as any,
    })
    const views = new Map([['view-1', entry]])
    const metadata = { crawlspaceId: 'cs-1', agentBackgroundInteractive: true }
    const finalConfig = {
      ...makeFinalConfig({ partition: 'tabtin:env:old', runId: 'run-new' }),
      bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS,
      metadata,
    }

    await resolveViewReuse(finalConfig as any, makeDeps(views, {}) as any)

    expect(entry.config.runId).toBe('run-new')
    expect(entry.config.metadata).toEqual(metadata)
    expect(entry.config.bounds).toEqual(AGENT_BACKGROUND_INTERACTIVE_BOUNDS)
    expect(setBounds).toHaveBeenCalledWith(AGENT_BACKGROUND_INTERACTIVE_BOUNDS)
  })

  it('复用后台交互 View 时不将仍在前台的原生画布挪到离屏', async () => {
    const getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 720 }))
    const setBounds = vi.fn()
    const entry = makeEntry({
      partition: 'tabtin:env:old',
      view: { id: 'wc-1', getBounds, setBounds } as any,
    })
    const views = new Map([['view-1', entry]])
    const finalConfig = {
      ...makeFinalConfig({ partition: 'tabtin:env:old', runId: 'run-new' }),
      bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS,
      metadata: { crawlspaceId: 'cs-1', agentBackgroundInteractive: true },
    }

    await resolveViewReuse(finalConfig as any, makeDeps(views, {}) as any)

    expect(entry.config.runId).toBe('run-new')
    expect(entry.config.metadata.agentBackgroundInteractive).toBe(true)
    expect(entry.config.bounds).toEqual(AGENT_BACKGROUND_INTERACTIVE_BOUNDS)
    expect(setBounds).not.toHaveBeenCalled()
  })
})
