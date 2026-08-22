import { beforeEach, describe, expect, it, vi } from 'vitest'
import { showReactionErrorToast } from './reactionErrorToast'

const toastMock = vi.hoisted(() => vi.fn())

vi.mock('@components/ui', () => ({ toast: toastMock }))
vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

describe('showReactionErrorToast', () => {
  beforeEach(() => toastMock.mockClear())

  it('腾讯单条消息 Reaction 达到上限时展示明确提示', () => {
    showReactionErrorToast(new Error(
      'addMessageReaction failed. error: {"message": , "code": 23005}',
    ))

    expect(toastMock).toHaveBeenCalledWith({
      title: 'tabchat:reactionLimitExceeded',
      variant: 'destructive',
    })
  })

  it('其他错误沿用通用失败提示', () => {
    showReactionErrorToast(new Error('network failed'))

    expect(toastMock).toHaveBeenCalledWith({
      title: 'tabchat:reactionFailed',
      variant: 'destructive',
    })
  })
})
