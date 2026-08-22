/**
 * W3.3 D-5 §3 · renderer 守护测试：drafts:all-unsaved 聚合导出 bucket。
 *
 * 守住：
 *   1. import 后 drafts:all-unsaved 已注册（hideFromList=true，data 类）
 *   2. 4 个来源都未注册时 exportFn 仍能产出合法 JSON（available=false / 0 drafts）
 *   3. 部分来源注册时，可用来源 available=true 并包含 drafts；未注册来源
 *      标 unavailableReason='not-registered'
 *   4. filename 含 ISO timestamp
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('draftsAggregatedExport · drafts:all-unsaved 聚合 bucket', () => {
  beforeEach(async () => {
    // 顶层副作用 register 只跑一次；通过 resetModules + __resetForTesting
    // 让每个 case 都从干净 registry + 干净模块缓存出发。
    vi.resetModules()
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('注册 hideFromList=true 的 data 类聚合 bucket', async () => {
    await import('../draftsAggregatedExport')
    const sm = await import('@tabtin/storage-manager')

    const bucket = sm.getBucket('drafts:all-unsaved')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('conversation')
    expect(bucket?.hideFromList).toBe(true)
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(typeof bucket?.exportFn).toBe('function')
    expect(typeof bucket?.sizeFn).toBe('function')
    // 不暴露 clearFn——清理走各来源 bucket
    expect(bucket?.clearFn).toBeUndefined()
  })

  it('4 个来源都未注册时 exportFn 产出 totalDraftCount=0 + 全部 unavailable', async () => {
    await import('../draftsAggregatedExport')
    const sm = await import('@tabtin/storage-manager')

    const bucket = sm.getBucket('drafts:all-unsaved')!
    const exp = await bucket.exportFn!()

    expect(exp.mimeType).toBe('application/json')
    expect(exp.filename).toMatch(
      /^tabtin-unsaved-drafts-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z\.json$/,
    )

    const parsed = JSON.parse(exp.data as string)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      source: 'tabtin-electron',
      bucketId: 'drafts:all-unsaved',
      totalDraftCount: 0,
      totalBytes: 0,
    })
    expect(parsed.sources).toHaveLength(3)
    const sourceMap = new Map(
      (parsed.sources as Array<{ source: string; available: boolean; unavailableReason?: string }>).map(
        (s) => [s.source, s],
      ),
    )
    for (const key of ['chat', 'tabdoc', 'tabslide']) {
      const entry = sourceMap.get(key)
      expect(entry).toBeDefined()
      expect(entry?.available).toBe(false)
      expect(entry?.unavailableReason).toBe('not-registered')
    }
    expect(typeof parsed.exportedAt).toBe('string')
    expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt)
  })

  it('🔒 隐私守护：来源 listFn label 含正文片段时聚合层覆盖为安全占位', async () => {
    const sm = await import('@tabtin/storage-manager')

    // 模拟 tabdoc:offline-drafts 的真实行为：label 含 plaintext 前 60 字
    sm.registerStorageBucket({
      id: 'tabdoc:offline-drafts',
      category: 'data',
      group: 'business-app',
      displayName: 'TabDoc 离线草稿（mock）',
      description: '隐私守护测试',
      warnings: ['mock'],
      requiresConfirmation: 'soft',
      sizeFn: async () => ({ bytes: 1024, itemCount: 1 }),
      listFn: async () => [
        {
          id: 'doc-secret-id',
          // 正文前缀片段——这是 TabDoc listFn 的现实 label 形态
          label: '【机密人事调动】2026Q2 R1/R2 转岗草案：陈主管将调...',
          bytes: 1024,
          metadata: { savedAt: '2026-05-04T03:00:00Z', baseVersion: 7 },
        },
      ],
    })

    await import('../draftsAggregatedExport')
    const bucket = sm.getBucket('drafts:all-unsaved')!
    const exp = await bucket.exportFn!()

    // 关键守护：导出文件不能包含任何 plaintext 片段
    expect(exp.data).not.toContain('机密人事调动')
    expect(exp.data).not.toContain('陈主管')
    expect(exp.data).not.toContain('转岗草案')

    // metadata 仍应保留（结构信息无隐私）
    expect(exp.data).toContain('savedAt')
    expect(exp.data).toContain('baseVersion')

    const parsed = JSON.parse(exp.data as string)
    const tabdocSource = (parsed.sources as Array<{ source: string; drafts: Array<{ label: string }> }>).find(
      (s) => s.source === 'tabdoc',
    )!
    expect(tabdocSource.drafts).toHaveLength(1)
    // label 改成安全占位形式（含 displayName + id 前 12 字符）
    expect(tabdocSource.drafts[0]!.label).toContain('TabDoc')
    expect(tabdocSource.drafts[0]!.label).toContain('doc-secret-i')
  })

  it('某个来源 bucket 已注册时 exportFn 把它的 listFn 项纳入聚合', async () => {
    const sm = await import('@tabtin/storage-manager')

    // 必须先注册来源 bucket，再 import 聚合模块——否则两个模块顺序无所谓，
    // 因为聚合 bucket 的 exportFn 是 lazy 调 getBucket。
    // 模拟 chat:input-drafts 的最小注册（仿 ChatInput.tsx 的 schema）
    sm.registerStorageBucket({
      id: 'chat:input-drafts',
      category: 'data',
      group: 'conversation',
      displayName: '对话输入框草稿',
      description: '测试用',
      warnings: ['mock-warning'],
      sizeFn: async () => ({ bytes: 100, itemCount: 1 }),
      listFn: async () => [
        {
          id: 'session-A',
          label: '会话 session-A',
          bytes: 100,
          metadata: { chars: 50, lruRank: 0, lruTotal: 1 },
        },
      ],
    })

    await import('../draftsAggregatedExport')
    const bucket = sm.getBucket('drafts:all-unsaved')!
    const exp = await bucket.exportFn!()
    const parsed = JSON.parse(exp.data as string)

    expect(parsed.totalDraftCount).toBe(1)
    expect(parsed.totalBytes).toBe(100)

    const chatSource = (parsed.sources as Array<{
      source: string
      available: boolean
      drafts: Array<{ id: string; metadata: Record<string, unknown> }>
    }>).find((s) => s.source === 'chat')!
    expect(chatSource.available).toBe(true)
    expect(chatSource.drafts).toHaveLength(1)
    expect(chatSource.drafts[0]!.id).toBe('session-A')
    expect(chatSource.drafts[0]!.metadata).toMatchObject({ chars: 50, lruRank: 0 })
  })
})
