import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setCrawlToolRunnerFactory } from '../crawl-runner'

vi.mock('../../utils/runtime-bridge', () => ({
  resolveRunSessionAPI: () => ({ addEvent: vi.fn() }),
}))

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
}))

import { CrawlToolImpl, resetSharedCrawlToolImpl } from '../CrawlToolImpl'

describe('CrawlToolImpl', () => {
  const mockCrawlCleanHtml = vi.fn()
  const mockCleanup = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetSharedCrawlToolImpl()

    setCrawlToolRunnerFactory(() => ({
      crawlCleanHtml: mockCrawlCleanHtml,
      cleanup: mockCleanup,
    }))
  })

  afterEach(() => {
    setCrawlToolRunnerFactory(null)
  })

  describe('crawlCleanHtml', () => {
    it('正常返回应包含 clean_html + title + url', async () => {
      mockCrawlCleanHtml.mockResolvedValue({
        success: true,
        clean_html: '<p>Hello</p>',
        title: 'Test Page',
        url: 'https://example.com',
        content_length: 14,
      })

      const impl = new CrawlToolImpl()
      const result = await impl.crawlCleanHtml({ url: 'https://example.com' })

      expect(result.success).toBe(true)
      expect(result.clean_html).toBe('<p>Hello</p>')
      expect(result.title).toBe('Test Page')
      expect(result.url).toBe('https://example.com')
      expect(result.content_length).toBe(14)
    })

    it('runner 抛异常应返回格式化的错误', async () => {
      mockCrawlCleanHtml.mockRejectedValue(new Error('TIMEOUT: page load timeout'))

      const impl = new CrawlToolImpl()
      const result = await impl.crawlCleanHtml({ url: 'https://slow.example.com' })

      expect(result.success).toBe(false)
      expect(result.clean_html).toBe('')
      expect(result.url).toBe('https://slow.example.com')
      expect(result.error).toBeDefined()
    }, 25000)

    it('HUMAN_CHECK_REQUIRED 应返回验证码错误', async () => {
      mockCrawlCleanHtml.mockRejectedValue(new Error('HUMAN_CHECK_REQUIRED'))

      const impl = new CrawlToolImpl()
      const result = await impl.crawlCleanHtml({ url: 'https://protected.com' })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('NAVIGATION_FAILED 应返回导航失败错误', async () => {
      mockCrawlCleanHtml.mockRejectedValue(new Error('NAVIGATION_FAILED'))

      const impl = new CrawlToolImpl()
      const result = await impl.crawlCleanHtml({ url: 'https://bad-url.invalid' })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    }, 25000)

    it('404/页面未找到应返回 PAGE_NOT_FOUND（fatal，不重试）', async () => {
      // runner 返回结构化错误（含 404 消息），不经 formatError
      mockCrawlCleanHtml.mockResolvedValue({
        success: false,
        clean_html: '',
        title: '',
        url: 'https://example.com/404',
        content_length: 0,
        error: { message: 'Page not found (404)' } as any,
      })

      const impl = new CrawlToolImpl()
      const result = await impl.crawlCleanHtml({ url: 'https://example.com/404' })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.code).toBe('page_not_found')
      expect(result.error!.retriable).toBe(false)
      expect(result.error!.fatal).toBe(true)
      // 仅调用 1 次，不重试
      expect(mockCrawlCleanHtml).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanup', () => {
    it('应调用 runner 的 cleanup', async () => {
      const impl = new CrawlToolImpl()
      await impl.cleanup()

      expect(mockCleanup).toHaveBeenCalledTimes(1)
    })
  })

  describe('factory 未注册', () => {
    it('构造时无 factory 应抛异常', () => {
      setCrawlToolRunnerFactory(null)

      expect(() => new CrawlToolImpl()).toThrow()
    })
  })
})
