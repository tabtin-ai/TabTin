import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getAccessToken: vi.fn(),
  getPartitionForSpace: vi.fn(),
  fromPartition: vi.fn(),
  getCLIContextSpaceBridge: vi.fn(),
  invokeContextSpaceBridge: vi.fn(),
  refreshLoginRelayTab: vi.fn(),
  setCookie: vi.fn(),
  requestWithLastAuth: vi.fn(),
}))

vi.stubGlobal('fetch', mocks.fetch)

vi.mock('electron', () => ({
  session: { fromPartition: mocks.fromPartition },
}))

vi.mock('../auth', () => ({
  TokenManager: { getAccessToken: mocks.getAccessToken },
}))

vi.mock('../config/api', () => ({
  API_BASE_URL: 'https://api.example.test/api',
}))

vi.mock('../browser-env/BrowserEnvironmentService', () => ({
  getBrowserEnvironmentService: () => ({
    getPartitionForSpace: mocks.getPartitionForSpace,
  }),
}))

vi.mock('../cli/cli-context', () => ({
  getCLIContextSpaceBridge: mocks.getCLIContextSpaceBridge,
}))

vi.mock('../ws/ElectronWsGateway', () => ({
  electronWsGateway: { requestWithLastAuth: mocks.requestWithLastAuth },
}))

vi.mock('./refresh-tab', () => ({
  refreshLoginRelayTab: mocks.refreshLoginRelayTab,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { AgentActionEvents } from '@tabtin/ws-gateway-client'
import { handleLoginRelayImportAction } from './import-handler'

const action = (overrides: Record<string, unknown> = {}) => ({
  action: 'login_relay.import',
  task_id: 'task-1',
  params: {
    package_id: 'pkg-1',
    space_id: 'space-1',
    organization_id: 'org-package-workspace',
    domain: 'example.com',
  },
  ...overrides,
})

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
})

const cookie = (overrides: Record<string, unknown> = {}) => ({
  name: 'sid',
  value: 'secret',
  domain: '.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  ...overrides,
})

describe('handleLoginRelayImportAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAccessToken.mockResolvedValue('access-token')
    mocks.getPartitionForSpace.mockImplementation((
      _spaceId: string,
      authoritativeOrganizationId?: string,
    ) => authoritativeOrganizationId
      ? `tabtin:organization:${authoritativeOrganizationId}:browser`
      : 'tabtin:organization:org-active-ui:browser')
    mocks.fromPartition.mockReturnValue({ cookies: { set: mocks.setCookie } })
    mocks.getCLIContextSpaceBridge.mockReturnValue(mocks.invokeContextSpaceBridge)
    mocks.invokeContextSpaceBridge.mockResolvedValue({ success: true })
    mocks.setCookie.mockResolvedValue(undefined)
    mocks.refreshLoginRelayTab.mockResolvedValue({ ok: true })
    mocks.requestWithLastAuth.mockResolvedValue({ ok: true })
    mocks.fetch.mockResolvedValue(response(200, {
      domain: 'example.com',
      cookies: [cookie(), cookie({ name: 'host', domain: 'login.example.com' })],
    }))
  })

  it('returns false without consuming unrelated actions', async () => {
    await expect(handleLoginRelayImportAction(
      { action: 'fs.list_dir', task_id: 'other' },
      { thread_id: 'thread-1' },
    )).resolves.toBe(false)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.requestWithLastAuth).not.toHaveBeenCalled()
  })

  it('uses the package Workspace organization even when the active UI organization differs', async () => {
    await expect(handleLoginRelayImportAction(action(), { thread_id: 'thread-1' }))
      .resolves.toBe(true)

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/login-relay/packages/pkg-1/consume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        }),
      }),
    )
    expect(mocks.getPartitionForSpace).toHaveBeenCalledWith(
      'space-1',
      'org-package-workspace',
    )
    expect(mocks.fromPartition).toHaveBeenCalledWith(
      'persist:tabtin:organization:org-package-workspace:browser',
    )
    expect(mocks.setCookie).toHaveBeenCalledTimes(2)
    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      { task_id: 'task-1', success: true, data: { imported_count: 2 } },
      { threadId: 'thread-1' },
    )
  })

  it('refreshes the exact blocked tab only after its cookies were imported', async () => {
    await expect(handleLoginRelayImportAction(action({
      params: {
        package_id: 'pkg-1',
        space_id: 'space-1',
        organization_id: 'org-package-workspace',
        domain: 'example.com',
        tab_id: 'view-login-wall',
      },
    }), { thread_id: 'thread-1' })).resolves.toBe(true)

    expect(mocks.refreshLoginRelayTab).toHaveBeenCalledWith({
      tabId: 'view-login-wall',
      expectedPartition: 'persist:tabtin:organization:org-package-workspace:browser',
      expectedDomain: 'example.com',
    })
    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      {
        task_id: 'task-1',
        success: true,
        data: { imported_count: 2, reloaded: true },
      },
      { threadId: 'thread-1' },
    )
  })

  it('does not report success when the blocked tab cannot be refreshed', async () => {
    mocks.refreshLoginRelayTab.mockResolvedValueOnce({
      ok: false,
      errorCode: 'reload_failed',
    })

    await handleLoginRelayImportAction(action({
      params: {
        package_id: 'pkg-1',
        space_id: 'space-1',
        organization_id: 'org-package-workspace',
        domain: 'example.com',
        tab_id: 'view-login-wall',
      },
    }), { thread_id: 'thread-1' })

    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      {
        task_id: 'task-1',
        success: false,
        error: 'Execution browser could not refresh the login page',
        error_code: 'reload_failed',
        data: { imported_count: 2 },
      },
      { threadId: 'thread-1' },
    )
  })

  it('restores an evicted blocked tab in its thread scope before refreshing it again', async () => {
    mocks.refreshLoginRelayTab
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'target_tab_unavailable',
      })
      .mockResolvedValueOnce({ ok: true })

    await handleLoginRelayImportAction(action({
      params: {
        package_id: 'pkg-1',
        space_id: 'space-1',
        organization_id: 'org-package-workspace',
        domain: 'example.com',
        tab_id: 'view-login-wall',
      },
    }), { thread_id: 'thread-1' })

    expect(mocks.invokeContextSpaceBridge).toHaveBeenCalledWith(
      'set_active_context_tab',
      {
        _thread_id: 'thread-1',
        spaceId: 'space-1',
        tabKey: 'tabweb:view-login-wall',
      },
    )
    expect(mocks.refreshLoginRelayTab).toHaveBeenCalledTimes(2)
    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      {
        task_id: 'task-1',
        success: true,
        data: { imported_count: 2, reloaded: true },
      },
      { threadId: 'thread-1' },
    )
  })

  it('reports payload validation failures instead of throwing or consuming the package', async () => {
    await expect(handleLoginRelayImportAction(
      action({ params: { package_id: 'pkg-1', space_id: '', domain: 'example.com' } }),
      { thread_id: 'thread-1' },
    )).resolves.toBe(true)

    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      expect.objectContaining({
        task_id: 'task-1',
        success: false,
        error: 'Invalid login relay action payload',
        error_code: 'invalid_action',
      }),
      { threadId: 'thread-1' },
    )
  })

  it('rejects an action without a server-authoritative Workspace organization', async () => {
    await expect(handleLoginRelayImportAction(action({
      params: {
        package_id: 'pkg-1',
        space_id: 'space-1',
        domain: 'example.com',
      },
    }), { thread_id: 'thread-1' })).resolves.toBe(true)

    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.fromPartition).not.toHaveBeenCalled()
    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      expect.objectContaining({
        task_id: 'task-1',
        success: false,
        error: 'Invalid login relay action payload',
        error_code: 'invalid_action',
      }),
      { threadId: 'thread-1' },
    )
  })

  it('reports consume 410 and other HTTP failures without reflecting response bodies', async () => {
    mocks.fetch.mockResolvedValueOnce(response(410, { detail: 'cookie-value-must-not-leak' }))
    await handleLoginRelayImportAction(action(), { thread_id: 'thread-1' })
    const result410 = mocks.requestWithLastAuth.mock.calls[0][1]
    expect(result410).toMatchObject({ task_id: 'task-1', success: false, error_code: 'consume_failed' })
    expect(result410.error).toContain('410')
    expect(result410.error).not.toContain('cookie-value-must-not-leak')

    vi.clearAllMocks()
    mocks.getAccessToken.mockResolvedValue('access-token')
    mocks.fetch.mockResolvedValueOnce(response(503, 'backend-secret'))
    mocks.requestWithLastAuth.mockResolvedValue({ ok: true })
    await handleLoginRelayImportAction(action(), { thread_id: 'thread-1' })
    expect(mocks.requestWithLastAuth.mock.calls[0][1]).toMatchObject({
      task_id: 'task-1',
      success: false,
      error: expect.stringContaining('503'),
      error_code: 'consume_failed',
    })
  })

  it('rejects a server domain mismatch before any cookie write', async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, {
      domain: 'evil.test',
      cookies: [cookie()],
    }))
    await handleLoginRelayImportAction(action(), { thread_id: 'thread-1' })

    expect(mocks.setCookie).not.toHaveBeenCalled()
    expect(mocks.requestWithLastAuth.mock.calls[0][1])
      .toMatchObject({
        success: false,
        error: 'Login relay package domain mismatch',
        error_code: 'domain_mismatch',
      })
  })

  it('rejects one out-of-scope cookie as a whole package with zero writes', async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, {
      domain: 'example.com',
      cookies: [cookie(), cookie({ name: 'escape', domain: 'not-example.com' })],
    }))
    await handleLoginRelayImportAction(action(), { thread_id: 'thread-1' })

    expect(mocks.setCookie).not.toHaveBeenCalled()
    expect(mocks.requestWithLastAuth.mock.calls[0][1])
      .toMatchObject({
        success: false,
        error: 'Login relay package contains an invalid cookie',
        error_code: 'invalid_cookie',
      })
  })

  it('rejects a public-suffix domain cookie before any cookie write', async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, {
      domain: 'foo.github.io',
      cookies: [
        cookie({ domain: 'foo.github.io' }),
        cookie({ name: 'cross-tenant', domain: '.github.io' }),
      ],
    }))
    await handleLoginRelayImportAction(action({
      params: {
        package_id: 'pkg-1',
        space_id: 'space-1',
        organization_id: 'org-package-workspace',
        domain: 'foo.github.io',
      },
    }), { thread_id: 'thread-1' })

    expect(mocks.setCookie).not.toHaveBeenCalled()
    expect(mocks.requestWithLastAuth.mock.calls[0][1])
      .toMatchObject({
        success: false,
        error: 'Login relay package contains an invalid cookie',
        error_code: 'invalid_cookie',
      })
  })

  it('reports that partial writes may have occurred if a cookie set fails', async () => {
    mocks.setCookie
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('secret cookie write failed'))

    await handleLoginRelayImportAction(action(), { thread_id: 'thread-1' })

    expect(mocks.setCookie).toHaveBeenCalledTimes(2)
    const result = mocks.requestWithLastAuth.mock.calls[0][1]
    expect(result).toEqual({
      task_id: 'task-1',
      success: false,
      error: 'Cookie import failed; partial writes may have occurred',
      error_code: 'cookie_write_failed',
      data: { imported_count: 1 },
    })
    expect(JSON.stringify(result)).not.toContain('secret cookie write failed')
  })

  it('reports a safe partition code when the execution browser partition is unavailable', async () => {
    mocks.getPartitionForSpace.mockReturnValueOnce('')

    await handleLoginRelayImportAction(action(), { thread_id: 'thread-1' })

    expect(mocks.requestWithLastAuth).toHaveBeenCalledWith(
      AgentActionEvents.RESULT,
      expect.objectContaining({
        task_id: 'task-1',
        success: false,
        error_code: 'partition_unavailable',
      }),
      { threadId: 'thread-1' },
    )
  })

  it('does not silently swallow result transport failures', async () => {
    mocks.requestWithLastAuth.mockRejectedValueOnce(new Error('websocket unavailable'))

    await expect(handleLoginRelayImportAction(action(), { thread_id: 'thread-1' }))
      .rejects.toThrow('websocket unavailable')
  })
})
