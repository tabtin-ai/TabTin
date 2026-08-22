import { describe, expect, it } from 'vitest'
import { planExternalArchiveDecorationMigration } from '../continueExternalArchiveChat'

const meta = {
  source: 'workbuddy',
  sourceSessionId: 'sess-legacy',
  title: '旧横幅会话',
  cwd: '/tmp/wb',
  workspaceId: 'ws-1',
  importedAt: '2026-07-26T00:00:00.000Z',
  messageCount: 1,
  kind: 'external_archive' as const,
}

describe('planExternalArchiveDecorationMigration', () => {
  it('空消息返回 null', () => {
    expect(planExternalArchiveDecorationMigration([], meta)).toBeNull()
  })

  it('旧【外部历史】system 行升级为结构化横幅 + LLM 边界，排在外来正文之后', () => {
    const next = planExternalArchiveDecorationMigration(
      [
        {
          id: 'ext-a1',
          role: 'user',
          content: '你是谁？',
          created_at: '2026-07-26T00:00:01.000Z',
          metadata: { external_archive: true },
        } as never,
        {
          id: 'legacy-sys',
          role: 'system',
          content: '【外部历史】来自 WorkBuddy',
          created_at: '2026-07-26T00:00:02.000Z',
          metadata: {},
        } as never,
        {
          id: 'live-1',
          role: 'user',
          content: '继续问',
          created_at: '2026-07-26T00:00:03.000Z',
        } as never,
      ],
      meta,
    )
    expect(next).not.toBeNull()
    expect(next?.map((m) => m.role)).toEqual(['user', 'system', 'user', 'user'])
    expect(next?.[0]?.content).toBe('你是谁？')
    expect(next?.[1]?.metadata).toMatchObject({ system_fact: 'external_archive_prefix' })
    expect(next?.[2]?.message_kind).toBe('external_archive_context')
    expect(next?.[2]?.content).toContain('type="external-archive"')
    expect(next?.[3]?.content).toBe('继续问')
  })

  it('装饰已在正确位置时返回 null（不再二次重排）', () => {
    const msgs = [
      {
        id: 'ext-a1',
        role: 'user',
        content: '你是谁？',
        created_at: '2026-07-26T00:00:01.000Z',
        metadata: { external_archive: true },
      },
      {
        id: 'ext-prefix-sess-legacy',
        role: 'system',
        content: '新任务 · 来自 WorkBuddy',
        created_at: '2026-07-26T00:00:01.001Z',
        metadata: { system_fact: 'external_archive_prefix', external_archive: true },
      },
      {
        id: 'ext-llm-boundary-sess-legacy',
        role: 'user',
        content: '<context type="external-archive">\n边界\n</context>',
        created_at: '2026-07-26T00:00:01.002Z',
        message_kind: 'external_archive_context',
        metadata: { system_fact: 'external_archive_llm_boundary', external_archive: true },
      },
      {
        id: 'live-1',
        role: 'user',
        content: '继续问',
        created_at: '2026-07-26T00:00:03.000Z',
      },
    ] as never[]
    expect(planExternalArchiveDecorationMigration(msgs, meta)).toBeNull()
  })
})
