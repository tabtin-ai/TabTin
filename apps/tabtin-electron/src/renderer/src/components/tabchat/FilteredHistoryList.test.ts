import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CHAT_CONTENT_FILTER_DOCUMENT, CHAT_CONTENT_FILTER_FILE } from '@/constants/tabchat'
import { FilteredHistoryList, buildFilteredHistoryEntries } from './FilteredHistoryList'
import * as tabchatApi from '@/services/tabchatApi'
import type { IMMessage } from '@/services/tabchatApi'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { messageStableKey } from '@/services/im/messageMerge'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import { useIMStore } from '@stores/useIMStore'

function makeMessage(id: number, metadata: IMMessage['metadata'], messageType = 1): IMMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: 'user-1',
    content: '',
    message_type: messageType,
    reply_to_id: null,
    has_attachment: messageType === 3 || messageType === 4,
    metadata,
    created_at: '2026-06-23T00:00:00Z',
  }
}

describe('buildFilteredHistoryEntries', () => {
  it('deduplicates cloud docs by resource id and keeps the latest share', () => {
    const firstShare = makeMessage(10, {
      card: { type: 'document', resource_id: 'doc-1', name: '旧标题' },
    })
    const secondShare = makeMessage(30, {
      card: { type: 'document', resource_id: 'doc-1', name: '新标题' },
    })
    const otherDoc = makeMessage(20, {
      card: { type: 'document', resource_id: 'doc-2', name: '另一份文档' },
    })

    const entries = buildFilteredHistoryEntries(
      [firstShare, otherDoc, secondShare],
      CHAT_CONTENT_FILTER_DOCUMENT,
    )

    expect(entries.map((entry) => entry.message.id)).toEqual([30, 20])
    expect(entries[0].duplicateCount).toBe(2)
    expect(entries[0].message.metadata.card?.name).toBe('新标题')
  })

  it('keeps tables in the cloud-doc list without merging them with docs', () => {
    const doc = makeMessage(10, {
      card: { type: 'document', resource_id: 'shared-id', name: '文档' },
    })
    const table = makeMessage(20, {
      card: { type: 'table', resource_id: 'shared-id', name: '表格' },
    })

    const entries = buildFilteredHistoryEntries(
      [doc, table],
      CHAT_CONTENT_FILTER_DOCUMENT,
    )

    expect(entries.map((entry) => entry.message.metadata.card?.type)).toEqual(['table', 'document'])
    expect(entries.every((entry) => entry.duplicateCount === 1)).toBe(true)
  })

  it('keeps file entries as individual message records', () => {
    const firstFile = makeMessage(10, { file_id: 'file-1', file_name: 'brief.pdf' }, 3)
    const secondFile = makeMessage(30, { file_id: 'file-1', file_name: 'brief.pdf' }, 3)

    const entries = buildFilteredHistoryEntries(
      [firstFile, secondFile],
      CHAT_CONTENT_FILTER_FILE,
    )

    expect(entries.map((entry) => entry.message.id)).toEqual([30, 10])
    expect(entries.every((entry) => entry.duplicateCount === 1)).toBe(true)
  })

  it('云文档列表在窄容器隐藏操作文字、宽容器恢复文字', () => {
    const documentMessage = makeMessage(35, {
      card: {
        type: 'document',
        resource_id: 'doc-35',
        space_id: 'space-1',
        name: '方案文档',
      },
    })

    render(React.createElement(FilteredHistoryList, {
      messages: [documentMessage],
      conversationId: 'conv-1',
      contentFilter: CHAT_CONTENT_FILTER_DOCUMENT,
      isLoading: false,
      hasMore: false,
      onLoadMore: vi.fn(),
      emptyLabel: 'empty',
    }))

    expect(screen.getByTestId('filtered-history-scroll').className).toContain('overflow-x-hidden')
    expect(screen.getByTestId('filtered-history-list').className).toContain('min-w-0')
    expect(screen.getByTestId('filtered-history-list').className).toContain('@container')
    expect(screen.getByText('contentListOpen').className).toContain('@[800px]:inline')
  })

  it('opens an IM image from the sidebar in the shared Agent resource preview', async () => {
    const image = makeMessage(40, {
      file_id: 'file-image',
      file_name: 'image.png',
      file_type: 'image/png',
      file_size: 1024,
    }, 4)
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(image)]: { status: 'available', downloadUrl: 'https://old.example/image.png' },
      },
    })
    // 模拟这张旧资产不在当前实时消息流里：侧边资产列表仍必须打开被点击图片。
    useIMStore.setState({
      messages: {
        'conv-1': [makeMessage(41, { file_name: 'other.png' }, 4)],
      },
    })
    const getMessages = vi.spyOn(tabchatApi, 'getMessages')
    const getDownloadUrl = vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl')
      .mockResolvedValue({
        download_url: 'https://fresh.example/image.png',
        file_name: 'image.png',
        expires_in: 300,
      })

    render(React.createElement(FilteredHistoryList, {
      messages: [image],
      conversationId: 'conv-1',
      contentFilter: CHAT_CONTENT_FILTER_FILE,
      isLoading: false,
      hasMore: false,
      onLoadMore: vi.fn(),
      emptyLabel: 'empty',
    }))

    expect(screen.getByTestId('filtered-history-scroll').className).toContain('overflow-x-hidden')
    expect(screen.getByTestId('filtered-history-list').className).toContain('min-w-0')
    expect(screen.getByTestId('filtered-history-list').className).toContain('@container')
    expect(screen.getByTestId('history-image-thumbnail').getAttribute('src')).toBe('https://old.example/image.png')
    expect(screen.getByRole('button', { name: 'preview' }).className).toContain('cursor-pointer')
    expect(screen.getByText('download').className).toContain('@[800px]:inline')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'preview' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(useResourcePreviewStore.getState().isOpen).toBe(true))
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'preview' }).hasAttribute('disabled'),
    ).toBe(false))
    // 侧栏传入已加载资产列表即可打开；不预拉历史、不展示计数。
    expect(getMessages).not.toHaveBeenCalled()
    expect(useResourcePreviewStore.getState().showNavMeta).toBe(false)
    await waitFor(() => {
      const resources = useResourcePreviewStore.getState().resources
      expect(resources.find((resource) => resource.sourceMessageId === '40')).toMatchObject({
        kind: 'image',
        name: 'image.png',
        url: 'https://fresh.example/image.png',
        sourceMessageId: '40',
      })
      expect(
        resources[useResourcePreviewStore.getState().currentIndex]?.sourceMessageId,
      ).toBe('40')
    })
    getMessages.mockRestore()
    getDownloadUrl.mockRestore()
    act(() => {
      useResourcePreviewStore.getState().close()
      useFileAttachmentStore.getState().reset()
      useIMStore.setState({ messages: {} })
    })
  })

  it('shows a retry control in empty state when more history may exist', () => {
    const onLoadMore = vi.fn()

    render(React.createElement(FilteredHistoryList, {
      messages: [],
      conversationId: 'conv-1',
      contentFilter: CHAT_CONTENT_FILTER_DOCUMENT,
      isLoading: false,
      hasMore: true,
      onLoadMore,
      emptyLabel: 'empty',
    }))

    fireEvent.click(screen.getByRole('button', { name: 'contentListLoadMore' }))

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})
