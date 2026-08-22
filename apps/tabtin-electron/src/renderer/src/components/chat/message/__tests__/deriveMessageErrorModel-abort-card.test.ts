/**
 * ：手动 ABORT → 灰色「已中断」徽标；无卡、无 Run aborted 文案。
 * 异常硬停 → ErrorClassCard。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { deriveMessageErrorModel } from '@stores/chat/presentation/messageBubble/deriveMessageErrorModel'

const t = (key: string) => key

describe('deriveMessageErrorModel ·  终止呈现', () => {
  it('ABORT → 灰色徽标，压制卡与 runtime 兜底文案', () => {
    const message = {
      id: 'ai-1',
      role: 'assistant',
      content: '半截',
      metadata: {
        errorClass: 'ABORT',
        aborted: true,
        errorMessage: 'Run aborted by user.',
      },
      created_at: '2026-07-20T00:00:00.000Z',
    } as ChatMessage

    const model = deriveMessageErrorModel({
      message,
      displayContent: '半截',
      isUser: false,
      isInterrupted: true,
      t,
    })

    expect(model.errorClassInfo).toBeNull()
    expect(model.errorMessage).toBeUndefined()
    expect(model.hasAbortErrorCard).toBe(true)
    expect(model.suppressBlockPartialReason).toBe(true)
    expect(model.shouldRenderInterruptedBadge).toBe(true)
  })

  it('text_loop_terminated → warning 卡，非 abort 徽标路径', () => {
    const message = {
      id: 'ai-1',
      role: 'assistant',
      content: '半截',
      metadata: { errorClass: 'text_loop_terminated', isErrorMessage: true },
      created_at: '2026-07-20T00:00:00.000Z',
    } as ChatMessage

    const model = deriveMessageErrorModel({
      message,
      displayContent: '半截',
      isUser: false,
      isInterrupted: false,
      t,
    })

    expect(model.errorClassInfo).not.toBeNull()
    expect(model.errorClassInfo!.title).toBe('errorClass.text_loop_terminated.title')
    expect(model.errorClassInfo!.severity).toBe('warning')
    expect(model.hasAbortErrorCard).toBe(false)
    expect(model.suppressBlockPartialReason).toBe(true)
    expect(model.shouldRenderInterruptedBadge).toBe(false)
  })
})
