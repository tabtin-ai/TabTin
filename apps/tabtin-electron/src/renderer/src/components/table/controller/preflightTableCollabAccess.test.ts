import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  electronFetch: vi.fn(),
  getAuthToken: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  getAuthToken: mocks.getAuthToken,
}))
vi.mock('@/services/electronFetch', () => ({
  electronFetch: mocks.electronFetch,
}))
vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://localhost:6060/api' },
}))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn }),
}))

import { preflightTableCollabAccess } from './preflightTableCollabAccess'

describe('preflightTableCollabAccess embedded access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthToken.mockResolvedValue('jwt-token')
  })

  it('sends the parent document context to Django collab auth', async () => {
    mocks.electronFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        data: { authorized: true, collab_mode: 'full' },
      }),
    })

    await preflightTableCollabAccess('table-1', ' doc-parent ')

    expect(mocks.electronFetch).toHaveBeenCalledWith(
      expect.stringContaining('/collab/v1/table/table-1/auth'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'X-TabTin-Parent-Document-Id': 'doc-parent',
        }),
      }),
    )
  })

  it('turns an explicit 403 into a definitive permission decision', async () => {
    mocks.electronFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
    })

    await expect(preflightTableCollabAccess('table-1', 'doc-parent')).resolves.toEqual({
      authorized: false,
      reason: 'permission_denied',
    })
    expect(mocks.warn).toHaveBeenCalledWith(
      'collab auth preflight denied',
      expect.objectContaining({
        tableId: 'table-1',
        parentDocumentId: 'doc-parent',
        reason: 'permission_denied',
      }),
    )
  })

  it('keeps an unavailable parent-reference check distinct from permission denial', async () => {
    mocks.electronFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'X-TabTin-Embedded-Access-Unavailable': '1' }),
    })

    await expect(preflightTableCollabAccess('table-1', 'doc-parent')).resolves.toEqual({
      authorized: false,
      reason: 'access_verification_unavailable',
    })
  })
})
