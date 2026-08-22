import { describe, expect, it, vi } from 'vitest'
import {
  createLoginRelayHandlers,
  createLoginRelayPackageUploader,
  createLoginRelayWorkspaceOrganizationResolver,
} from './ipc'
import {
  LOGIN_RELAY_IMPORT_WAIT_TIMEOUT_MS,
  LOGIN_RELAY_UPLOAD_RESPONSE_GRACE_MS,
} from './timeout-contract'

describe('login relay IPC', () => {
  it('resolves the server-authoritative workspace organization with Bearer auth', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'space-1',
          organization_id: 'org-workspace',
        },
      }),
    })
    const resolveWorkspaceOrganization = createLoginRelayWorkspaceOrganizationResolver({
      apiBaseUrl: 'https://api.example.test/api',
      getAccessToken: vi.fn().mockResolvedValue('access-token'),
      fetchFn,
    })

    await expect(resolveWorkspaceOrganization('space-1')).resolves.toEqual({
      ok: true,
      organizationId: 'org-workspace',
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/api/context/workspaces/space-1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer access-token' },
      }),
    )
  })

  it('registers the fixed channels and forwards the authenticated sender', async () => {
    const manager = {
      start: vi.fn().mockResolvedValue({ success: true, relayId: 'relay-1' }),
      complete: vi.fn().mockResolvedValue({ success: true, packageId: 'package-1' }),
      cancel: vi.fn().mockReturnValue({ success: true }),
      dispose: vi.fn(),
    }
    const handlers = createLoginRelayHandlers(manager)
    const event = { sender: { id: 7 } }

    expect(Object.keys(handlers)).toEqual([
      'login-relay:start',
      'login-relay:complete',
      'login-relay:cancel',
    ])
    await expect(handlers['login-relay:start'](event as never, {
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'example.com',
    })).resolves.toEqual({
      ok: true,
      data: { success: true, relayId: 'relay-1' },
    })
    expect(manager.start).toHaveBeenCalledWith(event.sender, expect.any(Object))
  })

  it('uploads with Bearer auth and maps a valid create-package response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        package_id: 'package-1',
        import_result: { success: true, imported_count: 2, reloaded: true },
      }),
    })
    const upload = createLoginRelayPackageUploader({
      apiBaseUrl: 'https://api.example.test/api',
      getAccessToken: vi.fn().mockResolvedValue('access-token'),
      fetchFn,
      timeoutMs: 100,
    })
    const body = {
      space_id: 'space-1',
      thread_id: 'thread_login_relay_1',
      domain: 'example.com',
      tab_id: 'view-login-wall',
      cookies: [],
    }

    await expect(upload(body)).resolves.toEqual({
      ok: true,
      data: {
        package_id: 'package-1',
        import_result: { success: true, imported_count: 2, reloaded: true },
      },
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/api/login-relay/packages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer access-token',
          'X-TabTin-Login-Relay-Protocol-Version': 'v1',
        },
        body: JSON.stringify(body),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('keeps the create-package request alive through the shared server wait and response grace', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn((_url: string, init: RequestInit) => new Promise<Pick<Response, 'ok' | 'json'>>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        setTimeout(() => resolve({
          ok: true,
          json: vi.fn().mockResolvedValue({
            package_id: 'package-1',
            import_result: { success: true, imported_count: 2 },
          }),
        }), LOGIN_RELAY_IMPORT_WAIT_TIMEOUT_MS + LOGIN_RELAY_UPLOAD_RESPONSE_GRACE_MS - 1_000)
      }))
      const upload = createLoginRelayPackageUploader({
        apiBaseUrl: 'https://api.example.test/api',
        getAccessToken: vi.fn().mockResolvedValue('access-token'),
        fetchFn,
      })

      const firstCreate = upload({
        space_id: 'space-1',
        thread_id: 'thread_login_relay_1',
        domain: 'example.com',
        cookies: [],
      })
      await vi.advanceTimersByTimeAsync(
        LOGIN_RELAY_IMPORT_WAIT_TIMEOUT_MS + LOGIN_RELAY_UPLOAD_RESPONSE_GRACE_MS - 1_000,
      )

      await expect(firstCreate).resolves.toEqual({
        ok: true,
        data: {
          package_id: 'package-1',
          import_result: { success: true, imported_count: 2 },
        },
      })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['missing token', null, { ok: true, json: vi.fn() }, '登录已失效，请重新登录'],
    ['non-2xx', 'token', { ok: false, status: 503, json: vi.fn() }, '服务暂时不可用，请重试'],
    ['execution device unavailable', 'token', { ok: false, status: 409, json: vi.fn() }, '执行设备暂不可用，请确认执行设备在线后重试'],
    ['invalid response', 'token', { ok: true, json: vi.fn().mockResolvedValue({ token: 'secret' }) }, '服务响应无效，请重试'],
  ])('normalizes %s without leaking server details', async (_label, token, response, error) => {
    const upload = createLoginRelayPackageUploader({
      apiBaseUrl: 'https://api.example.test/api',
      getAccessToken: vi.fn().mockResolvedValue(token),
      fetchFn: vi.fn().mockResolvedValue(response),
      timeoutMs: 100,
    })
    await expect(upload({
      space_id: 'space-1',
      thread_id: 'thread_login_relay_1',
      domain: 'example.com',
      cookies: [],
    })).resolves.toEqual({ ok: false, error })
  })

  it('aborts timed-out uploads and returns an actionable safe error', async () => {
    const fetchFn = vi.fn((_url: string, init: RequestInit) => new Promise<never>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const upload = createLoginRelayPackageUploader({
      apiBaseUrl: 'https://api.example.test/api',
      getAccessToken: vi.fn().mockResolvedValue('token'),
      fetchFn,
      timeoutMs: 1,
    })
    await expect(upload({
      space_id: 'space-1',
      thread_id: 'thread_login_relay_1',
      domain: 'example.com',
      cookies: [],
    })).resolves.toEqual({ ok: false, error: '服务响应超时，请重试' })
  })
})
