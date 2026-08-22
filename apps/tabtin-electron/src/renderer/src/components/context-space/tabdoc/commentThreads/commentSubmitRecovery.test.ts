import { describe, expect, it } from 'vitest'
import {
  isRecoverableTabdocCommentSubmitError,
  tabdocCommentSubmitErrorDescription,
} from './commentSubmitRecovery'

const t = (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key

describe('commentSubmitRecovery', () => {
  it('maps network and timeout failures to recoverable draft-preserved copy', () => {
    expect(tabdocCommentSubmitErrorDescription(new Error('request timeout'), t as never))
      .toContain('草稿已保留')
    expect(tabdocCommentSubmitErrorDescription({ code: 'NETWORK_ERROR', message: 'fetch failed' }, t as never))
      .toContain('请检查网络后重试')
  })

  it('keeps business errors actionable instead of hiding them behind network copy', () => {
    expect(isRecoverableTabdocCommentSubmitError({ status: 403, message: 'request timeout' })).toBe(false)
    expect(tabdocCommentSubmitErrorDescription(new Error('没有评论权限'), t as never)).toBe('没有评论权限')
  })
})
