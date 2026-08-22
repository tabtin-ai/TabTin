import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpClient } from '../../core/http-client'
import { MessageManager } from '../MessageManager'
import { SessionManager } from '../SessionManager'

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
  getLocale: () => 'zh-CN',
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function buildManagers() {
  const http = new HttpClient({
    baseURL: 'https://api.test/chat',
    getToken: () => 'token-test',
  })
  return {
    sessions: new SessionManager(http),
    messages: new MessageManager(http),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ success: true, data: {} }),
  })
})

describe('shared-session access context', () => {
  it('详情与消息历史请求携带当前 shareId', async () => {
    const { sessions, messages } = buildManagers()

    await sessions.get('session-1', { shareId: 'share-1' })
    await messages.list('session-1', undefined, { shareId: 'share-1' })

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.test/chat/sessions/session-1?share_id=share-1',
      expect.stringContaining(
        'https://api.test/chat/sessions/session-1/messages?',
      ),
    ])
    expect(mockFetch.mock.calls[1]?.[0]).toContain('share_id=share-1')
  })

  it('普通任务入口不增加共享参数', async () => {
    const { sessions } = buildManagers()

    await sessions.get('session-1')

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://api.test/chat/sessions/session-1',
    )
  })
})
