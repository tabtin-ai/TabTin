import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionToolImpl } from '../SessionToolImpl'

function createMockView(opts?: { destroyed?: boolean }) {
  const mockCookiesGet = vi.fn().mockResolvedValue([])
  const mockCookiesSet = vi.fn().mockResolvedValue(undefined)
  const mockCookiesRemove = vi.fn().mockResolvedValue(undefined)
  const mockClearStorageData = vi.fn().mockResolvedValue(undefined)
  const mockClearCache = vi.fn().mockResolvedValue(undefined)

  return {
    view: {
      webContents: {
        isDestroyed: vi.fn(() => opts?.destroyed ?? false),
        session: {
          cookies: {
            get: mockCookiesGet,
            set: mockCookiesSet,
            remove: mockCookiesRemove,
          },
          clearStorageData: mockClearStorageData,
          clearCache: mockClearCache,
        },
      },
    },
    mocks: { mockCookiesGet, mockCookiesSet, mockCookiesRemove, mockClearStorageData, mockClearCache },
  }
}

describe('SessionToolImpl', () => {
  let impl: SessionToolImpl

  beforeEach(() => {
    impl = new SessionToolImpl()
  })

  // ── manageCookies ─────────────────────────────────────────

  describe('manageCookies', () => {
    it('无 tabId 且无 defaultSession 应返回描述性错误', async () => {
      const result = await impl.manageCookies({ action: 'get' })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error?.message).toContain('crawlTabId')
    })

    it('无 tabId 但有 defaultSession 应降级成功', async () => {
      const { mocks } = createMockView()
      const mockSession = {
        cookies: { get: mocks.mockCookiesGet, set: mocks.mockCookiesSet, remove: mocks.mockCookiesRemove },
        clearStorageData: mocks.mockClearStorageData,
        clearCache: mocks.mockClearCache,
      }
      impl.setDefaultSessionGetter(() => mockSession)

      const result = await impl.manageCookies({ action: 'get' })
      expect(result.success).toBe(true)
    })

    it('未设置 electronViewGetter 应返回 IPC 错误', async () => {
      const result = await impl.manageCookies({ action: 'get', crawlTabId: 'v1' })
      expect(result.success).toBe(false)
      expect(result.error?.code).toContain('ipc')
    })

    it('view 已销毁应返回 TAB_NOT_FOUND', async () => {
      const { view } = createMockView({ destroyed: true })
      impl.setElectronViewGetter(() => view)

      const result = await impl.manageCookies({ action: 'get', crawlTabId: 'v1' })
      expect(result.success).toBe(false)
    })

    describe('action=get', () => {
      it('应返回 cookies 列表', async () => {
        const { view, mocks } = createMockView()
        mocks.mockCookiesGet.mockResolvedValue([
          { name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 9999 },
        ])
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({ action: 'get', crawlTabId: 'v1' })

        expect(result.success).toBe(true)
        expect(result.data?.cookies).toHaveLength(1)
        expect(result.data?.cookies![0].name).toBe('sid')
      })

      it('按 domain 过滤应传递 filter', async () => {
        const { view, mocks } = createMockView()
        impl.setElectronViewGetter(() => view)

        await impl.manageCookies({ action: 'get', crawlTabId: 'v1', domain: '.example.com' })

        expect(mocks.mockCookiesGet).toHaveBeenCalledWith({ domain: '.example.com' })
      })

      it('按 url 过滤应传递 filter', async () => {
        const { view, mocks } = createMockView()
        impl.setElectronViewGetter(() => view)

        await impl.manageCookies({ action: 'get', crawlTabId: 'v1', url: 'https://example.com' })

        expect(mocks.mockCookiesGet).toHaveBeenCalledWith({ url: 'https://example.com' })
      })
    })

    describe('action=set', () => {
      it('应设置 cookies 并返回 set_count', async () => {
        const { view, mocks } = createMockView()
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({
          action: 'set',
          crawlTabId: 'v1',
          cookies: [
            { name: 'token', value: '123', domain: '.example.com', path: '/' },
          ],
        })

        expect(result.success).toBe(true)
        expect(result.data?.set_count).toBe(1)
        expect(mocks.mockCookiesSet).toHaveBeenCalledTimes(1)
      })

      it('空 cookies 数组应返回错误', async () => {
        const { view } = createMockView()
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({ action: 'set', crawlTabId: 'v1', cookies: [] })

        expect(result.success).toBe(false)
      })

      it('cookie 无 domain 应返回 INVALID_PARAMETER 而非构建空 URL', async () => {
        const { view } = createMockView()
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({
          action: 'set',
          crawlTabId: 'v1',
          cookies: [{ name: 'x', value: 'y' }],
        })

        expect(result.success).toBe(false)
        expect(result.error?.code).toBe('invalid_parameter')
        expect(result.error?.message).toContain('domain')
      })

      it('cookie 无 domain 但顶层 domain 有值时应正常设置', async () => {
        const { view, mocks } = createMockView()
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({
          action: 'set',
          crawlTabId: 'v1',
          domain: '.example.com',
          cookies: [{ name: 'x', value: 'y' }],
        })

        expect(result.success).toBe(true)
        expect(mocks.mockCookiesSet).toHaveBeenCalledWith(
          expect.objectContaining({ url: 'http://example.com/' }),
        )
      })

      it('sameSite=None 应映射为 no_restriction 并强制 secure', async () => {
        const { view, mocks } = createMockView()
        impl.setElectronViewGetter(() => view)

        await impl.manageCookies({
          action: 'set',
          crawlTabId: 'v1',
          cookies: [{ name: 'x', value: 'y', domain: '.test.com', sameSite: 'None' }],
        })

        expect(mocks.mockCookiesSet).toHaveBeenCalledWith(
          expect.objectContaining({ sameSite: 'no_restriction', secure: true }),
        )
      })
    })

    describe('action=clear', () => {
      it('应删除匹配 cookies 并返回 cleared_count', async () => {
        const { view, mocks } = createMockView()
        mocks.mockCookiesGet.mockResolvedValue([
          { name: 'a', domain: '.example.com', path: '/', secure: false },
          { name: 'b', domain: '.example.com', path: '/', secure: false },
        ])
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({ action: 'clear', crawlTabId: 'v1' })

        expect(result.success).toBe(true)
        expect(result.data?.cleared_count).toBe(2)
        expect(mocks.mockCookiesRemove).toHaveBeenCalledTimes(2)
      })

      it('domain 为空的 cookie 应被跳过而非构建无效 URL', async () => {
        const { view, mocks } = createMockView()
        mocks.mockCookiesGet.mockResolvedValue([
          { name: 'a', domain: '.example.com', path: '/', secure: false },
          { name: 'b', domain: '', path: '/', secure: false },
        ])
        impl.setElectronViewGetter(() => view)

        const result = await impl.manageCookies({ action: 'clear', crawlTabId: 'v1' })

        expect(result.success).toBe(true)
        expect(result.data?.cleared_count).toBe(1)
        expect(mocks.mockCookiesRemove).toHaveBeenCalledTimes(1)
      })
    })

    it('未知 action 应返回错误', async () => {
      const { view } = createMockView()
      impl.setElectronViewGetter(() => view)

      const result = await impl.manageCookies({ action: 'unknown' as any, crawlTabId: 'v1' })
      expect(result.success).toBe(false)
    })
  })

  // ── clearSession ──────────────────────────────────────────

  describe('clearSession', () => {
    it('无 tabId 且无 defaultSession 应返回错误', async () => {
      const result = await impl.clearSession({})
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('无 tabId 但有 defaultSession 应降级成功', async () => {
      const { mocks } = createMockView()
      const mockSession = {
        cookies: { get: mocks.mockCookiesGet, set: mocks.mockCookiesSet, remove: mocks.mockCookiesRemove },
        clearStorageData: mocks.mockClearStorageData,
        clearCache: mocks.mockClearCache,
      }
      impl.setDefaultSessionGetter(() => mockSession)

      const result = await impl.clearSession({})
      expect(result.success).toBe(true)
      expect(result.data?.cleared).toContain('cookies')
    })

    it('默认应清除 cookies + localStorage + cache', async () => {
      const { view, mocks } = createMockView()
      impl.setElectronViewGetter(() => view)

      const result = await impl.clearSession({ crawlTabId: 'v1' })

      expect(result.success).toBe(true)
      expect(result.data?.cleared).toContain('cookies')
      expect(result.data?.cleared).toContain('localstorage')
      expect(mocks.mockClearStorageData).toHaveBeenCalledTimes(1)
      expect(mocks.mockClearCache).toHaveBeenCalledTimes(1)
    })

    it('仅清除 cookies 应只传 cookies storage', async () => {
      const { view, mocks } = createMockView()
      impl.setElectronViewGetter(() => view)

      const result = await impl.clearSession({
        crawlTabId: 'v1',
        clearCookies: true,
        clearLocalStorage: false,
        clearCache: false,
      })

      expect(result.success).toBe(true)
      expect(result.data?.cleared).toEqual(['cookies'])
      expect(mocks.mockClearCache).not.toHaveBeenCalled()
    })

    it('clearStorageData 抛异常应返回 retriable 错误', async () => {
      const { view, mocks } = createMockView()
      mocks.mockClearStorageData.mockRejectedValue(new Error('storage error'))
      impl.setElectronViewGetter(() => view)

      const result = await impl.clearSession({ crawlTabId: 'v1' })

      expect(result.success).toBe(false)
      expect(result.error?.retriable).toBe(true)
    })
  })
})
