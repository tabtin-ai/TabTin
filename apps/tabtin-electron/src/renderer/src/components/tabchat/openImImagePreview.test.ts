import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IMMessage } from '@/services/tabchatApi'
import * as tabchatApi from '@/services/tabchatApi'
import { MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import { useIMStore } from '@stores/useIMStore'
import { openImImagePreview } from './openImImagePreview'
import { messageStableKey } from '@/services/im/messageMerge'

function makeImage(id: number, name: string, overrides: Partial<IMMessage> = {}): IMMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: 'user-1',
    content: '',
    message_type: MESSAGE_TYPE_IMAGE,
    has_attachment: true,
    metadata: { file_id: `file-${id}`, file_name: name },
    created_at: `2026-07-24T0${id}:00:00Z`,
    ...overrides,
  }
}

function resourceMessageIds() {
  return useResourcePreviewStore.getState().resources.map(
    (resource) => Number(/:legacy:[^:]+:(\d+):/.exec(resource.sourceMessageId ?? '')?.[1]),
  )
}

function resourceUrls() {
  return useResourcePreviewStore.getState().resources.map((resource) => resource.url)
}

describe('openImImagePreview', () => {
  beforeEach(() => {
    useResourcePreviewStore.setState({
      resources: [],
      currentIndex: 0,
      isOpen: false,
      generation: 0,
      showNavMeta: true,
    })
    useFileAttachmentStore.getState().reset()
    useIMStore.setState({ messages: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useResourcePreviewStore.getState().close()
    useFileAttachmentStore.getState().reset()
    useIMStore.setState({ messages: {} })
  })

  it('opens from already-loaded messages without fetching conversation history', async () => {
    const first = makeImage(10, 'a.png')
    const second = makeImage(20, 'b.png')
    const third = makeImage(30, 'c.png')

    useIMStore.setState({
      messages: {
        'conv-1': [
          first,
          second,
          { ...makeImage(25, 'ignored.txt'), message_type: MESSAGE_TYPE_TEXT, has_attachment: false },
          third,
        ],
      },
    })
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(first)]: { status: 'checking', downloadUrl: null },
        [messageStableKey(second)]: { status: 'available', downloadUrl: 'https://cdn.example/b.png' },
        [messageStableKey(third)]: { status: 'checking', downloadUrl: null },
      },
    })

    const getMessages = vi.spyOn(tabchatApi, 'getMessages')
    vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl').mockImplementation(
      async (_conversationId, message) => ({
        download_url: `https://cdn.example/${message.id}.png`,
        file_name: `${message.id}.png`,
        expires_in: 300,
      }),
    )

    openImImagePreview(second, 'https://cdn.example/b.png')

    expect(useResourcePreviewStore.getState().isOpen).toBe(true)
    expect(useResourcePreviewStore.getState().showNavMeta).toBe(false)
    expect(resourceMessageIds()).toEqual([10, 20, 30])
    expect(getMessages).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(resourceUrls()).toEqual([
        'https://cdn.example/10.png',
        'https://cdn.example/b.png',
        'https://cdn.example/30.png',
      ])
    })
    expect(useResourcePreviewStore.getState().currentIndex).toBe(1)
  })

  it('only resolves nearby attachment urls and stops after preview closes', async () => {
    const images = Array.from({ length: 12 }, (_, index) => makeImage(index + 1, `${index + 1}.png`))
    const clicked = images[5]

    useIMStore.setState({
      messages: {
        'conv-1': images,
      },
    })
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(clicked)]: { status: 'available', downloadUrl: `https://cdn.example/${clicked.id}.png` },
      },
    })

    const resolveSpy = vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl').mockImplementation(
      async (_conversationId, message) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return {
          download_url: `https://cdn.example/${message.id}.png`,
          file_name: `${message.id}.png`,
          expires_in: 300,
        }
      },
    )

    openImImagePreview(clicked, `https://cdn.example/${clicked.id}.png`)

    expect(useResourcePreviewStore.getState().resources).toHaveLength(12)
    await vi.waitFor(() => {
      expect(resolveSpy.mock.calls.length).toBeGreaterThan(0)
      expect(resolveSpy.mock.calls.length).toBeLessThanOrEqual(4)
    })

    const callsBeforeClose = resolveSpy.mock.calls.length
    useResourcePreviewStore.getState().close()
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(resolveSpy.mock.calls.length).toBe(callsBeforeClose)
  })

  it('removes neighbor placeholders when attachment url resolve fails', async () => {
    const first = makeImage(10, 'a.png')
    const second = makeImage(20, 'b.png')
    const third = makeImage(30, 'c.png')

    useIMStore.setState({
      messages: {
        'conv-1': [first, second, third],
      },
    })
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(second)]: { status: 'available', downloadUrl: 'https://cdn.example/b.png' },
      },
    })

    vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl').mockImplementation(
      async (_conversationId, message) => {
        if (message.id === 10) {
          throw new Error('gone')
        }
        return {
          download_url: `https://cdn.example/${message.id}.png`,
          file_name: `${message.id}.png`,
          expires_in: 300,
        }
      },
    )

    openImImagePreview(second, 'https://cdn.example/b.png')

    await vi.waitFor(() => {
      expect(resourceMessageIds()).toEqual([20, 30])
    })
    expect(useResourcePreviewStore.getState().currentIndex).toBe(0)
    expect(useFileAttachmentStore.getState().statuses[messageStableKey(first)]?.status).toBe('unavailable')
  })

  it('reuses in-flight attachment resolve instead of issuing duplicate url requests', async () => {
    const first = makeImage(10, 'a.png')
    const second = makeImage(20, 'b.png')

    useIMStore.setState({
      messages: {
        'conv-1': [first, second],
      },
    })
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(second)]: { status: 'available', downloadUrl: 'https://cdn.example/b.png' },
      },
    })

    let releaseResolve!: (value: {
      download_url: string
      file_name: string
      expires_in: number
    }) => void
    const resolveSpy = vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl').mockImplementation(
      () => new Promise((resolve) => {
        releaseResolve = resolve
      }),
    )

    useFileAttachmentStore.getState().ensureChecked([first])
    openImImagePreview(second, 'https://cdn.example/b.png')

    await vi.waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledTimes(1)
    })

    releaseResolve({
      download_url: 'https://cdn.example/10.png',
      file_name: 'a.png',
      expires_in: 300,
    })

    await vi.waitFor(() => {
      expect(resourceUrls()).toEqual([
        'https://cdn.example/10.png',
        'https://cdn.example/b.png',
      ])
    })
    expect(resolveSpy).toHaveBeenCalledTimes(1)
  })
})
