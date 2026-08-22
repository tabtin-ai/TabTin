import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  buildSharePickerNavItems,
  buildSharePickerSessionPresentation,
  filterSharePickerSessionsByScope,
  groupSharePickerSessions,
  matchesSharePickerSearch,
  mergeSharePickerSessions,
  resolveSharePickerSessionTitle,
  type SharePickerSessionEntry,
} from './sessionSharePickerPresentation'

const t = (_key: string, opts?: Record<string, unknown>) => {
  if (typeof opts?.defaultValue === 'string') return opts.defaultValue
  if (opts?.name && opts?.index) return `定时 · ${opts.name} #${opts.index}`
  return _key
}

const baseContext = {
  agentCache: {
    'agent-1': { display_name: '小 Tin', name: 'tin' },
  },
  selectedAgent: null,
  spaceNameById: {
    'space-a': '产品探索',
    'space-b': '研发现场',
  },
  showWorkspaceSource: true,
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sess-1',
    title: '修共享卡样式',
    status: 'active',
    organization_id: 'org-1',
    space_id: 'space-a',
    agent_id: 'agent-1',
    created_at: '2026-07-20T08:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    last_message_at: '2026-07-25T10:00:00.000Z',
    last_message_preview: '把三档权限文案对齐一下',
    message_count: 12,
    ...overrides,
  } as ChatSession
}

function entry(
  session: ChatSession,
  sourceSpaceId: string,
): SharePickerSessionEntry {
  return { session, sourceSpaceId }
}

describe('sessionSharePickerPresentation', () => {
  it('resolveSharePickerSessionTitle 默认标题回退', () => {
    expect(resolveSharePickerSessionTitle(makeSession(), t)).toBe('修共享卡样式')
    expect(resolveSharePickerSessionTitle(makeSession({ title: '', title_is_default: true }), t)).toBe('新任务')
    expect(resolveSharePickerSessionTitle(makeSession({ title: '新任务', title_is_default: true }), () => '새 작업')).toBe('새 작업')
  })

  it('系统生成的 Agent 切换摘要走翻译，用户消息保持原文', () => {
    expect(buildSharePickerSessionPresentation(
      makeSession({ last_message_preview: 'Agent 已切换成研究助手' }),
      baseContext,
      (_key, opts) => `Agent 전환: ${String(opts?.name ?? '')}`,
    ).preview).toBe('Agent 전환: 研究助手')
    expect(buildSharePickerSessionPresentation(
      makeSession({ last_message_preview: '用户输入的中文消息' }),
      baseContext,
      (_key, opts) => String(opts?.defaultValue ?? _key),
    ).preview).toBe('用户输入的中文消息')
  })

  it('buildSharePickerSessionPresentation 聚合 Agent / 现场 / 摘要', () => {
    const view = buildSharePickerSessionPresentation(makeSession(), baseContext, t)
    expect(view.title).toBe('修共享卡样式')
    expect(view.meta).toBe('小 Tin · 产品探索')
    expect(view.preview).toBe('把三档权限文案对齐一下')
    expect(view.activityTs).toBeGreaterThan(0)
  })

  it('buildSharePickerSessionPresentation 优先用 sourceSpaceId 展示来源', () => {
    const view = buildSharePickerSessionPresentation(
      makeSession({ space_id: 'space-b' }),
      baseContext,
      t,
      'space-a',
    )
    expect(view.meta).toBe('小 Tin · 产品探索')
  })

  it('matchesSharePickerSearch 支持标题与摘要', () => {
    const session = makeSession()
    expect(matchesSharePickerSearch(session, '共享卡', baseContext)).toBe(true)
    expect(matchesSharePickerSearch(session, '三档权限', baseContext)).toBe(true)
    expect(matchesSharePickerSearch(session, '不存在', baseContext)).toBe(false)
  })

  it('groupSharePickerSessions 单现场不分组', () => {
    const groups = groupSharePickerSessions(
      [entry(makeSession(), 'space-a')],
      baseContext.spaceNameById,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.spaceName).toBeNull()
  })

  it('groupSharePickerSessions 多现场按名称排序', () => {
    const groups = groupSharePickerSessions([
      entry(makeSession({ id: 'a', space_id: 'space-b' }), 'space-b'),
      entry(makeSession({ id: 'b', space_id: 'space-a' }), 'space-a'),
    ], baseContext.spaceNameById)
    expect(groups.map((g) => g.spaceName)).toEqual(['产品探索', '研发现场'])
  })

  it('filterSharePickerSessionsByScope 按 store 桶过滤', () => {
    const merged = [
      entry(makeSession({ id: 'a', space_id: null as unknown as string }), 'space-a'),
      entry(makeSession({ id: 'b', space_id: 'space-a' }), 'space-b'),
    ]
    expect(filterSharePickerSessionsByScope(merged, 'space-a')).toHaveLength(1)
    expect(filterSharePickerSessionsByScope(merged, 'space-a')[0]?.session.id).toBe('a')
    expect(filterSharePickerSessionsByScope(merged, 'recent')).toHaveLength(2)
  })

  it('buildSharePickerNavItems 最近等于各现场之和（即使 session.space_id 漂移）', () => {
    const merged = [
      entry(makeSession({ id: 'a', space_id: 'space-b' }), 'space-a'),
      entry(makeSession({ id: 'b', space_id: undefined }), 'space-b'),
      entry(makeSession({ id: 'c', space_id: 'team-space' }), 'space-a'),
    ]
    const items = buildSharePickerNavItems(
      [
        { id: 'space-a', name: '产品探索' },
        { id: 'space-b', name: '研发现场' },
      ],
      merged,
      t,
    )
    expect(items[0]?.key).toBe('recent')
    expect(items[0]?.count).toBe(3)
    expect(items.find((item) => item.key === 'space-a')?.count).toBe(2)
    expect(items.find((item) => item.key === 'space-b')?.count).toBe(1)
    const workspaceSum = items
      .filter((item) => item.key !== 'recent')
      .reduce((sum, item) => sum + item.count, 0)
    expect(items[0]?.count).toBe(workspaceSum)
  })

  it('mergeSharePickerSessions 去重合并并保留桶归属', () => {
    const merged = mergeSharePickerSessions(['space-a', 'space-b'], {
      'space-a': [
        makeSession({ id: 'a', space_id: null as unknown as string }),
        makeSession({ id: 'a', space_id: 'space-a' }),
      ],
      'space-b': [makeSession({ id: 'b', space_id: 'space-a' })],
    })
    expect(merged).toHaveLength(2)
    expect(merged.find((item) => item.session.id === 'a')?.sourceSpaceId).toBe('space-a')
    expect(merged.find((item) => item.session.id === 'b')?.sourceSpaceId).toBe('space-b')
  })
})
