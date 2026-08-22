import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  rememberConversationRoute: vi.fn(),
}))

vi.mock('@tabtin/config', () => ({ joinApiPath: (base: string, path: string) => `${base}${path}` }))
vi.mock('@/config/api', () => ({ API_CONFIG: { baseURL: 'http://api' } }))
vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: mocks.apiRequest,
  getAuthToken: vi.fn(async () => 'token'),
}))
vi.mock('@/services/api', () => ({ ApiError: class ApiError extends Error {} }))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/constants/tabchat', () => ({
  CHAT_CONTENT_FILTER_MESSAGE: 'message',
  MESSAGE_TYPE_FILE: 3,
  MESSAGE_TYPE_TEXT: 1,
  MESSAGES_PAGE_SIZE: 50,
  SEARCH_PAGE_SIZE: 20,
}))
vi.mock('./im', () => ({
  createDefaultIMProviderRegistry: () => ({
    rememberConversationRoute: mocks.rememberConversationRoute,
  }),
  createClientRequestId: vi.fn(),
  createMessageRef: vi.fn(),
}))
vi.mock('./im/providers/djangoProvider', () => ({
  createDjangoIMProvider: () => ({}),
}))
vi.mock('./sessionShareApi', () => ({ shareApiRequest: vi.fn() }))

import { getConversation } from './tabchatApi'

beforeEach(() => {
  vi.clearAllMocks()
})

it('routes an external conversation through the current participant organization', async () => {
  mocks.apiRequest.mockResolvedValue({
    status: 200,
    data: {
      success: true,
      message: 'ok',
      code: 200,
      data: {
        id: 'conversation-1',
        organization_id: '',
        participant_organization_id: 'participant-org',
        directory_scope_id: 'directory-scope',
        members: [],
      },
    },
  })

  const detail = await getConversation('conversation-1')

  expect(mocks.rememberConversationRoute).toHaveBeenCalledWith(
    'conversation-1',
    'participant-org',
  )
  expect(detail.organization_id).toBe('participant-org')
})
