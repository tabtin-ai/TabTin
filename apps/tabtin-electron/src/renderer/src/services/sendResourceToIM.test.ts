import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
  MESSAGE_TYPE_TEXT,
} from '@/constants/tabchat'

const sendMessage = vi.fn()
const sendErrorRef = { current: null as string | null }

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({ sendMessage, sendError: sendErrorRef.current }),
  },
}))

import {
  createSendToIMRequestIds,
  sendResourceToIMTarget,
} from '@/services/sendResourceToIM'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('sendResourceToIMTarget', () => {
  beforeEach(() => {
    sendMessage.mockReset()
    sendErrorRef.current = null
  })

  it('creates distinct UUID request identities for resource and note messages', () => {
    const requestIds = createSendToIMRequestIds()
    const nextRequestIds = createSendToIMRequestIds()

    expect(requestIds.resource).toMatch(UUID_PATTERN)
    expect(requestIds.note).toMatch(UUID_PATTERN)
    expect(new Set([
      requestIds.resource,
      requestIds.note,
      nextRequestIds.resource,
      nextRequestIds.note,
    ]).size).toBe(4)
  })

  it('sends resource card then note with the provided UUID request identities', async () => {
    sendMessage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    const requestIds = {
      resource: '019fc7b9-4cb3-7a55-863d-04b33361743c',
      note: '019fc7b9-4cb3-7a55-863d-04b33361743d',
    }

    const result = await sendResourceToIMTarget({
      convId: 'conv-1',
      resource: {
        kind: 'resource_card',
        ref: {
          type: 'document',
          resourceId: 'doc-1',
          name: 'Doc',
        },
      },
      note: '请查看',
      requestIds,
    })

    expect(result).toEqual({ resourceOk: true, noteOk: true })
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      convId: 'conv-1',
      messageType: MESSAGE_TYPE_TEXT,
      clientRequestId: requestIds.resource,
    }))
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      convId: 'conv-1',
      content: '请查看',
      messageType: MESSAGE_TYPE_TEXT,
      clientRequestId: requestIds.note,
    }))
  })

  it('does not send note when resource failed', async () => {
    sendMessage.mockResolvedValueOnce(false)

    const result = await sendResourceToIMTarget({
      convId: 'conv-1',
      resource: {
        kind: 'cloud_file',
        fileId: 'file-1',
        fileName: 'photo.png',
        mimeType: 'image/png',
      },
      note: '图',
    })

    expect(result).toEqual({
      resourceOk: false,
      noteOk: false,
      error: 'resource_send_failed',
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: MESSAGE_TYPE_IMAGE,
      metadata: expect.objectContaining({ file_id: 'file-1' }),
    }))
  })

  it('explains a Tencent group-membership rejection instead of calling it a resource failure', async () => {
    sendMessage.mockResolvedValueOnce(false)
    sendErrorRef.current = 'removedFromGroup'

    await expect(sendResourceToIMTarget({
      convId: 'conv-1',
      resource: {
        kind: 'resource_card',
        ref: { type: 'document', resourceId: 'doc-1', name: 'Doc' },
      },
    })).resolves.toEqual({
      resourceOk: false,
      noteOk: false,
      error: 'removed_from_group',
    })
  })

  it('marks partial when note fails after resource succeeds', async () => {
    sendMessage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const result = await sendResourceToIMTarget({
      convId: 'conv-1',
      resource: {
        kind: 'cloud_file',
        fileId: 'file-2',
        fileName: 'sheet.csv',
        mimeType: 'text/csv',
      },
      note: '数据',
    })

    expect(result).toEqual({
      resourceOk: true,
      noteOk: false,
      error: 'note_send_failed',
    })
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      messageType: MESSAGE_TYPE_FILE,
    }))
  })
})
