import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const crawlCleanHtml = vi.hoisted(() => vi.fn())

vi.mock('@tabtin/agent-wire', () => ({
  okResponse: (data: Record<string, unknown>) => ({ ok: true, data }),
}))

vi.mock('@tabtin/action-tools/impl', async () => {
  // 渲染器用真实实现（含 --include 白名单），只把 crawlCleanHtml 换成受控 mock。
  const actual = await vi.importActual<typeof import('@tabtin/action-tools/impl')>('@tabtin/action-tools/impl')
  return {
    ...actual,
    getSharedCrawlToolImpl: () => ({ crawlCleanHtml }),
  }
})

vi.mock('../browser/_helpers', () => ({
  resolveTabId: vi.fn(),
  requireTabWithView: vi.fn(),
  makeTaskId: (prefix: string) => `test-${prefix}`,
  errorResponse: (code: string, message: string) => ({ code, message }),
  isSafeUrl: () => true,
  sanitizeSavePath: (p: string) => p, // 测试里直接放行 /tmp 路径
}))

import { handlePrintRoute } from '../browser/print'
import {
  clearBrowserNavigationEvidenceForTests,
  getUnverifiedNavigationBlock,
} from '../browser/navigation-evidence'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'tabtin-print-evidence-'))

describe('browser print route feeds navigation evidence ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearBrowserNavigationEvidenceForTests()
  })

  // print 落盘产物按 --include 白名单剥离，但导航证据以**原始页面 HTML**为事实源
  // （页面上真实存在的链接就该被 open 放行，与产物是否保留链接无关）。
  it('records anchor hrefs from print --url source html so open passes the guard', async () => {
    const pageUrl = 'https://www.xiaohongshu.com/search_result?keyword=ai'
    const anchorUrl = 'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search'
    crawlCleanHtml.mockResolvedValue({
      success: true,
      clean_html: `<a href="https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&amp;xsec_source=pc_search">笔记</a>`,
      title: '搜索结果',
      url: pageUrl,
      content_length: 100,
    })
    const sendJSON = vi.fn()

    const handled = await handlePrintRoute(
      '/print',
      { url: pageUrl, save: join(TMP_DIR, 'evidence.md') },
      {} as any,
      sendJSON,
      vi.fn(),
    )

    expect(handled).toBe(true)
    expect(sendJSON).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ ok: true }))
    // 源页面 anchor 里出现过的链接（实体解码后）应被守卫放行——即使 markdown 产物默认剥了链接
    expect(getUnverifiedNavigationBlock(anchorUrl)).toBeUndefined()
    // 凭空猜的同站二级页仍被拦
    expect(getUnverifiedNavigationBlock('https://www.xiaohongshu.com/explore/guessed')).toBeDefined()
  })
})
