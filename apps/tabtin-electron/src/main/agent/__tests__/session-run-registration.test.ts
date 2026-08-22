import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSessionRunRegistrationHttpApi,
  SessionRunRegistrationHttpError,
} from '../session-run-registration'

describe('session run registration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('用同一个业务 run id 登记 Electron 本机执行', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        outcome: 'claimed',
        run_id: 'run-1',
        lease_token: 'lease-1',
        generation: 1,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const api = createSessionRunRegistrationHttpApi({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: async () => 'token',
    })

    await api.accept({
      threadId: 'chat-session-session-1',
      runId: 'run-1',
      taskId: 'task-1',
      organizationId: 'org-1',
      hostId: 'electron:device-1',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, request] = fetchMock.mock.calls[0]
    expect(JSON.parse(request.body)).toEqual({
      thread_id: 'chat-session-session-1',
      run_id: 'run-1',
      task_id: 'task-1',
      organization_id: 'org-1',
      host_id: 'electron:device-1',
      lease_seconds: 90,
    })
    expect(request.headers.Authorization).toBe('Bearer token')
  })

  it('没有登录态时拒绝伪造权威 run', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const api = createSessionRunRegistrationHttpApi({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: async () => null,
    })

    await expect(api.accept({
      threadId: 'session-1',
      runId: 'run-1',
      taskId: 'task-1',
      hostId: 'electron:device-1',
    })).rejects.toThrow('not authenticated')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('保留服务端拒绝状态，供 Host 区分兼容降级与契约错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }))
    const api = createSessionRunRegistrationHttpApi({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: async () => 'token',
    })

    await expect(api.accept({
      threadId: 'session-1',
      runId: 'run-1',
      taskId: 'task-1',
      hostId: 'electron:device-1',
    })).rejects.toEqual(new SessionRunRegistrationHttpError(403))
  })

  it('响应丢失时用同一 run id 重试并接管最新 lease', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network reset'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          outcome: 'claimed',
          run_id: 'run-retry',
          lease_token: 'lease-retry',
          generation: 2,
        }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const api = createSessionRunRegistrationHttpApi({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: async () => 'token',
    })

    const result = await api.accept({
      threadId: 'session-1',
      runId: 'run-retry',
      taskId: 'task-1',
      hostId: 'electron:device-1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.lease_token).toBe('lease-retry')
  })
})
