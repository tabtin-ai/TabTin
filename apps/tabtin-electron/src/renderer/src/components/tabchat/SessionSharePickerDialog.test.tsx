import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCreateClientRequestId,
  mockCreateSessionContinuation,
  mockCreateSessionShare,
  mockListSessionSharesBySession,
  mockLoadSessions,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockCreateClientRequestId: vi.fn(() => '0198c96d-a000-7000-8000-000000000099'),
  mockCreateSessionContinuation: vi.fn(),
  mockCreateSessionShare: vi.fn(),
  mockListSessionSharesBySession: vi.fn(),
  mockLoadSessions: vi.fn(),
  mockLogWarn: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('lucide-react', () => ({
  Loader2: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-loader2" {...props} />,
  MessagesSquare: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-messages-square" {...props} />,
  Search: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-search" {...props} />,
  Share2: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-share2" {...props} />,
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfirmDialog: ({
    open,
    title,
    confirmText,
    cancelText,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean
    title: string
    confirmText: string
    cancelText: string
    onConfirm: () => Promise<void>
    onOpenChange: (open: boolean) => void
  }) => open ? (
    <div role="alertdialog">
      <div>{title}</div>
      <button onClick={() => onOpenChange(false)}>{cancelText}</button>
      <button onClick={() => { void onConfirm() }}>{confirmText}</button>
    </div>
  ) : null,
  toast: vi.fn(),
}))

const chatStoreState = {
  sessionsBySpaceId: {},
  loadSessions: mockLoadSessions,
}

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof chatStoreState) => unknown) => selector(chatStoreState),
    { getState: () => chatStoreState },
  ),
}))

const spaceStoreState = {
  spaces: [{
    id: 'space-1',
    name: 'Personal',
    type: 'personal',
    is_archived: false,
    organization_id: 'org-1',
  }],
  agentCache: {},
  selectedAgent: null,
}

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof spaceStoreState) => unknown) => selector(spaceStoreState),
}))

const bumpSessionShareListVersion = vi.fn()
const bumpSessionShareDetailVersion = vi.fn()
const setSessionShare = vi.fn()
const setSessionContinuation = vi.fn()

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      bumpSessionShareListVersion,
      bumpSessionShareDetailVersion,
      setSessionShare,
      setSessionContinuation,
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  createSessionContinuation: mockCreateSessionContinuation,
  createSessionShare: mockCreateSessionShare,
  isContinuationLocalFileTooLargeError: (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'LOCAL_FILE_TOO_LARGE'
  ),
  listSessionSharesBySession: mockListSessionSharesBySession,
}))

vi.mock('@/services/im', () => ({
  createClientRequestId: mockCreateClientRequestId,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: mockLogWarn }),
}))

vi.mock('./sessionSharePresentation', () => ({
  SessionShareModeField: ({
    value,
    disabled,
    onChange,
  }: {
    value: string
    disabled?: boolean
    onChange: (value: 'view' | 'fork' | 'control' | 'continue') => void
  }) => (
    <select
      aria-label="协作方式"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as 'view' | 'fork' | 'control' | 'continue')}
    >
      <option value="view">实时查看</option>
      <option value="fork">查看并抄走</option>
      <option value="control">实时协作</option>
      <option value="continue">交给同事继续</option>
    </select>
  ),
  clampToSelectableShareTier: (tier: string) => tier,
  resolveShareTierLevel: () => 'view',
  shareTierToFlags: () => ({ canFork: false, canChat: false }),
}))

vi.mock('./sessionSharePickerPresentation', () => ({
  buildSharePickerNavItems: () => [],
  filterSharePickerSessionsByScope: (entries: unknown[]) => entries,
  matchesSharePickerSearch: () => true,
  mergeSharePickerSessions: () => [{
    session: { id: 'session-1', title: 'Task one' },
    sourceSpaceId: 'space-1',
  }],
  sortSharePickerEntriesByActivity: (entries: unknown[]) => entries,
}))

vi.mock('./ShareSessionPickerNav', () => ({
  ShareSessionPickerNav: () => null,
}))

vi.mock('./ShareSessionPickerRow', () => ({
  ShareSessionPickerRow: ({
    session,
    onSelect,
  }: {
    session: { id: string }
    onSelect: (sessionId: string) => void
  }) => (
    <button type="button" onClick={() => onSelect(session.id)}>{session.id}</button>
  ),
}))

describe('SessionSharePickerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    mockLoadSessions.mockResolvedValue(undefined)
    mockListSessionSharesBySession.mockResolvedValue([])
    mockCreateSessionContinuation.mockResolvedValue({
      object_id: 'continuation-1',
      version: 2,
      role: 'owner',
      title_snapshot: 'Task one',
    })
    mockCreateClientRequestId
      .mockReset()
      .mockReturnValueOnce('0198c96d-a000-7000-8000-000000000099')
      .mockReturnValueOnce('0198c96d-a000-7000-8000-000000000100')
    mockCreateSessionShare
      .mockReset()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue({
        id: 'share-1',
        conversation_id: 'conversation-1',
      })
  })

  afterEach(() => cleanup())

  it('loads share metadata only for the selected task without blocking mode selection', async () => {
    let resolveShares!: (shares: []) => void
    mockListSessionSharesBySession.mockReturnValue(new Promise((resolve) => {
      resolveShares = resolve
    }))

    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    render(
      <SessionSharePickerDialog
        isOpen
        onClose={vi.fn()}
        conversationId="conversation-1"
        organizationId="org-1"
        granteeUserId="user-2"
      />,
    )

    expect(mockListSessionSharesBySession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'session-1' }))

    await waitFor(() => expect(mockListSessionSharesBySession).toHaveBeenCalledOnce())
    expect(mockListSessionSharesBySession).toHaveBeenCalledWith('session-1')
    expect((screen.getByRole('combobox', { name: '协作方式' }) as HTMLSelectElement).disabled)
      .toBe(false)
    expect((screen.getByRole('button', { name: '共享' }) as HTMLButtonElement).disabled)
      .toBe(true)

    resolveShares([])
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '共享' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
  })

  it('keeps a mode picked while shares are still loading', async () => {
    let resolveShares!: (shares: unknown[]) => void
    mockListSessionSharesBySession.mockReturnValue(new Promise((resolve) => {
      resolveShares = resolve
    }))

    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    render(
      <SessionSharePickerDialog
        isOpen
        onClose={vi.fn()}
        conversationId="conversation-1"
        organizationId="org-1"
        granteeUserId="user-2"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'session-1' }))
    await waitFor(() => expect(mockListSessionSharesBySession).toHaveBeenCalledOnce())

    const modeSelect = screen.getByRole('combobox', { name: '协作方式' }) as HTMLSelectElement
    fireEvent.change(modeSelect, { target: { value: 'fork' } })
    expect(modeSelect.value).toBe('fork')

    resolveShares([{
      id: 'share-9',
      grantee_user_id: 'user-2',
      status: 'active',
      can_fork: false,
      can_chat: false,
    }])

    await waitFor(() => {
      expect((screen.getByRole('button', { name: '共享' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    expect((screen.getByRole('combobox', { name: '协作方式' }) as HTMLSelectElement).value)
      .toBe('fork')
  })

  it('reuses one idempotency key for a failed intent and rotates it after success', async () => {
    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    render(
      <SessionSharePickerDialog
        isOpen
        onClose={vi.fn()}
        conversationId="conversation-1"
        organizationId="org-1"
        granteeUserId="user-2"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    const shareButton = screen.getByRole('button', { name: '共享' }) as HTMLButtonElement
    await waitFor(() => expect(shareButton.disabled).toBe(false))
    fireEvent.click(shareButton)

    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(shareButton.disabled).toBe(false))
    fireEvent.click(shareButton)

    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(2))
    expect(mockCreateSessionShare).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      granteeUserId: 'user-2',
      canFork: false,
      canChat: false,
      conversationId: 'conversation-1',
      clientRequestId: '0198c96d-a000-7000-8000-000000000099',
    })
    expect(mockCreateSessionShare).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      granteeUserId: 'user-2',
      canFork: false,
      canChat: false,
      conversationId: 'conversation-1',
      clientRequestId: '0198c96d-a000-7000-8000-000000000099',
    })
    expect(mockCreateClientRequestId).toHaveBeenCalledOnce()

    await waitFor(() => expect(shareButton.disabled).toBe(false))
    fireEvent.click(shareButton)
    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(3))
    expect(mockCreateSessionShare).toHaveBeenNthCalledWith(3, expect.objectContaining({
      clientRequestId: '0198c96d-a000-7000-8000-000000000100',
    }))
    expect(mockCreateClientRequestId).toHaveBeenCalledTimes(2)
  })

  it('sends a task handoff from the direct-message share entry', async () => {
    const onClose = vi.fn()
    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    render(
      <SessionSharePickerDialog
        isOpen
        onClose={onClose}
        conversationId="conversation-1"
        organizationId="org-1"
        granteeUserId="user-2"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    fireEvent.change(screen.getByRole('combobox', { name: '协作方式' }), {
      target: { value: 'continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送转交' }))

    await waitFor(() => expect(mockCreateSessionContinuation).toHaveBeenCalledWith({
      sourceSessionId: 'session-1',
      recipientUserId: 'user-2',
      conversationId: 'conversation-1',
      clientRequestId: '0198c96d-a000-7000-8000-000000000099',
    }))
    expect(mockCreateSessionShare).not.toHaveBeenCalled()
    expect(setSessionContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'continuation-1' }),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('can retry an oversized task handoff as dialogue only', async () => {
    const onClose = vi.fn()
    mockCreateSessionContinuation
      .mockRejectedValueOnce(Object.assign(new Error('分享会话文件超过50MB'), {
        code: 'LOCAL_FILE_TOO_LARGE',
        status: 409,
      }))
      .mockResolvedValueOnce({
        object_id: 'continuation-text-only',
        version: 2,
        role: 'owner',
        title_snapshot: 'Task one',
      })
    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    render(
      <SessionSharePickerDialog
        isOpen
        onClose={onClose}
        conversationId="conversation-1"
        organizationId="org-1"
        granteeUserId="user-2"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    fireEvent.change(screen.getByRole('combobox', { name: '协作方式' }), {
      target: { value: 'continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送转交' }))

    expect(await screen.findByText(
      '分享会话文件超过50MB，是否选择只交接对话，不交接上下文',
    )).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(mockCreateSessionContinuation).toHaveBeenCalledTimes(2))
    expect(mockCreateSessionContinuation).toHaveBeenNthCalledWith(2, {
      sourceSessionId: 'session-1',
      recipientUserId: 'user-2',
      conversationId: 'conversation-1',
      clientRequestId: '0198c96d-a000-7000-8000-000000000099',
      includeContext: false,
    })
    expect(setSessionContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'continuation-text-only' }),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('logs only allowlisted metadata when sharing fails', async () => {
    const sensitiveError = Object.assign(new Error('request failed'), {
      name: 'ApiError',
      status: 503,
      response: {
        data: {
          session_title: 'private task title',
        },
      },
    })
    mockCreateSessionShare.mockReset().mockRejectedValue(sensitiveError)

    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    render(
      <SessionSharePickerDialog
        isOpen
        onClose={vi.fn()}
        conversationId="conversation-1"
        organizationId="org-1"
        granteeUserId="user-2"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    const shareButton = screen.getByRole('button', { name: '共享' }) as HTMLButtonElement
    await waitFor(() => expect(shareButton.disabled).toBe(false))
    fireEvent.click(shareButton)

    await waitFor(() => expect(mockLogWarn).toHaveBeenCalledWith(
      'create session share failed',
      {
        sessionId: 'session-1',
        conversationId: 'conversation-1',
        clientRequestId: '0198c96d-a000-7000-8000-000000000099',
        errorName: 'ApiError',
        errorMessage: 'request failed',
        status: 503,
      },
    ))
    const logPayload = mockLogWarn.mock.calls[0]?.[1]
    expect(logPayload).not.toHaveProperty('err')
    expect(logPayload).not.toHaveProperty('response')
    expect(JSON.stringify(logPayload)).not.toContain('private task title')
  })

  it('reuses an uncertain request id after the dialog is closed and reopened', async () => {
    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      granteeUserId: 'user-2',
    }
    const first = render(<SessionSharePickerDialog {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    const firstShareButton = screen.getByRole('button', { name: '共享' }) as HTMLButtonElement
    await waitFor(() => expect(firstShareButton.disabled).toBe(false))
    fireEvent.click(firstShareButton)
    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(firstShareButton.disabled).toBe(false))
    first.unmount()

    render(<SessionSharePickerDialog {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    const secondShareButton = screen.getByRole('button', { name: '共享' }) as HTMLButtonElement
    await waitFor(() => expect(secondShareButton.disabled).toBe(false))
    fireEvent.click(secondShareButton)

    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(2))
    expect(mockCreateSessionShare).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientRequestId: '0198c96d-a000-7000-8000-000000000099',
    }))
    expect(mockCreateClientRequestId).toHaveBeenCalledOnce()
  })

  it('keeps an uncertain request id beyond the former ttl until explicit success', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { SessionSharePickerDialog } = await import('./SessionSharePickerDialog')
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      granteeUserId: 'user-2',
    }
    const first = render(<SessionSharePickerDialog {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    const firstShareButton = screen.getByRole('button', { name: '共享' }) as HTMLButtonElement
    await waitFor(() => expect(firstShareButton.disabled).toBe(false))
    fireEvent.click(firstShareButton)
    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(firstShareButton.disabled).toBe(false))
    first.unmount()

    now.mockReturnValue(1_000 + (30 * 60 * 1000) + 1)
    render(<SessionSharePickerDialog {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'session-1' }))
    const secondShareButton = screen.getByRole('button', { name: '共享' }) as HTMLButtonElement
    await waitFor(() => expect(secondShareButton.disabled).toBe(false))
    fireEvent.click(secondShareButton)

    await waitFor(() => expect(mockCreateSessionShare).toHaveBeenCalledTimes(2))
    expect(mockCreateSessionShare).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientRequestId: '0198c96d-a000-7000-8000-000000000099',
    }))
    expect(mockCreateClientRequestId).toHaveBeenCalledOnce()
    now.mockRestore()
  })
})
