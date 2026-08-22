import React, { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionSelector, type MentionSelectorRef } from './MentionSelector'

const profileCacheMocks = vi.hoisted(() => ({
  ensureProfiles: vi.fn(),
  displayNames: {} as Record<string, string>,
}))

const imStoreMocks = vi.hoisted(() => {
  type Member = Record<string, unknown>
  type RefreshMembers = (
    conversationId: string,
    options?: { supersede?: boolean; invalidateSnapshot?: boolean },
  ) => Promise<void>
  type State = {
    conversationMembers: Record<string, Member[] | undefined>
    conversationMembersLoading: Record<string, boolean>
    refreshConversationMembers: RefreshMembers
  }
  const listeners = new Set<() => void>()
  const refreshConversationMembers = vi.fn<RefreshMembers>(async () => undefined)
  let state: State = {
    conversationMembers: {},
    conversationMembersLoading: {},
    refreshConversationMembers,
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setMembers: (conversationId: string, members: Member[] | undefined) => {
      state = {
        ...state,
        conversationMembers: {
          ...state.conversationMembers,
          [conversationId]: members,
        },
      }
      listeners.forEach((listener) => listener())
    },
    setLoading: (conversationId: string, loading: boolean) => {
      state = {
        ...state,
        conversationMembersLoading: {
          ...state.conversationMembersLoading,
          [conversationId]: loading,
        },
      }
      listeners.forEach((listener) => listener())
    },
    reset: () => {
      state = {
        conversationMembers: {},
        conversationMembersLoading: {},
        refreshConversationMembers,
      }
      refreshConversationMembers.mockClear()
    },
    refreshConversationMembers,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        mentionAll: '所有人',
        mentionAllHint: '提示所有成员',
        mentionMembersSection: '会话内成员',
        noMentionResults: '没有匹配的成员',
        offline: '离线',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('@stores/useIMStore', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  type State = ReturnType<typeof imStoreMocks.getState>
  const useIMStore = <T,>(selector: (state: State) => T): T =>
    ReactModule.useSyncExternalStore(
      imStoreMocks.subscribe,
      () => selector(imStoreMocks.getState()),
      () => selector(imStoreMocks.getState()),
    )
  return { useIMStore }
})

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: { ensureProfiles: typeof profileCacheMocks.ensureProfiles }) => unknown) =>
    selector({ ensureProfiles: profileCacheMocks.ensureProfiles }),
  useDisplayNames: (userIds: string[]) => Object.fromEntries(
    userIds.map((userId) => [userId, profileCacheMocks.displayNames[userId] || userId.slice(0, 8)]),
  ),
}))

const sampleMember = {
  member_type: 'user' as const,
  user_id: 'user-1',
  agent_id: null,
  nickname: '晨曦',
  username: 'morning',
  avatar: 'https://assets.example.com/missing-avatar.png',
  role: 1,
  is_muted: false,
  pinned: false,
  joined_at: null,
}

describe('MentionSelector', () => {
  beforeEach(() => {
    imStoreMocks.reset()
    imStoreMocks.setMembers('group-1', [sampleMember])
    imStoreMocks.setMembers('dm-1', [sampleMember])
    profileCacheMocks.ensureProfiles.mockClear()
    profileCacheMocks.displayNames = {}
  })

  it('头像加载失败时使用与其他 IM 入口一致的默认头像', () => {
    const ref = createRef<MentionSelectorRef>()
    const { container } = render(
      <MentionSelector
        ref={ref}
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const avatar = container.querySelector('img')
    expect(avatar).toBeTruthy()
    fireEvent.error(avatar!)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('晨')).toBeTruthy()
  })

  it('群聊开启 allowMentionAll 时按设计稿展示所有人与成员分组', () => {
    const onSelect = vi.fn()
    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    expect(screen.getByText('所有人')).toBeTruthy()
    expect(screen.getByText('提示所有成员')).toBeTruthy()
    expect(screen.getByText('会话内成员')).toBeTruthy()
    expect(screen.getByText('晨曦')).toBeTruthy()

    fireEvent.mouseDown(screen.getByText('所有人'))
    expect(onSelect).toHaveBeenCalledWith({
      user_id: null,
      agent_id: null,
      member_type: 'all',
      display_name: '所有人',
    })
  })

  it('群聊成员超过 8 人时仍可显示并选择第 9 名成员', () => {
    const onSelect = vi.fn()
    const members = Array.from({ length: 9 }, (_, index) => ({
      ...sampleMember,
      user_id: `user-${index + 1}`,
      nickname: `提及验证成员 ${String(index + 1).padStart(2, '0')}`,
      username: `mention_test_${String(index + 1).padStart(2, '0')}`,
    }))
    imStoreMocks.setMembers('group-1', members)

    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    const ninthMember = screen.getByText('提及验证成员 09')
    expect(ninthMember).toBeTruthy()
    fireEvent.mouseDown(ninthMember)
    expect(onSelect).toHaveBeenCalledWith({
      user_id: 'user-9',
      agent_id: null,
      member_type: 'user',
      display_name: '提及验证成员 09',
    })
  })

  it('群成员详情缺少昵称时使用公开资料中的用户名称而不是短 ID', () => {
    const userId = '6d08c1c9-41f4-4fb5-a7d4-6a64e4874d70'
    const onSelect = vi.fn()
    profileCacheMocks.displayNames = { [userId]: '沈庾涛' }
    imStoreMocks.setMembers('group-1', [
      { ...sampleMember, user_id: userId, nickname: '', username: '' },
    ])

    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    expect(screen.getByText('沈庾涛')).toBeTruthy()
    expect(screen.queryByText('6d08c1c9')).toBeNull()
    expect(profileCacheMocks.ensureProfiles).toHaveBeenCalledWith([userId])

    fireEvent.mouseDown(screen.getByText('沈庾涛'))
    expect(onSelect).toHaveBeenCalledWith({
      user_id: userId,
      agent_id: null,
      member_type: 'user',
      display_name: '沈庾涛',
    })
  })

  it('可以使用公开资料中的用户名称筛选群成员', () => {
    const userId = '81046376-87b6-4045-82a7-11b801bbfa58'
    profileCacheMocks.displayNames = { [userId]: '董俊芬' }
    imStoreMocks.setMembers('group-1', [
      { ...sampleMember, user_id: userId, nickname: '', username: '' },
    ])

    render(
      <MentionSelector
        conversationId="group-1"
        query="董俊"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    expect(screen.getByText('董俊芬')).toBeTruthy()
  })

  it('不会把 Agent 标识当作用户资料 ID 查询', () => {
    imStoreMocks.setMembers('group-1', [{
      ...sampleMember,
      member_type: 'agent',
      user_id: null,
      agent_id: 'agent-1',
      nickname: '协作 Agent',
    }])

    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    expect(screen.getByText('协作 Agent')).toBeTruthy()
    expect(profileCacheMocks.ensureProfiles).not.toHaveBeenCalled()
  })

  it('shows agent owner badge from member snapshot', () => {
    imStoreMocks.setMembers('group-1', [{
      ...sampleMember,
      member_type: 'agent',
      user_id: null,
      agent_id: 'agent-1',
      nickname: '协作 Agent',
      owner_display_name: '张三',
    }])

    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    expect(screen.getByText('协作 Agent')).toBeTruthy()
    expect(screen.getByText('张三')).toBeTruthy()
  })

  it('disables an offline agent so it cannot be selected', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionSelectorRef>()
    imStoreMocks.setMembers('group-1', [{
      ...sampleMember,
      member_type: 'agent',
      user_id: null,
      agent_id: 'agent-offline',
      nickname: '离线助手',
      owner_display_name: '张三',
      is_execution_online: false,
    }])

    render(
      <MentionSelector
        ref={ref}
        conversationId="group-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
        allowMentionAll={false}
      />,
    )

    const row = screen.getByText('离线助手').closest('button')
    expect(row).toBeTruthy()
    expect((row as HTMLButtonElement).disabled).toBe(true)
    expect(row?.getAttribute('data-offline')).toBe('true')
    expect(screen.getByText('离线')).toBeTruthy()

    fireEvent.mouseDown(row!)
    fireEvent.click(row!)
    ref.current?.handleKeyDown({
      key: 'Enter',
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('私聊不展示所有人与成员分组标题', () => {
    render(
      <MentionSelector
        conversationId="dm-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        allowMentionAll={false}
      />,
    )
    expect(screen.queryByText('所有人')).toBeNull()
    expect(screen.queryByText('提示所有成员')).toBeNull()
    // 无「所有人」时仍展示成员，但不套「会话内成员」分组标题（与稿一致：分组服务于所有人区块）
    expect(screen.getByText('晨曦')).toBeTruthy()
  })

  it('共享成员快照替换后立即刷新候选列表', () => {
    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        allowMentionAll
      />,
    )

    expect(screen.getByText('晨曦')).toBeTruthy()

    act(() => {
      imStoreMocks.setMembers('group-1', [{
        ...sampleMember,
        user_id: 'user-2',
        nickname: '新成员',
        username: 'new-member',
      }])
    })

    expect(screen.queryByText('晨曦')).toBeNull()
    expect(screen.getByText('新成员')).toBeTruthy()
  })

  it('权威空快照保持空渲染，同时从共享 Store 做兜底重验', () => {
    imStoreMocks.setMembers('group-1', [])

    const { container } = render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(container.firstChild).toBeNull()
    expect(imStoreMocks.refreshConversationMembers).toHaveBeenCalledWith('group-1', {
      supersede: true,
      invalidateSnapshot: true,
    })
  })

  it('成员快照未加载时请求共享 Store 刷新', async () => {
    imStoreMocks.setMembers('group-1', undefined)

    render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(imStoreMocks.refreshConversationMembers).toHaveBeenCalledWith('group-1', {
        supersede: true,
        invalidateSnapshot: true,
      })
    })
  })

  it('本次打开的校准完成前不暴露缓存的旧成员', async () => {
    let resolveRefresh!: () => void
    imStoreMocks.refreshConversationMembers.mockImplementationOnce(() => {
      imStoreMocks.setLoading('group-1', true)
      return new Promise<void>((resolve) => { resolveRefresh = resolve })
    })

    const { container } = render(
      <MentionSelector
        conversationId="group-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByText('晨曦')).toBeNull()
    expect(container.firstChild).toBeNull()

    act(() => {
      imStoreMocks.setMembers('group-1', [{
        ...sampleMember,
        user_id: 'user-2',
        nickname: '新成员',
      }])
      imStoreMocks.setLoading('group-1', false)
      resolveRefresh()
    })

    expect(await screen.findByText('新成员')).toBeTruthy()
  })
})
