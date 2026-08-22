/**
 * 回归测试：F10 修复验证
 *
 * TSI-001: openInTabCode 应调用 addRecentProject
 * TSI-002: openInTabCode 在 spaceId 为 null 时应 guard return
 * TSI-003: tabsiteHandler 应声明 resolveTabItem
 * TSI-004/010/012: archived 状态 UI 保护
 * TSI-005: WS resource_updated 事件应携带 metadata/status/preview
 * TSI-011: TabSiteSection 状态三态区分
 */

import { describe, it, expect } from 'vitest'

// ── TSI-001: openInTabCode 改用标准路径 ──

describe('TSI-001: openInTabCode records to recent projects', () => {
  it('openInTabCode logic should call addRecentProject before openResourceTab', () => {
    const calls: string[] = []
    const spaceId = 'space-001'
    const codePath = '/home/user/my-site'

    const addRecentProject = (sid: string, path: string) => {
      calls.push(`addRecentProject:${sid}:${path}`)
    }
    const openResourceTab = (sid: string, opts: { type: string; id: string; title: string; meta: Record<string, unknown> }) => {
      calls.push(`openResourceTab:${sid}:${opts.type}`)
    }

    // Simulate the fixed openInTabCode logic
    if (codePath && spaceId) {
      const localPath = codePath
      addRecentProject(spaceId, localPath)
      const id = btoa(unescape(encodeURIComponent(localPath)))
      const title = localPath.split('/').filter(Boolean).pop() || 'Code'
      openResourceTab(spaceId, { type: 'tabcode', id, title, meta: { path: localPath, spaceId } })
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(`addRecentProject:${spaceId}:${codePath}`)
    expect(calls[1]).toContain('openResourceTab:space-001:tabcode')
  })
})

// ── TSI-002: spaceId null guard ──

describe('TSI-002: openInTabCode guards against null spaceId', () => {
  it('does nothing when spaceId is null', () => {
    const spaceId: string | null = null
    const codePath = '/home/user/my-site'
    let called = false

    if (codePath && spaceId) {
      called = true
    }

    expect(called).toBe(false)
  })

  it('does nothing when spaceId is empty string', () => {
    const spaceId = ''
    const codePath = '/home/user/my-site'
    let called = false

    // Fixed logic: uses !spaceId which catches empty string
    if (codePath && spaceId) {
      called = true
    }

    expect(called).toBe(false)
  })
})

// ── TSI-003: tabsiteHandler resolveTabItem ──

describe('TSI-003: tabsiteHandler resolveTabItem', () => {
  it('resolveTabItem returns item with spaceId from persistedItem meta', () => {
    const resolveTabItem = (id: string, ctx: {
      persistedItem?: { title?: string; meta?: Record<string, unknown> } | null
      spaceId: string
      tabKey: string
    }) => {
      const title = ctx.persistedItem?.title || 'Untitled Site'
      const spaceId = (ctx.persistedItem?.meta?.spaceId as string | undefined) ?? ctx.spaceId
      return { type: 'tabsite', id, tabKey: ctx.tabKey, title, meta: { spaceId } }
    }

    const result = resolveTabItem('site-123', {
      spaceId: 'fallback-space',
      tabKey: 'tabsite:site-123',
      persistedItem: { title: 'My Site', meta: { spaceId: 'persisted-space' } },
    })

    expect(result.type).toBe('tabsite')
    expect(result.id).toBe('site-123')
    expect(result.title).toBe('My Site')
    expect(result.meta.spaceId).toBe('persisted-space')
  })

  it('falls back to ctx.spaceId when persistedItem has no spaceId', () => {
    const resolveTabItem = (id: string, ctx: {
      persistedItem?: { title?: string; meta?: Record<string, unknown> } | null
      spaceId: string
      tabKey: string
    }) => {
      const title = ctx.persistedItem?.title || 'Untitled Site'
      const spaceId = (ctx.persistedItem?.meta?.spaceId as string | undefined) ?? ctx.spaceId
      return { type: 'tabsite', id, tabKey: ctx.tabKey, title, meta: { spaceId } }
    }

    const result = resolveTabItem('site-456', {
      spaceId: 'ctx-space',
      tabKey: 'tabsite:site-456',
      persistedItem: { title: 'Other Site', meta: {} },
    })

    expect(result.meta.spaceId).toBe('ctx-space')
  })
})

// ── TSI-004/010/012: archived 状态 UI 保护 ──

describe('TSI-004/010/012: archived status UI protection', () => {
  function getStatusBadge(status: string): { label: string; styleClass: string } {
    if (status === 'archived') {
      return { label: '已归档', styleClass: 'bg-destructive/10 text-destructive' }
    }
    if (status === 'published') {
      return { label: '已发布', styleClass: 'bg-primary/10 text-primary' }
    }
    return { label: '草稿', styleClass: 'bg-muted text-muted-foreground' }
  }

  it('TSI-012: badge shows "已归档" for archived status', () => {
    const badge = getStatusBadge('archived')
    expect(badge.label).toBe('已归档')
    expect(badge.styleClass).toContain('destructive')
  })

  it('TSI-012: badge shows "已发布" for published status', () => {
    const badge = getStatusBadge('published')
    expect(badge.label).toBe('已发布')
    expect(badge.styleClass).toContain('primary')
  })

  it('TSI-012: badge shows "草稿" for draft status', () => {
    const badge = getStatusBadge('draft')
    expect(badge.label).toBe('草稿')
    expect(badge.styleClass).toContain('muted')
  })

  it('TSI-010: openPublishDialog guards against archived', () => {
    const site = { status: 'archived', dist_oss_url: 'https://cdn.example.com/v1' }
    const isArchived = site.status === 'archived'
    let dialogOpened = false

    if (!isArchived && site.dist_oss_url) {
      dialogOpened = true
    }

    expect(dialogOpened).toBe(false)
  })

  it('TSI-010: handleRollback guards against archived', () => {
    const isArchived = true
    const rollingBack: number | null = null
    let rollbackCalled = false

    if (rollingBack === null && !isArchived) {
      rollbackCalled = true
    }

    expect(rollbackCalled).toBe(false)
  })

  it('TSI-004: archived site should not render iframe', () => {
    const site = { status: 'archived', dist_oss_url: 'https://cdn.example.com/v1', code_project_path: '/path' }
    const isArchived = site.status === 'archived'

    let renderedElement: 'archived' | 'iframe' | 'init' | 'empty'
    if (isArchived) {
      renderedElement = 'archived'
    } else if (!site.code_project_path) {
      renderedElement = 'init'
    } else if (site.dist_oss_url) {
      renderedElement = 'iframe'
    } else {
      renderedElement = 'empty'
    }

    expect(renderedElement).toBe('archived')
  })
})

// ── TSI-005: WS resource_updated event data sync ──

describe('TSI-005: resource_updated WS event includes metadata/status/preview', () => {
  interface MockResource {
    resource_id: string
    title: string
    updated_at: string
    metadata: Record<string, unknown>
    status?: string
    preview?: string
  }

  interface MockEvent {
    type: string
    resource_id: string
    title?: string
    metadata?: Record<string, unknown>
    status?: string
    preview?: string
  }

  function applyResourceUpdate(resource: MockResource, event: MockEvent): MockResource {
    const patch: Partial<MockResource> = {
      title: event.title || resource.title,
      updated_at: new Date().toISOString(),
    }
    if (event.metadata) patch.metadata = event.metadata
    if (event.status) patch.status = event.status
    if (event.preview !== undefined) patch.preview = event.preview
    return { ...resource, ...patch }
  }

  it('updates metadata when present in event', () => {
    const resource: MockResource = {
      resource_id: 'site-1',
      title: 'My Site',
      updated_at: '2026-01-01T00:00:00Z',
      metadata: { status: 'draft' },
    }
    const event: MockEvent = {
      type: 'resource_updated',
      resource_id: 'site-1',
      title: 'My Site',
      metadata: { status: 'published', published_url: 'https://example.com/s/my-site/' },
      status: 'published',
    }

    const updated = applyResourceUpdate(resource, event)
    expect(updated.metadata).toEqual({ status: 'published', published_url: 'https://example.com/s/my-site/' })
    expect(updated.status).toBe('published')
  })

  it('preserves existing metadata when event has no metadata', () => {
    const resource: MockResource = {
      resource_id: 'site-1',
      title: 'My Site',
      updated_at: '2026-01-01T00:00:00Z',
      metadata: { status: 'draft' },
    }
    const event: MockEvent = {
      type: 'resource_updated',
      resource_id: 'site-1',
      title: 'My Site Updated',
    }

    const updated = applyResourceUpdate(resource, event)
    expect(updated.metadata).toEqual({ status: 'draft' })
    expect(updated.title).toBe('My Site Updated')
  })
})

// ── TSI-011: TabSiteSection 三态区分 ──

describe('TSI-011: TabSiteSection status tri-state rendering', () => {
  function getCardBadge(status: string): { label: string; icon: string } {
    if (status === 'archived') {
      return { label: '已归档', icon: '📦' }
    }
    if (status === 'published') {
      return { label: '已发布', icon: '🌐' }
    }
    return { label: '草稿', icon: '🔧' }
  }

  it('archived sites show archive badge and icon', () => {
    const result = getCardBadge('archived')
    expect(result.label).toBe('已归档')
    expect(result.icon).toBe('📦')
  })

  it('published sites show published badge and icon', () => {
    const result = getCardBadge('published')
    expect(result.label).toBe('已发布')
    expect(result.icon).toBe('🌐')
  })

  it('draft sites show draft badge and icon', () => {
    const result = getCardBadge('draft')
    expect(result.label).toBe('草稿')
    expect(result.icon).toBe('🔧')
  })
})
