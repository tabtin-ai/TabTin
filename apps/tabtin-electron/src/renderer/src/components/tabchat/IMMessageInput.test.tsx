import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUploadIMAttachment,
  mockOpenResourcePreview,
  mockPromptComposeDialog,
  mockSessionShareDialog,
  mockIMState,
  mockUserProfiles,
  mockEnsureProfiles,
  mockListExternalContacts,
} = vi.hoisted(() => ({
  mockUploadIMAttachment: vi.fn(),
  mockOpenResourcePreview: vi.fn(() => true),
  mockPromptComposeDialog: vi.fn(),
  mockSessionShareDialog: vi.fn(),
  mockIMState: {
    conversations: [{ id: 'conv-1', organization_id: 'wt-1', type: 1 }],
    updateConversation: vi.fn(),
  } as {
    conversations: Array<{
      id: string
      organization_id: string
      type?: number
      name?: string
      dm_peer_user_id?: string | null
      dm_peer_organization_id?: string | null
      is_external?: boolean
      can_send?: boolean
    }>
    updateConversation: ReturnType<typeof vi.fn>
  },
  mockUserProfiles: {} as Record<string, {
    id: string
    nickname: string
    username: string
    avatar: string
  }>,
  mockEnsureProfiles: vi.fn(),
  mockListExternalContacts: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  listExternalContacts: mockListExternalContacts,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) =>
      typeof options?.defaultValue === 'string'
        ? options.defaultValue.replace('{{name}}', options.name ?? '')
        : key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  resolveChoiceTagColors: () => ({ bg: '', text: '', border: '' }),
  FALLBACK_TAG_BG: '',
  FALLBACK_TAG_TEXT: '',
  FALLBACK_TAG_BORDER: '',
  // AttachmentPreview → ChatIconTooltip
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
    { getState: () => ({ user: { id: 'user-1' } }) },
  ),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: typeof mockIMState) => unknown) => selector(mockIMState),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfile: (userId: string | null | undefined) =>
    userId ? mockUserProfiles[userId] : undefined,
  useUserProfileCache: (selector: (state: { ensureProfiles: typeof mockEnsureProfiles }) => unknown) =>
    selector({ ensureProfiles: mockEnsureProfiles }),
}))

vi.mock('@/services/tabchatAttachmentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/tabchatAttachmentApi')>()
  return {
    ...actual,
    uploadIMAttachment: mockUploadIMAttachment,
  }
})

vi.mock('./IMResourcePickerDialog', () => ({
  IMResourcePickerDialog: ({
    isOpen,
    onPick,
    onClose,
  }: {
    isOpen: boolean
    onPick: (ref: { type: 'document'; resourceId: string; name: string }) => void
    onClose: () => void
  }) => isOpen
    ? React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            onPick({ type: 'document', resourceId: 'doc-1', name: '方案文档' })
            onClose()
          },
        },
        'resource-picker-open',
      )
    : null,
}))

vi.mock('./ContactPickerDialog', () => ({
  ContactPickerDialog: ({ isOpen }: { isOpen: boolean }) => isOpen
    ? React.createElement('div', null, 'contact-picker-open')
    : null,
}))

vi.mock('./PromptComposeDialog', () => ({
  PromptComposeDialog: (props: { isOpen: boolean; recipientName?: string | null }) => {
    mockPromptComposeDialog(props)
    return props.isOpen
      ? React.createElement('div', null, 'prompt-compose-open')
      : null
  },
}))

vi.mock('./SessionSharePickerDialog', () => ({
  SessionSharePickerDialog: (props: { isOpen: boolean; conversationId?: string }) => {
    mockSessionShareDialog(props)
    return props.isOpen
      ? React.createElement('div', null, 'session-share-picker-open')
      : null
  },
}))

vi.mock('./CodexSessionShareDialog', () => ({
  CodexSessionShareDialog: ({ isOpen }: { isOpen: boolean }) => isOpen
    ? React.createElement('div', null, 'codex-session-share-open')
    : null,
}))

vi.mock('./MentionSelector', () => ({
  MentionSelector: ({ onSelect }: {
    onSelect: (target: {
      user_id: string | null
      agent_id: string | null
      member_type: 'agent'
      display_name: string
    }) => void
  }) => React.createElement('button', {
    type: 'button',
    'aria-label': 'select-agent-mention',
    onClick: () => onSelect({
      user_id: null,
      agent_id: 'agent-pig',
      member_type: 'agent',
      display_name: '快乐猪窝',
    }),
  }),
}))

vi.mock('./EmojiPanel', () => ({
  EmojiPanel: ({
    onPickSticker,
  }: {
    onPickSticker?: (sticker: { id: string; labelKey: string; src: string }) => void
  }) => React.createElement(
    'button',
    {
      type: 'button',
      'data-testid': 'mock-pick-sticker',
      onClick: () => onPickSticker?.({
        id: 'happy',
        labelKey: 'stickers.happy',
        src: 'happy.svg',
      }),
    },
    'pick-sticker',
  ),
}))

vi.mock('./stickers/stickerSrcToFile', () => ({
  stickerSrcToFile: vi.fn(async () => new File(['sticker'], 'tabtin-happy.png', { type: 'image/png' })),
}))

// 待发附件直接复用 Agent AttachmentPreview → useComposerAttachmentPreview。
vi.mock('@components/chat/preview/inferPreviewableKind', () => ({
  inferPreviewableKind: (_mime?: string, fileName?: string) => {
    if (fileName?.endsWith('.png') || fileName?.endsWith('.jpg')) return 'image'
    if (fileName?.endsWith('.pdf')) return 'pdf'
    return null
  },
}))
vi.mock('@components/chat/preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: Object.assign(
    (selector: (state: { open: typeof mockOpenResourcePreview }) => unknown) =>
      selector({ open: mockOpenResourcePreview }),
    {
      getState: () => ({
        open: mockOpenResourcePreview,
        close: vi.fn(),
        isOpen: false,
      }),
    },
  ),
}))

describe('IMMessageInput', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockListExternalContacts.mockReset()
    mockListExternalContacts.mockResolvedValue({ items: [] })
    mockIMState.conversations = [{ id: 'conv-1', organization_id: 'wt-1', type: 1 }]
    for (const userId of Object.keys(mockUserProfiles)) delete mockUserProfiles[userId]
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `attachment-${Date.now()}`) })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview-image'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    mockUploadIMAttachment.mockResolvedValue({
      file_id: 'file-1',
      file_name: 'preview.png',
      file_size: 68,
      file_type: 'image/png',
      image_width: 844,
      image_height: 1152,
      access_url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=im%2Fattachments%2Fpreview.png',
      cdn_url: '',
    })
  })

  it('首次私聊输入框使用用户资料姓名，而不是会话里的原始用户 ID', async () => {
    const peerUserId = '81046376-d1a1-42a0-ab15-ff7c85628c8d'
    mockIMState.conversations = [{
      id: 'conv-dm-1',
      organization_id: 'wt-1',
      type: 1,
      name: peerUserId,
      dm_peer_user_id: peerUserId,
    }]
    mockUserProfiles[peerUserId] = {
      id: peerUserId,
      nickname: '殷',
      username: 'yin',
      avatar: '',
    }
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput conversationId="conv-dm-1" onSend={vi.fn()} isSending={false} />,
    )

    expect(screen.getByPlaceholderText('发给 殷')).toBeTruthy()
    expect(screen.queryByPlaceholderText(`发给 ${peerUserId}`)).toBeNull()
    expect(mockPromptComposeDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipientName: '殷' }),
    )
  })

  it('首次私聊资料加载前不暴露用户 ID，加载后更新为姓名', async () => {
    const peerUserId = '81046376-d1a1-42a0-ab15-ff7c85628c8d'
    mockIMState.conversations = [{
      id: 'conv-dm-loading',
      organization_id: 'wt-1',
      type: 1,
      name: peerUserId,
      dm_peer_user_id: peerUserId,
    }]
    const { IMMessageInput } = await import('./IMMessageInput')

    const view = render(
      <IMMessageInput conversationId="conv-dm-loading" onSend={vi.fn()} isSending={false} />,
    )

    expect(screen.getByPlaceholderText('typeMessage')).toBeTruthy()
    expect(screen.queryByPlaceholderText(`发给 ${peerUserId}`)).toBeNull()
    expect(mockEnsureProfiles).toHaveBeenCalledWith([peerUserId])

    mockUserProfiles[peerUserId] = {
      id: peerUserId,
      nickname: '殷',
      username: 'yin',
      avatar: '',
    }
    view.rerender(
      <IMMessageInput conversationId="conv-dm-loading" onSend={vi.fn()} isSending={false} />,
    )

    expect(screen.getByPlaceholderText('发给 殷')).toBeTruthy()
    expect(screen.queryByPlaceholderText(`发给 ${peerUserId}`)).toBeNull()
    expect(mockPromptComposeDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipientName: '殷' }),
    )
  })

  it('stages a cloud resource and sends it together with typed text', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput
        conversationId="conv-1"
        onSend={onSend}
        isSending={false}
      />,
    )

    fireEvent.click(screen.getByTitle('添加'))

    expect(screen.getByText('本地文件')).toBeTruthy()
    expect(screen.getByText('云文件')).toBeTruthy()
    expect(screen.getByText('发送名片')).toBeTruthy()
    // 名片只保留「添加」菜单入口，输入框右侧不再放快捷按钮。
    expect(screen.queryByTitle('发送名片')).toBeNull()
    const attachMenu = document.querySelector('[data-im-attach-menu]') as HTMLElement
    expect(attachMenu.classList.contains('fixed')).toBe(true)
    expect(attachMenu.style.left).not.toBe('')

    fireEvent.click(screen.getByText('云文件'))
    fireEvent.click(screen.getByText('resource-picker-open'))

    expect(screen.getByText('方案文档')).toBeTruthy()
    expect(document.querySelector('[data-im-pending-resource]')).toBeTruthy()
    expect(onSend).not.toHaveBeenCalled()
    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    const visual = screen.getByTestId('im-mention-composer-visual')
    await vi.waitFor(() => expect(document.activeElement).toBe(visual))

    fireEvent.change(textarea, { target: { value: '请看这份方案' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith(
      '请看这份方案',
      undefined,
      1,
      expect.objectContaining({
        card: expect.objectContaining({
          type: 'document',
          resource_id: 'doc-1',
          name: '方案文档',
          caption: '请看这份方案',
        }),
      }),
    )
    expect(document.querySelector('[data-im-pending-resource]')).toBeNull()
  })

  it('passes the active TabTin conversation to the session-share picker', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    expect(mockSessionShareDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
  })

  it('shows a send button that highlights when there is content to send', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput conversationId="conv-1" onSend={onSend} isSending={false} />,
    )

    const sendButton = screen.getByLabelText('发送') as HTMLButtonElement
    expect(sendButton.className).toContain('bg-muted/30')
    expect(sendButton.disabled).toBe(true)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '你好' } })

    expect(sendButton.disabled).toBe(false)
    expect(sendButton.className).toContain('bg-accent')

    fireEvent.click(sendButton)
    expect(onSend).toHaveBeenCalledWith('你好', undefined, undefined, undefined)
  })

  it('keeps over-limit content in the composer and blocks sending', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput conversationId="conv-1" onSend={onSend} isSending={false} />,
    )

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    const overLimitContent = '字'.repeat(5_000)
    fireEvent.change(textarea, { target: { value: overLimitContent } })

    expect(textarea.value).toBe(overLimitContent)
    expect(screen.getByTestId('im-message-too-long')).toBeTruthy()
    expect((screen.getByLabelText('发送') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables sending when the conversation disappears after access is revoked', async () => {
    mockIMState.conversations = []
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput conversationId="conv-removed" onSend={onSend} isSending={false} />,
    )

    const textarea = screen.getByPlaceholderText('你已不在此群聊中') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: '还能发吗' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps a removed member DM readable but disables new messages', async () => {
    mockIMState.conversations = [{
      id: 'dm-removed-peer',
      organization_id: 'wt-1',
      type: 1,
      name: '原成员',
      dm_peer_user_id: 'removed-user',
    }]
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput
        conversationId="dm-removed-peer"
        onSend={onSend}
        isSending={false}
        membersLoaded
        members={[
          {
            member_type: 'user',
            user_id: 'user-1',
            agent_id: null,
            nickname: 'Alice',
            username: 'alice',
            avatar: '',
            role: 3,
            is_muted: false,
            pinned: false,
            joined_at: null,
          },
        ]}
      />,
    )

    const textarea = screen.getByPlaceholderText('该成员已退出组织，无法发送消息') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(mockIMState.conversations).toHaveLength(1)
    fireEvent.change(textarea, { target: { value: '还能发吗' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps a removed external contact DM readable but disables new messages', async () => {
    mockIMState.conversations = [{
      id: 'dm-removed-contact',
      organization_id: 'wt-1',
      type: 1,
      name: '外部联系人',
      dm_peer_user_id: 'external-user',
      dm_peer_organization_id: 'external-org',
      is_external: true,
    }]
    mockListExternalContacts.mockResolvedValue({
      items: [{ peer_user_id: 'external-user', peer_organization_id: 'external-org', relationship: 'removed' }],
    })
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput
        conversationId="dm-removed-contact"
        onSend={onSend}
        isSending={false}
      />,
    )

    const textarea = await screen.findByPlaceholderText(
      '外部联系人当前不可发送消息',
    ) as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(mockIMState.updateConversation).toHaveBeenCalledWith(
      'dm-removed-contact',
      { external_contact_relationship: 'removed' },
    )
    expect(onSend).not.toHaveBeenCalled()
  })

  it('enables an external DM after confirming an active contact relationship', async () => {
    mockIMState.conversations = [{
      id: 'dm-active-contact',
      organization_id: 'wt-1',
      type: 1,
      name: '外部联系人',
      dm_peer_user_id: 'external-user',
      dm_peer_organization_id: 'external-org',
      is_external: true,
    }]
    mockListExternalContacts.mockResolvedValue({
      items: [
        { peer_user_id: 'external-user', peer_organization_id: 'wrong-org', relationship: 'removed' },
        { peer_user_id: 'external-user', peer_organization_id: 'external-org', relationship: 'friend' },
      ],
    })
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput
        conversationId="dm-active-contact"
        onSend={onSend}
        isSending={false}
      />,
    )

    const textarea = await screen.findByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '还可以发送' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('还可以发送', undefined, undefined, undefined)
  })

  it('renders a left external group as read-only', async () => {
    mockIMState.conversations = [{
      id: 'external-group-left',
      organization_id: 'wt-1',
      type: 2,
      name: '客户协作群',
      is_external: true,
      can_send: false,
    }]
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput
        conversationId="external-group-left"
        onSend={onSend}
        isSending={false}
      />,
    )

    const textarea = screen.getByPlaceholderText(
      '你已退出该群，只能查看历史消息',
    ) as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(screen.queryByTitle('发送')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not reuse contact access across external DMs with the same peer user in different organizations', async () => {
    mockIMState.conversations = [
      {
        id: 'dm-peer-org-a',
        organization_id: 'wt-1',
        type: 1,
        name: '外部联系人 A',
        dm_peer_user_id: 'external-user',
        dm_peer_organization_id: 'external-org-a',
        is_external: true,
      },
      {
        id: 'dm-peer-org-b',
        organization_id: 'wt-1',
        type: 1,
        name: '外部联系人 B',
        dm_peer_user_id: 'external-user',
        dm_peer_organization_id: 'external-org-b',
        is_external: true,
      },
    ]
    mockListExternalContacts
      .mockResolvedValueOnce({
        items: [
          { peer_user_id: 'external-user', peer_organization_id: 'external-org-a', relationship: 'friend' },
        ],
      })
      // 第二段关系还没确认完，此时不能沿用前一段关系的放行状态。
      .mockReturnValueOnce(new Promise(() => {}))
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    const { rerender } = render(
      <IMMessageInput conversationId="dm-peer-org-a" onSend={onSend} isSending={false} />,
    )
    expect((await screen.findByPlaceholderText('typeMessage') as HTMLTextAreaElement).disabled)
      .toBe(false)

    rerender(
      <IMMessageInput conversationId="dm-peer-org-b" onSend={onSend} isSending={false} />,
    )

    const peerBTextarea = screen.getByPlaceholderText(
      '正在确认外部联系人关系…',
    ) as HTMLTextAreaElement
    expect(peerBTextarea.disabled).toBe(true)
    fireEvent.change(peerBTextarea, { target: { value: '不该发出去' } })
    fireEvent.keyDown(peerBTextarea, { key: 'Enter', code: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not treat a contact lookup failure as a removed relationship', async () => {
    mockIMState.conversations = [{
      id: 'dm-contact-lookup-failed',
      organization_id: 'wt-1',
      type: 1,
      name: '外部联系人',
      dm_peer_user_id: 'external-user',
      dm_peer_organization_id: 'external-org',
      is_external: true,
    }]
    mockListExternalContacts.mockRejectedValue(new Error('network unavailable'))
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')

    render(
      <IMMessageInput
        conversationId="dm-contact-lookup-failed"
        onSend={onSend}
        isSending={false}
      />,
    )

    const textarea = await screen.findByPlaceholderText(
      '外部联系人当前不可发送消息',
    ) as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(mockIMState.updateConversation).not.toHaveBeenCalledWith(
      'dm-contact-lookup-failed',
      { external_contact_relationship: 'removed' },
    )
  })

  it.each(['suspended', 'blocked'] as const)(
    'disables sending to a %s external contact',
    async (relationship) => {
      mockIMState.conversations = [{
        id: `dm-${relationship}-contact`,
        organization_id: 'wt-1',
        type: 1,
        name: '外部联系人',
        dm_peer_user_id: 'external-user',
        dm_peer_organization_id: 'external-org',
        is_external: true,
      }]
      mockListExternalContacts.mockResolvedValue({
        items: [{ peer_user_id: 'external-user', peer_organization_id: 'external-org', relationship }],
      })
      const onSend = vi.fn()
      const { IMMessageInput } = await import('./IMMessageInput')

      render(
        <IMMessageInput
          conversationId={`dm-${relationship}-contact`}
          onSend={onSend}
          isSending={false}
        />,
      )

      const textarea = await screen.findByPlaceholderText(
        '外部联系人当前不可发送消息',
      ) as HTMLTextAreaElement
      expect(textarea.disabled).toBe(true)
      fireEvent.change(textarea, { target: { value: '仍按原策略发送' } })
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
    },
  )

  it('opens the contact picker from the add menu', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    fireEvent.click(screen.getByTitle('添加'))
    fireEvent.click(screen.getByText('发送名片'))

    expect(screen.getByText('contact-picker-open')).toBeTruthy()
    expect(document.querySelector('[data-im-attach-menu]')).toBeNull()
  })

  it('exposes Codex session sharing to every valid organization', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    const { rerender } = render(
      <IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />,
    )

    fireEvent.click(screen.getByTitle('添加'))
    expect(screen.getByText('Codex 会话')).toBeTruthy()

    mockIMState.conversations = []
    rerender(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)
    expect(screen.queryByText('Codex 会话')).toBeNull()
  })

  // ：飞书风输入井 — 不透明卡片 + 两侧 gutter，避免与消息叠影 / 整条底栏铺满
  it('renders an opaque composer surface inset from the chat edges', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    const { container } = render(
      <IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />,
    )

    const root = container.firstElementChild as HTMLElement
    // 左缘与消息行 `px-4` 对齐；右缘另加滚动条补偿（见 --im-scrollbar-compensation）
    expect(root.classList.contains('pl-4')).toBe(true)
    expect(root.className).toContain('--im-scrollbar-compensation')
    expect(root.classList.contains('max-w-3xl')).toBe(false)

    const surface = screen.getByTestId('im-composer-surface')
    expect(surface.classList.contains('bg-background')).toBe(true)
    expect(surface.classList.contains('rounded-xl')).toBe(true)
    expect(document.querySelector('[data-im-composer]')).toBeTruthy()
  })

  // 回归：加号 / 表情浮层 portal 到 body（fixed），避免 surface 裁切。
  it('does not clip attach/emoji popovers with overflow-hidden on the composer surface', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const surface = screen.getByTestId('im-composer-surface')
    // 圆角裁切不能牺牲向上弹出的浮层；圆角靠 ring + rounded 即可。
    expect(surface.className.split(/\s+/)).not.toContain('overflow-hidden')

    fireEvent.click(screen.getByTitle('添加'))
    const attachMenu = document.querySelector('[data-im-attach-menu]') as HTMLElement
    expect(attachMenu).toBeTruthy()
    expect(attachMenu.classList.contains('fixed')).toBe(true)
    expect(surface.contains(attachMenu)).toBe(false)
    expect(document.body.contains(attachMenu)).toBe(true)

    fireEvent.click(screen.getByTitle('表情'))
    const emojiPanel = document.querySelector('[data-im-emoji-panel]') as HTMLElement | null
    expect(emojiPanel).toBeTruthy()
    expect(emojiPanel?.classList.contains('fixed')).toBe(true)
    expect(surface.contains(emojiPanel)).toBe(false)
    expect(surface.className.split(/\s+/)).not.toContain('overflow-hidden')
  })

  it('stages an image in the composer and only uploads it after send', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')
    const { container } = render(
      <IMMessageInput conversationId="conv-1" onSend={onSend} isSending={false} />,
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    const image = new File(['image'], 'preview.png', { type: 'image/png' })
    textarea.blur()

    fireEvent.change(input, { target: { files: [image] } })

    expect(screen.getByAltText('preview.png')).toBeTruthy()
    const visual = screen.getByTestId('im-mention-composer-visual')
    await vi.waitFor(() => expect(document.activeElement).toBe(visual))
    expect(mockUploadIMAttachment).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.change(textarea, { target: { value: '图片说明' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(mockUploadIMAttachment).toHaveBeenCalledWith(
      image,
      expect.any(Function),
      undefined,
      'conv-1',
    ))
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith(
      '图片说明',
      undefined,
      4,
      expect.objectContaining({
        file_id: 'file-1',
        file_name: 'preview.png',
        image_width: 844,
        image_height: 1152,
      }),
    ))
    const attachmentMetadata = onSend.mock.calls[0][3]
    expect(attachmentMetadata).not.toHaveProperty('access_url')
    expect(attachmentMetadata).not.toHaveProperty('cdn_url')
    expect(attachmentMetadata).not.toHaveProperty('__client_local_path')
    await vi.waitFor(() => expect(screen.queryByAltText('preview.png')).toBeNull())
  })

  it('opens Agent lightbox when clicking a staged image before send', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    const { container } = render(
      <IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />,
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const image = new File(['image'], 'preview.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [image] } })

    // 与 Agent AttachmentPreview 同款：缩略图按钮 aria-label = 查看图片
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }))

    expect(mockOpenResourcePreview).toHaveBeenCalledWith([
      expect.objectContaining({
        id: expect.stringMatching(/^composer:/),
        kind: 'image',
        url: 'blob:preview-image',
        name: 'preview.png',
        mimeType: 'image/png',
      }),
    ])
  })

  it('toggles the format toolbar with the format button', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    // 默认收起：无加粗按钮
    expect(screen.queryByTitle('加粗')).toBeNull()
    // 点「格式」展开
    fireEvent.click(screen.getByTitle('格式'))
    expect(screen.getByTitle('加粗')).toBeTruthy()
    expect(screen.getByTitle('无序列表')).toBeTruthy()
    // 再点收起
    fireEvent.click(screen.getByTitle('格式'))
    expect(screen.queryByTitle('加粗')).toBeNull()
  })

  it('wraps the selection in bold markers via the toolbar', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello' } })
    textarea.setSelectionRange(0, 5)

    fireEvent.click(screen.getByTitle('格式'))
    fireEvent.mouseDown(screen.getByTitle('加粗'))

    expect(textarea.value).toBe('**hello**')
  })

  it('prefixes lines with a bullet via the toolbar', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'item' } })
    textarea.setSelectionRange(0, 0)

    fireEvent.click(screen.getByTitle('格式'))
    fireEvent.mouseDown(screen.getByTitle('无序列表'))

    expect(textarea.value).toBe('- item')
  })

  it('prefixes selected lines with incrementing ordered-list markers', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'alpha\nbeta\ngamma' } })
    textarea.setSelectionRange(0, textarea.value.length)

    fireEvent.click(screen.getByTitle('格式'))
    fireEvent.mouseDown(screen.getByTitle('有序列表'))

    expect(textarea.value).toBe('1. alpha\n2. beta\n3. gamma')
  })

  it('renumbers selected ordered-list lines instead of preserving repeated 1 markers', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '1. alpha\n1. beta\n1. gamma' } })
    textarea.setSelectionRange(0, textarea.value.length)

    fireEvent.click(screen.getByTitle('格式'))
    fireEvent.mouseDown(screen.getByTitle('有序列表'))

    expect(textarea.value).toBe('1. alpha\n2. beta\n3. gamma')
  })

  it('renumbers the current ordered-list line without duplicating markers', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '1. alpha' } })
    textarea.setSelectionRange(0, 0)

    fireEvent.click(screen.getByTitle('格式'))
    fireEvent.mouseDown(screen.getByTitle('有序列表'))

    expect(textarea.value).toBe('1. alpha')
  })

  it('手动输入 @AI 也会携带 mentioned_agent_ids', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')
    render(
      <IMMessageInput
        conversationId="conv-1"
        onSend={onSend}
        isSending={false}
        members={[
          {
            member_type: 'agent',
            user_id: null,
            agent_id: 'agent-pig',
            nickname: '快乐猪窝',
            username: '',
            avatar: '',
            role: 0,
            is_muted: false,
            pinned: false,
            joined_at: null,
          },
        ]}
      />,
    )

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@快乐猪窝 你看看群里有啥?' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith(
      '@快乐猪窝 你看看群里有啥?',
      undefined,
      undefined,
      { mentioned_agent_ids: ['agent-pig'] },
    )
  })

  it('在可视化输入框键入 @ 会打开 mention 菜单', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const visual = screen.getByTestId('im-mention-composer-visual')
    visual.textContent = '@'
    const textNode = visual.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(visual)

    expect(screen.getByLabelText('select-agent-mention')).toBeTruthy()
  })

  it('可视化输入框光标在 @ 前面时不打开 mention 菜单', async () => {
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={vi.fn()} isSending={false} />)

    const visual = screen.getByTestId('im-mention-composer-visual')
    visual.textContent = '@'
    const textNode = visual.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(visual)

    expect(screen.queryByLabelText('select-agent-mention')).toBeNull()
  })

  it('从选择器选中 Agent 时插入带 id 的 markdown 链接', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={onSend} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@快' } })
    fireEvent.click(screen.getByLabelText('select-agent-mention'))
    expect(textarea.value).toBe('[@快乐猪窝](mention:agent/agent-pig) ')
    const visual = screen.getByTestId('im-mention-composer-visual')
    expect(visual.textContent).toContain('@快乐猪窝')
    expect(visual.textContent).not.toContain('mention:agent/')
    expect(visual.textContent).not.toContain('](')
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith(
      '[@快乐猪窝](mention:agent/agent-pig)',
      undefined,
      undefined,
      { mentioned_agent_ids: ['agent-pig'] },
    )
  })

  it('选中 Agent 后删掉 @ 文案不会继续触发', async () => {
    const onSend = vi.fn()
    const { IMMessageInput } = await import('./IMMessageInput')
    render(<IMMessageInput conversationId="conv-1" onSend={onSend} isSending={false} />)

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@快' } })
    fireEvent.click(screen.getByLabelText('select-agent-mention'))
    fireEvent.change(textarea, { target: { value: '普通消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('普通消息', undefined, undefined, undefined)
  })

  it('手动输入 @所有人 会携带 mention_all', async () => {
    const onSend = vi.fn()
    mockIMState.conversations = [{
      id: 'group-1',
      organization_id: 'wt-1',
      type: 2,
      name: '项目群',
    }]
    const { IMMessageInput } = await import('./IMMessageInput')
    render(
      <IMMessageInput
        conversationId="group-1"
        onSend={onSend}
        isSending={false}
        allowMentionAll
        members={[
          {
            member_type: 'user',
            user_id: 'user-a',
            agent_id: null,
            nickname: '晨曦',
            username: 'morning',
            avatar: '',
            role: 1,
            is_muted: false,
            pinned: false,
            joined_at: null,
          },
        ]}
      />,
    )

    const textarea = screen.getByPlaceholderText('发给 项目群') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@所有人 今晚开会' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith(
      '@所有人 今晚开会',
      undefined,
      undefined,
      { mention_all: true },
    )
  })

  it('私聊即使手打 @所有人 也不带 mention_all', async () => {
    const onSend = vi.fn()
    mockIMState.conversations = [{
      id: 'dm-1',
      organization_id: 'wt-1',
      type: 1,
      name: '好友',
      dm_peer_user_id: null,
    }]
    const { IMMessageInput } = await import('./IMMessageInput')
    render(
      <IMMessageInput
        conversationId="dm-1"
        onSend={onSend}
        isSending={false}
        allowMentionAll={false}
        members={[]}
      />,
    )

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@所有人 测试' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('@所有人 测试', undefined, undefined, undefined)
  })

  it('sends a TabTin sticker as IMAGE with metadata.sticker', async () => {
    const onSend = vi.fn()
    mockUploadIMAttachment.mockResolvedValueOnce({
      file_id: 'sticker-file-1',
      file_name: 'tabtin-happy.png',
      file_size: 42,
      file_type: 'image/png',
      access_url: 'http://127.0.0.1:6060/sticker.png',
      cdn_url: '',
    })
    const { IMMessageInput } = await import('./IMMessageInput')
    render(
      <IMMessageInput conversationId="conv-1" onSend={onSend} isSending={false} />,
    )

    fireEvent.click(screen.getByTitle('表情'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-pick-sticker'))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(mockUploadIMAttachment).toHaveBeenCalled())
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith(
      '',
      undefined,
      4,
      expect.objectContaining({
        file_id: 'sticker-file-1',
        file_name: 'tabtin-happy.png',
        sticker: { pack: 'tabtin-robot', id: 'happy' },
      }),
    ))
  })
})
