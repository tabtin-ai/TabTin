import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.fn()
const navigateToNewTask = vi.fn()
const resolveNewTaskConversationTarget = vi.fn()
const openTableTabGuarded = vi.fn()
const openResourceTabGuarded = vi.fn()
const expandCanvasForScope = vi.fn()

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toast(...args),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}))

vi.mock('@/services/newTaskDraftNavigation', () => ({
  navigateToNewTask: (...args: unknown[]) => navigateToNewTask(...args),
  resolveNewTaskConversationTarget: (...args: unknown[]) => resolveNewTaskConversationTarget(...args),
}))

vi.mock('@components/context-space/restore/openResourceMembershipGuard', () => ({
  openTableTabGuarded: (...args: unknown[]) => openTableTabGuarded(...args),
  openResourceTabGuarded: (...args: unknown[]) => openResourceTabGuarded(...args),
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: (...args: unknown[]) => expandCanvasForScope(...args),
}))

vi.mock('@/utils/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return {
    createLogger: () => stub,
    logger: stub,
  }
})

import { useContextInjectionStore } from '@/stores/useContextInjectionStore'
import { sendSelectionToChat } from '../sendSelectionToChat'

const TABLE_PAYLOAD = {
  type: 'table_selection' as const,
  resourceId: 'table-1',
  label: '表 · 字段 · 值',
  spaceId: 'space-res',
  preview: '值',
  meta: { record_ids: ['r1'], field_ids: ['f1'] },
  tabType: 'tabdata',
}

beforeEach(() => {
  vi.clearAllMocks()
  useContextInjectionStore.setState({
    activeScopeId: null,
    contextRefsByScopeId: {},
  })
  resolveNewTaskConversationTarget.mockReturnValue({
    spaceId: 'space-1',
    isProjectNavActive: false,
  })
})

describe('sendSelectionToChat', () => {
  it('对话模式：有 activeScope 时只注入，不创建新任务', () => {
    useContextInjectionStore.getState().setActiveScope('session-abc')

    const result = sendSelectionToChat({
      payload: TABLE_PAYLOAD,
      resource: {
        kind: 'tabdata',
        id: 'table-1',
        title: '表',
        spaceId: 'space-res',
        meta: { viewId: 'view-1' },
      },
    })

    expect(result).toEqual({
      ok: true,
      mode: 'active-scope',
      scopeId: 'session-abc',
    })
    expect(navigateToNewTask).not.toHaveBeenCalled()
    expect(openTableTabGuarded).not.toHaveBeenCalled()
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-abc']).toHaveLength(1)
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-abc'][0]).toMatchObject({
      type: 'table_selection',
      resourceId: 'table-1',
      label: '表 · 字段 · 值',
      meta: expect.objectContaining({
        record_ids: ['r1'],
        field_ids: ['f1'],
      }),
    })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已加入对话',
      description: '表 · 字段 · 值',
    }))
  })

  it('工作台：无 activeScope 时进入新任务草稿，写入两个正确 scope 并展开画布', () => {
    const result = sendSelectionToChat({
      payload: TABLE_PAYLOAD,
      resource: {
        kind: 'tabdata',
        id: 'table-1',
        title: '表',
        spaceId: 'space-res',
        meta: { viewId: 'view-1' },
      },
    })

    expect(navigateToNewTask).toHaveBeenCalledWith('space-1', { isProjectNavActive: false })
    expect(result).toEqual({
      ok: true,
      mode: 'new-task-draft',
      spaceId: 'space-1',
      composerScopeId: '__draft__:space-1',
      tabScopeKey: 'conversation:draft:space-1',
    })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-1']).toHaveLength(1)
    expect(useContextInjectionStore.getState().activeScopeId).toBe('__draft__:space-1')
    expect(openTableTabGuarded).toHaveBeenCalledWith(
      'conversation:draft:space-1',
      'table-1',
      expect.objectContaining({
        refreshSpaceId: 'space-res',
        meta: expect.objectContaining({ viewId: 'view-1', spaceId: 'space-res' }),
      }),
    )
    expect(expandCanvasForScope).toHaveBeenCalledWith('conversation:draft:space-1')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已创建新任务并加入引用',
    }))
  })

  it('Project 上下文：沿用 resolve 结果的 isProjectNavActive', () => {
    resolveNewTaskConversationTarget.mockReturnValue({
      spaceId: 'team-space-1',
      isProjectNavActive: true,
    })

    sendSelectionToChat({
      payload: {
        type: 'doc_selection',
        resourceId: 'doc-1',
        label: '文档 · 选区',
        preview: '段落',
        meta: { full_text: '段落', block_ids: ['b1'] },
        tabType: 'tabdoc',
      },
      resource: {
        kind: 'tabdoc',
        id: 'doc-1',
        title: '文档',
        spaceId: 'team-space-1',
      },
    })

    expect(navigateToNewTask).toHaveBeenCalledWith('team-space-1', { isProjectNavActive: true })
    expect(openResourceTabGuarded).toHaveBeenCalledWith(
      'conversation:draft:team-space-1',
      expect.objectContaining({ type: 'tabdoc', id: 'doc-1', title: '文档' }),
      'team-space-1',
    )
    const refs = useContextInjectionStore.getState().contextRefsByScopeId['__draft__:team-space-1']
    expect(refs?.[0]).toMatchObject({
      type: 'doc_selection',
      meta: expect.objectContaining({
        full_text: '段落',
        block_ids: ['b1'],
      }),
    })
  })

  it('缺工作空间时不假成功', () => {
    resolveNewTaskConversationTarget.mockReturnValue({
      spaceId: null,
      isProjectNavActive: false,
    })

    const result = sendSelectionToChat({
      payload: TABLE_PAYLOAD,
      resource: { kind: 'tabdata', id: 'table-1' },
    })

    expect(result).toEqual({ ok: false, reason: 'no-workspace' })
    expect(navigateToNewTask).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive',
      title: '无法创建新任务',
    }))
  })

  it('缺资源 id 时不假成功', () => {
    const result = sendSelectionToChat({
      payload: TABLE_PAYLOAD,
      resource: { kind: 'tabdata', id: '  ' },
    })

    expect(result).toEqual({ ok: false, reason: 'missing-resource' })
    expect(navigateToNewTask).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive',
    }))
  })
})
