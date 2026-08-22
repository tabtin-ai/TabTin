import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreateConversationAndActivate, mockLoadMembers, mockListExternalContacts, organizationRef, userRef } = vi.hoisted(() => ({
  mockCreateConversationAndActivate: vi.fn(() => Promise.resolve('conv-1')),
  mockLoadMembers: vi.fn(() => Promise.resolve()),
  mockListExternalContacts: vi.fn(),
  organizationRef: {
    current: {
      id: 'ws-1',
      members: [
        {
          user_id: 'user-1',
          user: {
            id: 'user-1',
            username: 'alice',
            nickname: 'Alice',
            email: 'alice@example.com',
          },
        },
        {
          user_id: 'user-2',
          user: {
            id: 'user-2',
            username: 'bob',
            nickname: 'Bob',
            email: 'bob@example.com',
          },
        },
        {
          user_id: 'user-3',
          user: {
            id: 'user-3',
            username: 'carol',
            nickname: 'Carol',
            email: 'carol@example.com',
          },
        },
      ],
    },
  },
  userRef: {
    current: {
      id: 'user-1',
    },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      selectedOrganization: { id: organizationRef.current.id },
      members: organizationRef.current.members,
      isLoadingMembers: false,
      loadMembers: mockLoadMembers,
    }),
    { subscribe: vi.fn(() => vi.fn()) },
  ),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: userRef.current,
    }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      createConversationAndActivate: mockCreateConversationAndActivate,
    }),
}))

vi.mock('@/services/tabchatApi', () => ({
  searchOrganizationMembers: vi.fn().mockResolvedValue([]),
  listExternalContacts: mockListExternalContacts,
}))

const externalContacts = {
  items: [
    {
      contact_id: 'contact-1',
      peer_user_id: 'external-user-1',
      peer_organization_id: 'external-org-1',
      peer_organization_name: '外部团队',
      display_name: '外部联系人甲',
      relationship: 'friend',
    },
    {
      contact_id: 'contact-2',
      peer_user_id: 'external-user-2',
      peer_organization_id: 'external-org-2',
      peer_organization_name: '合作伙伴',
      display_name: '外部联系人乙',
      relationship: 'friend',
    },
  ],
}

import { CreateConversationDialog } from './CreateConversationDialog'

describe('CreateConversationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListExternalContacts.mockResolvedValue(externalContacts)
  })

  it('创建会话时委托 IM store action 处理跨域编排', async () => {
    const onClose = vi.fn()

    render(
      <CreateConversationDialog
        isOpen
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByText('Bob').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'create' }))

    expect(mockLoadMembers).toHaveBeenCalledWith('ws-1')
    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'ws-1',
          kind: 'dm',
          memberIds: ['user-2'],
        }),
      )
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('创建群聊时传递选中的多个成员并使用输入的群名', async () => {
    const onClose = vi.fn()

    render(
      <CreateConversationDialog
        isOpen
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByText('newGroup'))
    expect(screen.getByLabelText('groupNameLabel')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('groupNameLabel'), {
      target: { value: '测试群' },
    })
    fireEvent.click(screen.getByText('Bob').closest('button')!)
    fireEvent.click(screen.getByText('Carol').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'ws-1',
          kind: 'group',
          memberIds: ['user-2', 'user-3'],
          groupName: '测试群',
        }),
      )
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('群聊入口不展示发起私聊切换', async () => {
    render(<CreateConversationDialog isOpen initialTab="group" groupOnly onClose={vi.fn()} />)

    expect(screen.queryByText('newDM')).toBeNull()
    expect(screen.queryByText('newGroup')).toBeNull()
    expect(screen.getByLabelText('groupNameLabel')).toBeTruthy()
  })

  it('群聊只允许选择已添加的外部联系人', async () => {
    render(<CreateConversationDialog isOpen initialTab="group" groupOnly onClose={vi.fn()} />)

    expect(await screen.findByText('外部联系人甲')).toBeTruthy()
    expect(screen.getByText('外部团队')).toBeTruthy()
    expect(screen.queryByLabelText('完整手机号')).toBeNull()
    expect(screen.queryByText('请求添加你为外部联系人')).toBeNull()
  })

  it('群聊候选人不展示不可邀请的外部联系人', async () => {
    mockListExternalContacts.mockResolvedValue({
      items: [
        ...externalContacts.items,
        {
          contact_id: 'contact-blocked',
          peer_user_id: 'external-user-blocked',
          peer_organization_id: 'external-org-blocked',
          peer_organization_name: '已屏蔽团队',
          display_name: '已屏蔽联系人',
          relationship: 'blocked',
        },
        {
          contact_id: 'contact-removed',
          peer_user_id: 'external-user-removed',
          peer_organization_id: 'external-org-removed',
          peer_organization_name: '已解除团队',
          display_name: '已解除联系人',
          relationship: 'removed',
        },
      ],
    })

    render(<CreateConversationDialog isOpen initialTab="group" groupOnly onClose={vi.fn()} />)

    expect(await screen.findByText('外部联系人甲')).toBeTruthy()
    expect(screen.queryByText('已屏蔽联系人')).toBeNull()
    expect(screen.queryByText('已解除联系人')).toBeNull()
  })

  it('没有已添加的外部联系人时使用国际化空态文案', async () => {
    mockListExternalContacts.mockResolvedValue({ items: [] })

    render(<CreateConversationDialog isOpen initialTab="group" groupOnly onClose={vi.fn()} />)

    expect(await screen.findByText('externalContacts.noAddedContacts')).toBeTruthy()
    expect(screen.queryByText('loadFailed')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('外部联系人加载失败时按空列表处理，不提示错误', async () => {
    mockListExternalContacts.mockRejectedValue(new Error('not available'))

    render(<CreateConversationDialog isOpen initialTab="group" groupOnly onClose={vi.fn()} />)

    expect(await screen.findByText('externalContacts.noAddedContacts')).toBeTruthy()
    expect(screen.queryByText('loadFailed')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('群名称固定展示并只让成员列表承担滚动', async () => {
    render(<CreateConversationDialog isOpen initialTab="group" groupOnly onClose={vi.fn()} />)

    const groupNameInput = screen.getByLabelText('groupNameLabel')
    const dialogBody = groupNameInput.closest('.overflow-hidden')
    const memberGrid = screen.getByText('selectMembers').closest('.grid')

    expect(dialogBody?.className).toContain('overflow-hidden')
    expect(groupNameInput.closest('[data-radix-scroll-area-viewport]')).toBeNull()
    expect(memberGrid?.className).toContain('min-h-0')
  })

  it('未填写群名时由统一创建入口生成默认名称', async () => {
    const onClose = vi.fn()

    render(<CreateConversationDialog isOpen initialTab="group" onClose={onClose} />)

    fireEvent.click(screen.getByText('Bob').closest('button')!)
    fireEvent.click(screen.getByText('Carol').closest('button')!)
    // 预览不占据可编辑输入框，最终名称由 Store 的统一入口生成。
    expect((screen.getByLabelText('groupNameLabel') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({ groupName: undefined }),
      )
    })
  })

  it('未填写外部群名时也由统一创建入口生成默认名称', async () => {
    render(<CreateConversationDialog isOpen initialTab="group" onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Bob').closest('button')!)
    fireEvent.click((await screen.findByText('外部联系人甲')).closest('button')!)
    fireEvent.click(screen.getByText('外部联系人乙').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({ groupName: undefined }),
      )
    })
  })

  it('创建失败时展示后端返回的具体原因', async () => {
    mockCreateConversationAndActivate.mockRejectedValueOnce(
      new Error('当前套餐群组额度已用完，请升级套餐或购买群组扩容包。'),
    )
    const onClose = vi.fn()

    render(
      <CreateConversationDialog
        isOpen
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByText('newGroup'))
    fireEvent.click(screen.getByText('Bob').closest('button')!)
    fireEvent.click(screen.getByText('Carol').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))

    expect(await screen.findByText('当前套餐群组额度已用完，请升级套餐或购买群组扩容包。')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('相同建群参数重试时复用幂等键', async () => {
    mockCreateConversationAndActivate
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce('conv-1')

    render(<CreateConversationDialog isOpen initialTab="group" onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Bob').closest('button')!)
    fireEvent.click(screen.getByText('Carol').closest('button')!)
    const createButton = screen.getByRole('button', { name: 'createGroup' })
    fireEvent.click(createButton)
    expect(await screen.findByText('network timeout')).toBeTruthy()
    fireEvent.click(createButton)

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledTimes(2)
    })
    const firstRequestId = mockCreateConversationAndActivate.mock.calls[0][0].clientRequestId
    const secondRequestId = mockCreateConversationAndActivate.mock.calls[1][0].clientRequestId
    expect(firstRequestId).toBeTruthy()
    expect(secondRequestId).toBe(firstRequestId)
  })
})
