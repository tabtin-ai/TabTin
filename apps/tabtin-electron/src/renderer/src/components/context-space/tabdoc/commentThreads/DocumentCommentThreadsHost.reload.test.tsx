import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  listThreads: vi.fn(),
  subscribe: vi.fn(),
  eventHandler: null as
    | ((event: { event: string; data?: Record<string, unknown> }) => void)
    | null,
  translate: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
  client: { request: vi.fn(), getOrganizationId: () => 'org-1' },
  renderedThreadCount: 0,
  renderedThreadIds: [] as string[],
  railProps: null as null | Record<string, unknown>,
  createThread: vi.fn(),
  sectionProps: null as null | {
    onCreateThread: (input: {
      body: string
      mentionUserIds: string[]
      attachmentIds: string[]
      clientRequestId: string
    }) => Promise<void>
  },
}))

vi.mock('@tabtin/app-host-sdk', () => ({
  useAppHostClient: () => harness.client,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: harness.translate,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) =>
    selector({ user: null }),
}))

vi.mock('@/services/memberApi', () => ({
  MemberApiService: { getMembers: vi.fn().mockResolvedValue({ members: [] }) },
}))

vi.mock('@components/ui', () => ({ Button: 'button', toast: vi.fn() }))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../adapters/electronTabDocEventStreamPort', () => ({
  electronTabDocEventStreamPort: {
    subscribe: harness.subscribe.mockImplementation(
      (_documentId: string, handler: typeof harness.eventHandler) => {
        harness.eventHandler = handler
        return { unsubscribe: vi.fn() }
      },
    ),
  },
}))

vi.mock('./commentAttachmentUpload', () => ({
  uploadCommentAttachmentImage: vi.fn(),
}))
vi.mock('./commentSubmitRecovery', () => ({
  tabdocCommentSubmitErrorDescription: vi.fn(),
}))
vi.mock('./openDocumentCommentImagePreview', () => ({
  openDocumentCommentImagePreview: vi.fn(async () => true),
}))

vi.mock('@tabtin/tabdoc-ui/api-client', () => ({
  addDocumentCommentMessage: vi.fn(),
  createDocumentCommentThread: harness.createThread,
  deleteDocumentCommentMessage: vi.fn(),
  hasCommentThreadsCapability: (capabilities: string[] | null) =>
    capabilities?.includes('comment_threads_v1') ?? false,
  isSignedCommentPreviewUrl: (value: string) => /^https?:\/\//.test(value),
  listDocumentCommentThreads: harness.listThreads,
  reanchorDocumentCommentThread: vi.fn(),
  resolveDocumentCommentAttachmentPreview: vi.fn(),
  resolveDocumentThreadAttachmentPreviews: vi.fn(
    async (_client, _documentId, threads) => threads,
  ),
  updateDocumentCommentThreadStatus: vi.fn(),
}))

vi.mock('@tabtin/tabdoc-ui/editor', () => ({
  CommentRail: (props: Record<string, unknown>) => {
    harness.railProps = props
    return null
  },
  DocumentCommentThreadsSection: (props: { threads: unknown[] }) => {
    const { threads } = props
    harness.renderedThreadCount = threads.length
    harness.renderedThreadIds = threads.map((thread) =>
      String((thread as { id?: string }).id ?? ''),
    )
    harness.sectionProps = props as typeof harness.sectionProps
    return null
  },
  buildReanchorPayload: vi.fn(),
  focusCommentAnchorInEditor: vi.fn(),
  setActiveCommentThread: vi.fn(),
  setCommentDecorationThreads: vi.fn(),
}))

import { DocumentCommentThreadsHost } from './DocumentCommentThreadsHost'

function hostElement(
  documentId: string,
  onCapabilityModeChange: ReturnType<typeof vi.fn>,
) {
  return (
    <DocumentCommentThreadsHost
      documentId={documentId}
      organizationId="org-1"
      editorRef={createRef()}
      railOpen={false}
      onRailOpenChange={vi.fn()}
      activeThreadId={null}
      onActiveThreadIdChange={vi.fn()}
      pendingAnchor={null}
      onCollapseOutlineChange={vi.fn()}
      viewportWidth={1280}
      onCapabilityModeChange={onCapabilityModeChange}
    />
  )
}

function renderHost(documentId = 'doc-1') {
  const onCapabilityModeChange = vi.fn()
  const rendered = render(hostElement(documentId, onCapabilityModeChange))
  return { ...rendered, onCapabilityModeChange }
}

describe('DocumentCommentThreadsHost reload coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.eventHandler = null
    harness.renderedThreadCount = 0
    harness.renderedThreadIds = []
    harness.railProps = null
    harness.sectionProps = null
    harness.translate = (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key
    harness.listThreads.mockResolvedValue({
      threads: [],
      capabilities: ['comment_threads_v1'],
    })
  })

  it('同一次评论写入的 thread/message 双事件只合并为一次列表刷新', async () => {
    renderHost()

    await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(harness.eventHandler).not.toBeNull())

    await act(async () => {
      harness.eventHandler?.({
        event: 'doc.events.comment_thread',
        data: { action: 'created' },
      })
      harness.eventHandler?.({
        event: 'doc.events.comment_message',
        data: { action: 'created' },
      })
    })

    await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(2))
  })

  it('同一文档的多窗格共享初始加载与实时订阅', async () => {
    renderHost()
    renderHost()

    await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(harness.subscribe).toHaveBeenCalledTimes(1))
  })

  it('429 后保留最后成功内容与 capability，并可手动重试恢复', async () => {
    harness.listThreads.mockResolvedValueOnce({
      threads: [
        { id: 'thread-1', messages: [], scope: 'document', status: 'open' },
      ],
      capabilities: ['comment_threads_v1'],
    })
    const { onCapabilityModeChange } = renderHost()
    await waitFor(() => expect(harness.renderedThreadCount).toBe(1))

    const rateLimited = Object.assign(new Error('请求频率过高，请稍后再试'), {
      status: 429,
    })
    harness.listThreads.mockRejectedValueOnce(rateLimited)
    await act(async () => {
      harness.eventHandler?.({
        event: 'doc.events.comment_message',
        data: { action: 'created' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('comment-threads-retry')).toBeTruthy(),
    )
    expect(harness.renderedThreadCount).toBe(1)
    expect(onCapabilityModeChange).not.toHaveBeenCalledWith('legacy')

    harness.listThreads.mockResolvedValueOnce({
      threads: [
        { id: 'thread-1', messages: [], scope: 'document', status: 'open' },
        { id: 'thread-2', messages: [], scope: 'document', status: 'open' },
      ],
      capabilities: ['comment_threads_v1'],
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(harness.renderedThreadCount).toBe(2))
    expect(onCapabilityModeChange).not.toHaveBeenCalledWith('legacy')
  })

  it('初始 timeout 显示可恢复重试，不误切 legacy', async () => {
    harness.listThreads.mockRejectedValueOnce(
      new Error('Network error: Request timeout'),
    )
    const { onCapabilityModeChange } = renderHost()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重试' })).toBeTruthy(),
    )
    expect(onCapabilityModeChange).not.toHaveBeenCalledWith('legacy')

    harness.listThreads.mockResolvedValueOnce({
      threads: [],
      capabilities: ['comment_threads_v1'],
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() =>
      expect(onCapabilityModeChange).toHaveBeenCalledWith('threads'),
    )
  })

  it('评论加载后打开通知指定的线程并聚焦具体消息', async () => {
    harness.listThreads.mockResolvedValueOnce({
      threads: [{
        id: 'thread-mention',
        document_id: 'doc-1',
        scope: 'block',
        status: 'open',
        anchor_status: 'attached',
        anchor: { version: 1, block_ids: ['block-1'], block_type: 'paragraph' },
        selected_text: '@我',
        messages: [{
          id: 'comment-mention',
          thread_id: 'thread-mention',
          kind: 'reply',
          body: '@我 请查看',
          mention_user_ids: ['user-1'],
          attachments: [],
          is_deleted: false,
        }],
      }],
      capabilities: ['comment_threads_v1'],
    })
    const onRailOpenChange = vi.fn()
    const onActiveThreadIdChange = vi.fn()
    const onNotificationRevealHandled = vi.fn()

    render(
      <DocumentCommentThreadsHost
        documentId="doc-1"
        organizationId="org-1"
        editorRef={createRef()}
        railOpen={false}
        onRailOpenChange={onRailOpenChange}
        activeThreadId={null}
        onActiveThreadIdChange={onActiveThreadIdChange}
        pendingAnchor={null}
        onCollapseOutlineChange={vi.fn()}
        viewportWidth={1280}
        notificationReveal={{
          threadId: 'thread-mention',
          commentId: 'comment-mention',
          requestId: 7,
        }}
        onNotificationRevealHandled={onNotificationRevealHandled}
      />,
    )

    await waitFor(() => expect(onNotificationRevealHandled).toHaveBeenCalledWith(7, 'revealed'))
    expect(onActiveThreadIdChange).toHaveBeenCalledWith('thread-mention')
    expect(onRailOpenChange).toHaveBeenCalledWith(true)
    expect(harness.railProps).toMatchObject({
      focusThreadId: 'thread-mention',
      focusMessageId: 'comment-mention',
    })
  })

  it('线程存在但目标评论不存在时报告 unavailable 且不阻断文档', async () => {
    harness.listThreads.mockResolvedValueOnce({
      threads: [{
        id: 'thread-mention',
        document_id: 'doc-1',
        scope: 'block',
        status: 'open',
        anchor_status: 'attached',
        anchor: { version: 1, block_ids: ['block-1'], block_type: 'paragraph' },
        messages: [],
      }],
      capabilities: ['comment_threads_v1'],
    })
    const onNotificationRevealHandled = vi.fn()
    render(
      <DocumentCommentThreadsHost
        documentId="doc-1"
        organizationId="org-1"
        editorRef={createRef()}
        railOpen={false}
        onRailOpenChange={vi.fn()}
        activeThreadId={null}
        onActiveThreadIdChange={vi.fn()}
        pendingAnchor={null}
        onCollapseOutlineChange={vi.fn()}
        viewportWidth={1280}
        notificationReveal={{
          threadId: 'thread-mention',
          commentId: 'missing-comment',
          requestId: 8,
        }}
        onNotificationRevealHandled={onNotificationRevealHandled}
      />,
    )

    await waitFor(() => expect(onNotificationRevealHandled).toHaveBeenCalledWith(8, 'unavailable'))
  })

  it('只有明确缺少 comment threads route 才切 legacy', async () => {
    harness.listThreads.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 404'), { status: 404 }),
    )
    const { onCapabilityModeChange } = renderHost()

    await waitFor(() =>
      expect(onCapabilityModeChange).toHaveBeenCalledWith('legacy'),
    )
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('切换文档后忽略旧文档的陈旧响应', async () => {
    let resolveFirst!: (value: {
      threads: unknown[]
      capabilities: string[]
    }) => void
    let resolveSecond!: (value: {
      threads: unknown[]
      capabilities: string[]
    }) => void
    const first = new Promise<{ threads: unknown[]; capabilities: string[] }>(
      (resolve) => {
        resolveFirst = resolve
      },
    )
    const second = new Promise<{ threads: unknown[]; capabilities: string[] }>(
      (resolve) => {
        resolveSecond = resolve
      },
    )
    harness.listThreads.mockImplementation(
      (_client: unknown, documentId: string) =>
        documentId === 'doc-1' ? first : second,
    )

    const onCapabilityModeChange = vi.fn()
    const rendered = render(hostElement('doc-1', onCapabilityModeChange))
    await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(1))
    rendered.rerender(hostElement('doc-2', onCapabilityModeChange))
    await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveSecond({
        threads: [
          {
            id: 'thread-doc-2',
            messages: [],
            scope: 'document',
            status: 'open',
          },
        ],
        capabilities: ['comment_threads_v1'],
      })
      await second
    })
    await waitFor(() =>
      expect(harness.renderedThreadIds).toEqual(['thread-doc-2']),
    )

    await act(async () => {
      resolveFirst({
        threads: [
          {
            id: 'thread-doc-1-stale',
            messages: [],
            scope: 'document',
            status: 'open',
          },
        ],
        capabilities: ['comment_threads_v1'],
      })
      await first
    })
    expect(harness.renderedThreadIds).toEqual(['thread-doc-2'])
  })

  it('翻译函数身份变化不会重启初始加载 effect', async () => {
    const { rerender, onCapabilityModeChange } = renderHost()
    await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(1))

    harness.translate = (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? `next:${_key}`
    rerender(hostElement('doc-1', onCapabilityModeChange))

    await act(async () => Promise.resolve())
    expect(harness.listThreads).toHaveBeenCalledTimes(1)
  })

  it.each([1, 4, 9])(
    '%i 张附件提交先本地合并，双实时事件后请求数仍有界',
    async (attachmentCount) => {
      const attachmentIds = Array.from(
        { length: attachmentCount },
        (_, index) => `file-${index + 1}`,
      )
      harness.createThread.mockResolvedValue({
        id: `created-${attachmentCount}`,
        messages: [],
        scope: 'document',
        status: 'open',
      })
      renderHost()
      await waitFor(() => expect(harness.sectionProps).not.toBeNull())

      await act(async () => {
        await harness.sectionProps?.onCreateThread({
          body: '带图评论',
          mentionUserIds: [],
          attachmentIds,
          clientRequestId: `request-${attachmentCount}`,
        })
      })

      expect(harness.createThread).toHaveBeenCalledWith(
        harness.client,
        'doc-1',
        expect.objectContaining({
          attachment_ids: attachmentIds,
          client_request_id: `request-${attachmentCount}`,
        }),
      )
      expect(harness.renderedThreadIds).toEqual([`created-${attachmentCount}`])
      expect(harness.listThreads).toHaveBeenCalledTimes(1)

      await act(async () => {
        harness.eventHandler?.({
          event: 'doc.events.comment_thread',
          data: { action: 'created' },
        })
        harness.eventHandler?.({
          event: 'doc.events.comment_message',
          data: { action: 'created' },
        })
      })
      await waitFor(() => expect(harness.listThreads).toHaveBeenCalledTimes(2))
    },
  )
})
