import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tabchatApi from '@/services/tabchatApi'
import type { IMMessage } from '@/services/tabchatApi'
import { useFileAttachmentStore } from './useFileAttachmentStore'
import { messageStableKey } from '@/services/im/messageMerge'

const imageMessage: IMMessage = {
  id: 42,
  conversation_id: 'conversation-1',
  sender_id: 'user-1',
  content: '',
  message_type: 4,
  has_attachment: true,
  metadata: { file_id: 'file-1', file_name: 'fufu.png' },
  created_at: '2026-07-22T09:00:00Z',
}

afterEach(() => {
  vi.restoreAllMocks()
  useFileAttachmentStore.getState().reset()
})

describe('useFileAttachmentStore', () => {
  it('图片预签名链接加载失败后能重新换取可用链接', async () => {
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(imageMessage)]: { status: 'available', downloadUrl: 'https://oss.example/expired.png' },
      },
    })
    vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl').mockResolvedValue({
      download_url: 'https://oss.example/fresh.png',
      file_name: 'fufu.png',
      expires_in: 3600,
    })

    await useFileAttachmentStore.getState().refresh(imageMessage)

    expect(tabchatApi.getMessageAttachmentDownloadUrl).toHaveBeenCalledWith('conversation-1', imageMessage)
    expect(useFileAttachmentStore.getState().statuses[messageStableKey(imageMessage)]).toEqual({
      status: 'available',
      downloadUrl: 'https://oss.example/fresh.png',
    })
  })

  it('换链失败时不再保留已过期的缓存链接', async () => {
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(imageMessage)]: { status: 'available', downloadUrl: 'https://oss.example/expired.png' },
      },
    })
    vi.spyOn(tabchatApi, 'getMessageAttachmentDownloadUrl').mockRejectedValue(new Error('network failed'))

    await useFileAttachmentStore.getState().refresh(imageMessage)

    expect(useFileAttachmentStore.getState().statuses[messageStableKey(imageMessage)]).toEqual({
      status: 'unavailable',
      downloadUrl: null,
    })
  })

  it('ensureChecked 与 resolveDownloadUrl 共享同一 in-flight 换链任务', async () => {
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

    useFileAttachmentStore.getState().ensureChecked([imageMessage])
    const urlPromise = useFileAttachmentStore.getState().resolveDownloadUrl(imageMessage)

    expect(resolveSpy).toHaveBeenCalledTimes(1)

    releaseResolve({
      download_url: 'https://oss.example/fresh.png',
      file_name: 'fufu.png',
      expires_in: 3600,
    })

    await expect(urlPromise).resolves.toBe('https://oss.example/fresh.png')
    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(useFileAttachmentStore.getState().statuses[messageStableKey(imageMessage)]).toMatchObject({
      status: 'available',
      downloadUrl: 'https://oss.example/fresh.png',
    })
  })
})
