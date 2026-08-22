import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMessage = vi.fn()

vi.mock('../../../useChatStore', () => ({
  useChatStore: {
    getState: () => ({ sendMessage }),
  },
}))

import {
  CONTINUATION_TRIGGERED_BY,
  ERROR_RETRY_CONTINUE_PROMPT,
  continueAgentAfterError,
} from '../continueAgentAfterError'

describe('continueAgentAfterError', () => {
  beforeEach(() => {
    sendMessage.mockReset()
  })

  it('同一会话续跑，不重发用户原话', () => {
    void continueAgentAfterError('sess-1')
    expect(sendMessage).toHaveBeenCalledWith(
      ERROR_RETRY_CONTINUE_PROMPT,
      true,
      undefined,
      undefined,
      'sess-1',
      {
        triggeredBy: CONTINUATION_TRIGGERED_BY,
        displayMessage: '',
      },
    )
  })
})
