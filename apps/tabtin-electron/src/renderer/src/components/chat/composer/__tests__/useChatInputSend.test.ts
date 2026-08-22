import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '../../types'

const mocks = vi.hoisted(() => ({
  finalizeComposerSend: vi.fn(),
  previewFunding: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    warning: mocks.warning,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    models: {
      previewFunding: mocks.previewFunding,
    },
  }),
}))

vi.mock('../useComposerAttachmentUploads', () => ({
  isAttachmentStillUploading: () => false,
}))

vi.mock('../send/prepareComposerSendContent', () => ({
  prepareComposerSendContent: () => ({
    compactArgs: null,
    hasContent: true,
    message: 'hello',
    unrecognizedSlashToken: null,
  }),
}))

vi.mock('../send/mergePresetSendPayload', () => ({
  mergePresetSendPayload: () => ({ ok: true }),
}))

vi.mock('../send/finalizeComposerSend', () => ({
  finalizeComposerSend: mocks.finalizeComposerSend,
}))

import { useChatInputSend } from '../useChatInputSend'

function renderSendHook(
  disabled = false,
  attachments: ChatAttachment[] = [],
) {
  return renderHook(() => useChatInputSend({
    input: 'hello',
    attachments,
    allContextRefs: [],
    conversationReferenceRefs: [],
    hasActivePresets: false,
    activePresets: [],
    disabled,
    wsDisconnected: false,
    sessionId: 'session-1',
    spaceId: 'space-1',
    resolvedPresetScopeId: null,
    slashOptions: [],
    buildContextBlocks: () => [],
    clearInputState: vi.fn(),
    stopVoiceForSubmit: vi.fn(),
    handleManualCompact: vi.fn(),
    onSend: vi.fn(),
    allowInterruptedEditRecovery: false,
  }))
}

describe('useChatInputSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无硬门禁时直发 finalize，不做发送前资金预览', () => {
    const { result } = renderSendHook()

    act(() => {
      result.current.handleSend()
    })

    expect(mocks.previewFunding).not.toHaveBeenCalled()
    expect(mocks.finalizeComposerSend).toHaveBeenCalledTimes(1)
  })

  it('硬门禁阻止发送', () => {
    const { result } = renderSendHook(true)

    act(() => {
      result.current.handleSend()
    })

    expect(mocks.previewFunding).not.toHaveBeenCalled()
    expect(mocks.finalizeComposerSend).not.toHaveBeenCalled()
  })

  it('不依赖模型能力即可发送 ZIP 资源附件', () => {
    const zipFile = new File(['PK'], 'materials.zip', { type: 'application/zip' })
    const attachment: ChatAttachment = {
      id: 'zip-1',
      file: zipFile,
      filename: zipFile.name,
      mimeType: zipFile.type,
      size: zipFile.size,
      type: 'file',
      status: 'ready',
      fileId: 'file-1',
    }
    const { result } = renderSendHook(false, [attachment])

    act(() => {
      result.current.handleSend()
    })

    expect(mocks.warning).not.toHaveBeenCalled()
    expect(mocks.finalizeComposerSend).toHaveBeenCalledTimes(1)
  })

  it('未知附件类型也不会被模型能力门禁阻止', () => {
    const zipFile = new File(['data'], 'materials.custom', { type: 'application/x-custom' })
    const attachment: ChatAttachment = {
      id: 'zip-1',
      file: zipFile,
      filename: zipFile.name,
      mimeType: zipFile.type,
      size: zipFile.size,
      type: 'file',
      status: 'ready',
      fileId: 'file-1',
    }
    const { result } = renderSendHook(false, [attachment])

    act(() => result.current.handleSend())

    expect(mocks.warning).not.toHaveBeenCalled()
    expect(mocks.finalizeComposerSend).toHaveBeenCalledTimes(1)
  })

  it('本地 Codex 模型可发送普通 Agent 工作文件', () => {
    const file = new File(['log'], 'diagnostics.txt', { type: 'text/plain' })
    const attachment: ChatAttachment = {
      id: 'file-1',
      file,
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      type: 'file',
      status: 'ready',
      fileId: 'uploaded-file-1',
    }
    const { result } = renderSendHook(false, [attachment])

    act(() => result.current.handleSend())

    expect(mocks.warning).not.toHaveBeenCalled()
    expect(mocks.finalizeComposerSend).toHaveBeenCalledTimes(1)
  })
})
