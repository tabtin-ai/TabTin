import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * NotificationPrefsStore.syncFromRemote —— 阻断-1（数据完整性 P0）回归。
 *
 * main 走裸 `net.fetch` + `resp.json()`，拿到的是后端成功外壳
 * `{success,code,message,data:{settings:{notificationPrefs:{value,updatedAt}}}}`。
 * 修复前 `extractNamespace` 漏 unwrap `data` 层 → 读到 null → 误判"服务器没有偏好"
 * → 把 DEFAULT 推回服务器静默清空 + WS 扩散。这里锁死：fresh 设备有服务器值时
 * 必须应用服务器值、且绝不发 PUT。
 */

const { mockFetch, getAccessToken, getUserInfo, configStore } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  getAccessToken: vi.fn(),
  getUserInfo: vi.fn(),
  configStore: new Map<string, unknown>(),
}))

vi.mock('electron', () => ({ net: { fetch: mockFetch } }))
vi.mock('../../../auth', () => ({ TokenManager: { getAccessToken, getUserInfo } }))
vi.mock('../../../config/api', () => ({ API_BASE_URL: 'http://test.local/api' }))
vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../ConfigService', () => ({
  configService: {
    get: (k: string) => configStore.get(k),
    set: (k: string, v: unknown) => {
      configStore.set(k, v)
    },
  },
}))

import { NotificationPrefsStore } from '../prefs-store'
import { DEFAULT_PREFS } from '../types'

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function putCalls() {
  return mockFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')
}

describe('NotificationPrefsStore.syncFromRemote — 阻断-1 GET 解包', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configStore.clear()
    getAccessToken.mockResolvedValue('tok-1')
    getUserInfo.mockResolvedValue({ id: 'user-1' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('GET 成功外壳 {success,data:{settings:{notificationPrefs}}} → 应用服务器值、不返回 null、绝不 PUT default', async () => {
    const serverPrefs = {
      enabled: false,
      desktopEnabled: false,
      dockBadgeEnabled: true,
      soundEnabled: true,
      dndEnabled: false,
      categoryOverrides: {},
    }
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        code: 0,
        message: 'ok',
        data: { settings: { notificationPrefs: { value: serverPrefs, updatedAt: 1_700_000_000_000 } } },
      }),
    )

    const store = new NotificationPrefsStore()
    const changed = await store.syncFromRemote()

    expect(changed).toBe(true)
    expect(store.get()).toEqual(serverPrefs)
    expect(store.get()).not.toEqual(DEFAULT_PREFS)
    // fresh 设备：只发了 1 次 GET，绝不 PUT（不把 DEFAULT 推回覆盖云端）
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(putCalls()).toHaveLength(0)
  })

  it('服务器真为空（data.settings 无 notificationPrefs）→ changed=false（与"漏解包误判空"区分）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { settings: {} } }))

    const store = new NotificationPrefsStore()
    const changed = await store.syncFromRemote()

    // 真空才返回 false；区别于阻断 bug 把"有值"误读成空
    expect(changed).toBe(false)
  })
})
