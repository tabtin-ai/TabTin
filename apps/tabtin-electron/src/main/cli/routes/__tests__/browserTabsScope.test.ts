import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => vi.fn())
const executor = vi.hoisted(() => vi.fn())
const runObserveForOpen = vi.hoisted(() => vi.fn(async () => undefined as Record<string, unknown> | undefined))
const resolveWorkspaceLocalHtmlOpen = vi.hoisted(() => vi.fn(() => null as any))
const crawlspaceContextHub = vi.hoisted(() => ({ getSnapshot: vi.fn(), getAllSnapshots: vi.fn() }))
const runSessionManager = vi.hoisted(() => ({ getQuota: vi.fn() }))

vi.mock('@tabtin/agent-wire', () => ({
  okResponse: (data: Record<string, unknown>) => ({ ok: true, data }),
}))

// tabs.ts → interaction.ts 的 import 链会触电 electron（logger/ApprovalManager），
// 本套件只测 tabs 路由本身，内嵌观察以 mock 注入返回值。
vi.mock('../browser/interaction', () => ({
  runObserveForOpen,
}))

vi.mock('../browser/_helpers', () => ({
  resolveTabId: vi.fn(),
  resolveContextBrowserTabId: vi.fn(),
  buildBrowserRequestScope: vi.fn((body: any) => {
    const spaceId = body?.spaceId ?? body?.space_id
    const tabScopeKey = body?.tabScopeKey ?? body?.tab_scope_key
    const workspaceScopeKey = body?.workspaceScopeKey ?? body?.workspace_scope_key
    const crawlspaceId = body?.crawlspaceId ?? body?.crawlspace_id
    const threadId = body?._thread_id ?? body?.thread_id ?? body?.threadId
    const runId = body?.runId ?? body?.run_id
    return {
      ...(spaceId ? { spaceId } : {}),
      ...(tabScopeKey ? { tabScopeKey } : {}),
      ...(workspaceScopeKey ? { workspaceScopeKey } : {}),
      ...(crawlspaceId ? { crawlspaceId } : {}),
      ...(threadId ? { _thread_id: threadId } : {}),
      ...(runId ? { runId } : {}),
    }
  }),
  validateViewExists: vi.fn(),
  makeTaskId: (prefix: string) => `test-${prefix}`,
  sendExecutorResult: vi.fn(),
  handleRouteError: vi.fn(),
  requireBridgeAndSpace: () => ({ bridge, spaceId: 'space-1' }),
  errorResponse: (code: string, message: string, options?: Record<string, unknown>) => ({ code, message, ...options }),
  getCLICrawlspaceId: () => 'cs-1',
  isSafeUrl: () => true,
  // 默认非本地 HTML；本地预览用例再按需覆写
  resolveWorkspaceLocalHtmlOpen,
}))

vi.mock('../../routes/session', () => ({
  getActiveSessionName: () => undefined,
}))

vi.mock('../../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => crawlspaceContextHub,
}))

vi.mock('../../../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => runSessionManager,
}))

// getWebContents 默认返回存活 wc：/open 的 guest attach 等待首次检查即命中（WCV 语义）。
// webview 收养时序相关用例里按需改写为 null → 存活。
const viewFactoryMock = vi.hoisted(() => ({
  getViewState: vi.fn(),
  getWebContents: vi.fn(),
  listQuotaSnapshotItems: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}))

vi.mock('../../../view-factory/ViewFactory', () => ({
  getViewFactory: () => viewFactoryMock,
}))

import { handleTabsRoute } from '../browser/tabs'
import {
  buildBrowserRequestScope,
  resolveContextBrowserTabId,
  resolveTabId,
  validateViewExists,
} from '../browser/_helpers'
import {
  clearBrowserNavigationEvidenceForTests,
  recordBrowserNavigationEvidenceFromHtml,
  recordBrowserNavigationEvidenceFromHrefs,
} from '../browser/navigation-evidence'

describe('browser tabs route navigation evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearBrowserNavigationEvidenceForTests()
    viewFactoryMock.getWebContents.mockImplementation(() => ({ isDestroyed: () => false }))
    viewFactoryMock.listQuotaSnapshotItems.mockReturnValue([
      { viewId: 'reclaimable-agent-view', profile: 'agent-workspace' },
    ])
    runSessionManager.getQuota.mockReturnValue({ maxTotalViews: 20 })
    crawlspaceContextHub.getSnapshot.mockReturnValue({ views: [] })
    crawlspaceContextHub.getAllSnapshots.mockReturnValue([])
    bridge.mockResolvedValue({
      success: true,
      data: {
        crawlspaceId: 'cs-scope-1',
        viewId: 'view-cs-scope-1-1',
        tabKey: 'tabweb:view-cs-scope-1-1',
      },
    })
    executor.mockResolvedValue({
      success: true,
      data: {
        status: 'loaded',
        finalUrl: 'https://36kr.com/',
      },
    })
  })

  it('同一 Agent run 的重试默认复用自己已打开的页面，不再创建新标签', async () => {
    // 真实 CLI 在前台刚切换 workspace 时 crawlspace scope 可能尚未同步；
    // runId 是唯一归属，应能跨 hub snapshot 找回自己的页。
    crawlspaceContextHub.getAllSnapshots.mockReturnValue([{
      crawlspaceId: 'cs-agent-run',
      views: [{ viewId: 'view-agent-run', runId: 'agent-run-1', isClosing: false }],
    }])
    vi.mocked(resolveTabId).mockResolvedValueOnce('view-agent-run' as any)
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://example.com/retry', runId: 'agent-run-1' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(bridge).not.toHaveBeenCalled()
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({ crawlTabId: 'view-agent-run', url: 'https://example.com/retry' }),
    }))
  })

  it('open rejects guessed same-site secondary URLs after markdown evidence exists', async () => {
    recordBrowserNavigationEvidenceFromHtml('https://www.36kr.com/', `
      <nav>
        <a href="https://36kr.com/organization/">VClub投资机构库</a>
        <div class="nav-label">创投平台</div>
      </nav>
    `)
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://36kr.com/venture' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({
        code: 'UNVERIFIED_NAVIGATION_URL',
      }),
    )
    expect(bridge).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })

  it('open allows guessed same-site URL when skipNavigationEvidenceCheck (reach trusted)', async () => {
    recordBrowserNavigationEvidenceFromHtml('https://www.douyin.com/', `
      <nav><a href="https://www.douyin.com/jingxuan">精选</a></nav>
    `)
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      {
        url: 'https://www.douyin.com/video/7665301544481899407',
        skipNavigationEvidenceCheck: true,
      },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(bridge).toHaveBeenCalled()
    expect(sendJSON).not.toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'UNVERIFIED_NAVIGATION_URL' }),
    )
  })

  it('open allows URLs observed in recent markdown evidence', async () => {
    recordBrowserNavigationEvidenceFromHtml('https://www.36kr.com/', `
      <nav>
        <a href="https://36kr.com/organization/">VClub投资机构库</a>
      </nav>
    `)
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://36kr.com/organization/' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(bridge).toHaveBeenCalled()
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({
        url: 'https://36kr.com/organization/',
      }),
    }))
  })

  it('#6847：Workspace 本地 HTML 走 browser open，并透传 localPreviewRoot', async () => {
    const fileUrl = 'file:///Users/me/workspace/attachments/report.html'
    resolveWorkspaceLocalHtmlOpen.mockReturnValueOnce({
      ok: true,
      url: fileUrl,
      localPreviewRoot: '/Users/me/workspace',
      absolutePath: '/Users/me/workspace/attachments/report.html',
      title: 'report.html',
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'attachments/report.html' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(bridge).toHaveBeenCalledWith(
      'create_web_tab',
      expect.objectContaining({
        url: fileUrl,
        title: 'report.html',
        localPreviewRoot: '/Users/me/workspace',
      }),
      15000,
    )
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({
        url: fileUrl,
        localPreviewRoot: '/Users/me/workspace',
      }),
    }))
  })

  it('open 达到 View 上限时返回配额错误，不再误导 Agent 重启应用', async () => {
    bridge.mockResolvedValueOnce({
      success: false,
      error: '达到全局最大 View 数限制 (20)',
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://example.com/' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        code: 'QUOTA_EXCEEDED',
        message: '达到全局最大 View 数限制 (20)',
        suggestions: expect.arrayContaining([expect.stringContaining('关闭')]),
      }),
    )
    expect(executor).not.toHaveBeenCalled()
  })

  it('：webview guest 未收养时 open 等收养完成再发 load_tab_url', async () => {
    let attached = false
    const listeners: Array<[string, (payload: { id: string }) => void]> = []
    viewFactoryMock.getWebContents.mockImplementation(() =>
      attached ? { isDestroyed: () => false } : null,
    )
    viewFactoryMock.on.mockImplementation((event: string, listener: (payload: { id: string }) => void) => {
      listeners.push([event, listener])
    })
    const sendJSON = vi.fn()

    const routePromise = handleTabsRoute(
      '/open',
      { url: 'https://example.com/' },
      {} as any,
      sendJSON,
      executor,
    )

    // 进入等待态：已订阅收养事件，且尚未发导航
    await vi.waitFor(() => {
      expect(listeners.some(([event]) => event === 'view:registered')).toBe(true)
    })
    expect(executor).not.toHaveBeenCalled()

    // 模拟 renderer <webview> did-attach → ViewFactory 收养 guest
    attached = true
    for (const [event, listener] of listeners) {
      if (event === 'view:registered') listener({ id: 'view-cs-scope-1-1' })
    }

    const handled = await routePromise
    expect(handled).toBe(true)
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({ url: 'https://example.com/' }),
    }))
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ ok: true }),
    )
  })

  it('：首段等待超时后 guest 短时间内收养，open 内部吸收恢复并一次性成功', async () => {
    vi.useFakeTimers()
    try {
      let attached = false
      viewFactoryMock.getWebContents.mockImplementation(() =>
        attached ? { isDestroyed: () => false } : null,
      )
      const sendJSON = vi.fn()

      const routePromise = handleTabsRoute(
        '/open',
        { url: 'https://example.com/' },
        {} as any,
        sendJSON,
        executor,
      )

      await vi.advanceTimersByTimeAsync(15_001)
      expect(sendJSON).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()

      attached = true
      await vi.advanceTimersByTimeAsync(3_000)
      const handled = await routePromise

      expect(handled).toBe(true)
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({
        type: 'load_tab_url',
        params: expect.objectContaining({ url: 'https://example.com/' }),
      }))
      expect(sendJSON).toHaveBeenCalledWith(
        expect.anything(),
        200,
        expect.objectContaining({ ok: true }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('：guest 始终未收养 → 超时返回真失败（非 ok:true + navigation 假错）', async () => {
    vi.useFakeTimers()
    try {
      viewFactoryMock.getWebContents.mockImplementation(() => null)
      const sendJSON = vi.fn()

      const routePromise = handleTabsRoute(
        '/open',
        { url: 'https://example.com/' },
        {} as any,
        sendJSON,
        executor,
      )
      await vi.advanceTimersByTimeAsync(21_000)
      const handled = await routePromise

      expect(handled).toBe(true)
      expect(executor).not.toHaveBeenCalled()
      const [, status, payload] = sendJSON.mock.calls[0]
      expect(status).toBe(500)
      expect(payload.code).toBe('INTERNAL_ERROR')
      expect(payload.message).toContain('20s 内未就绪')
      expect(payload.detail).toMatchObject({ tabId: 'view-cs-scope-1-1', attachWaitMs: 20_000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('#5125：attach 超时后自动回收自建 tab，错误引导直接重开而非 --tab-id 死路', async () => {
    vi.useFakeTimers()
    try {
      viewFactoryMock.getWebContents.mockImplementation(() => null)
      const sendJSON = vi.fn()

      const routePromise = handleTabsRoute(
        '/open',
        { url: 'https://example.com/' },
        {} as any,
        sendJSON,
        executor,
      )
      await vi.advanceTimersByTimeAsync(21_000)
      await routePromise

      expect(bridge).toHaveBeenCalledWith(
        'close_context_tab',
        expect.objectContaining({ tabKey: 'tabweb:view-cs-scope-1-1' }),
        expect.any(Number),
      )
      const [, status, payload] = sendJSON.mock.calls[0]
      expect(status).toBe(500)
      expect(payload.detail).toMatchObject({ cleanedUp: true })
      expect(payload.message).toContain('已自动回收')
      // 回收后的 suggestions 不得再引导对已回收 tab 做 --tab-id 重试
      for (const suggestion of payload.suggestions as string[]) {
        expect(suggestion).not.toContain('--tab-id view-cs-scope-1-1')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('#5125：attach 超时且回收失败时，引导手动 tab close 清理残留', async () => {
    vi.useFakeTimers()
    try {
      viewFactoryMock.getWebContents.mockImplementation(() => null)
      bridge.mockImplementation(async (method: string) => {
        if (method === 'close_context_tab') return { success: false, error: 'close failed' }
        return {
          success: true,
          data: {
            crawlspaceId: 'cs-scope-1',
            viewId: 'view-cs-scope-1-1',
            tabKey: 'tabweb:view-cs-scope-1-1',
          },
        }
      })
      const sendJSON = vi.fn()

      const routePromise = handleTabsRoute(
        '/open',
        { url: 'https://example.com/' },
        {} as any,
        sendJSON,
        executor,
      )
      await vi.advanceTimersByTimeAsync(21_000)
      await routePromise

      const [, status, payload] = sendJSON.mock.calls[0]
      expect(status).toBe(500)
      expect(payload.detail).toMatchObject({ cleanedUp: false })
      expect((payload.suggestions as string[]).some(s => s.includes('tab close'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('#5125：open --tab-id 命中「已登记未挂载」的 tab → 409 VIEW_NOT_READY（非 VIEW_NOT_FOUND）', async () => {
    vi.mocked(resolveTabId).mockResolvedValue(undefined as any)
    vi.mocked(resolveContextBrowserTabId).mockResolvedValue('view-registered')
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://example.com/', tabId: 'view-registered' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        code: 'VIEW_NOT_READY',
        retryable: true,
      }),
    )
    expect(executor).not.toHaveBeenCalled()
  })

  it('#5125：tab list 标注 attached（登记 ≠ 已加载，URL 不再撒谎）', async () => {
    vi.mocked(validateViewExists).mockImplementation((viewId: string) => viewId === 'view-a')
    bridge.mockResolvedValue({
      success: true,
      data: {
        tabs: [
          { type: 'tabweb', id: 'view-a', tabKey: 'tabweb:view-a', title: 'A', meta: { url: 'https://a.example/' } },
          { type: 'tabweb', id: 'view-b', tabKey: 'tabweb:view-b', title: 'B', meta: { url: 'https://b.example/' } },
        ],
        activeTabKey: 'tabweb:view-a',
      },
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute('/tabs', {}, {} as any, sendJSON, executor)

    expect(handled).toBe(true)
    const [, status, payload] = sendJSON.mock.calls[0]
    expect(status).toBe(200)
    const tabs = payload.data.tabs as Array<{ viewId: string; attached: boolean }>
    expect(tabs.find(t => t.viewId === 'view-a')?.attached).toBe(true)
    expect(tabs.find(t => t.viewId === 'view-b')?.attached).toBe(false)
  })

  it('open allows a token-bearing URL recorded from observe hrefs ', async () => {
    // 模拟小红书搜索页 observe 拿到的带 xsec_token 真实链接
    const tokenUrl = 'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search'
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/search_result?keyword=ai', [tokenUrl])
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute('/open', { url: tokenUrl }, {} as any, sendJSON, executor)

    expect(handled).toBe(true)
    expect(bridge).toHaveBeenCalled()
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({ url: tokenUrl }),
    }))
  })

  it('open still rejects the bare token-less note URL agent tends to guess ', async () => {
    // observe 只暴露了带 token 的 /search_result 链接；Agent 拼的裸 /explore 应仍被拦
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/search_result?keyword=ai', [
      'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search',
    ])
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://www.xiaohongshu.com/explore/69f884a5' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'UNVERIFIED_NAVIGATION_URL' }),
    )
    expect(executor).not.toHaveBeenCalled()
  })

  it('open allows entity-decoded form of an anchor href containing &amp; ( D4)', async () => {
    // HTML 源码里多参数 href 是实体编码的 &amp;；markdown/DOM 解码后是 &。
    // Agent 从 .md 逐字照抄 & 版链接，必须放行。
    recordBrowserNavigationEvidenceFromHtml('https://www.xiaohongshu.com/search_result?keyword=ai', `
      <a href="https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&amp;xsec_source=pc_search">笔记</a>
    `)
    const sendJSON = vi.fn()
    const decodedUrl = 'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search'

    const handled = await handleTabsRoute('/open', { url: decodedUrl }, {} as any, sendJSON, executor)

    expect(handled).toBe(true)
    expect(bridge).toHaveBeenCalled()
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({ url: decodedUrl }),
    }))
  })

  it('open block message points agent to the same-path verified href ( D4)', async () => {
    // 目标 URL path 在证据里出现过但 query 被 Agent 改写（如 xsec_source 值被截断），
    // 拦截 message 正文必须直接给出可照抄的完整已验证链接。
    const verifiedHref = 'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search'
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/search_result?keyword=ai', [verifiedHref])
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({
        code: 'UNVERIFIED_NAVIGATION_URL',
        message: expect.stringContaining(verifiedHref),
      }),
    )
    expect(executor).not.toHaveBeenCalled()
  })

  it('open allows http URL when the same host only observed the https twin (eastmoney JSONP)', async () => {
    // siteKey 按 hostname：证据页与目标必须同 host（finance.*），不能用 so.* 冒充。
    // 页面 DOM 是 https，reach JSONP 吐 http——仅 scheme 不同应放行。
    const httpsHref = 'https://finance.eastmoney.com/a/202607243820422690.html'
    recordBrowserNavigationEvidenceFromHrefs(
      'https://finance.eastmoney.com/a/202607243820422690.html',
      [httpsHref],
    )
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'http://finance.eastmoney.com/a/202607243820422690.html' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(sendJSON).not.toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'UNVERIFIED_NAVIGATION_URL' }),
    )
    expect(bridge).toHaveBeenCalled()
  })

  it('open still blocks http URL when https twin path was never observed', async () => {
    recordBrowserNavigationEvidenceFromHrefs('https://finance.eastmoney.com/a/other.html', [
      'https://finance.eastmoney.com/a/other.html',
    ])
    const sendJSON = vi.fn()

    await handleTabsRoute(
      '/open',
      { url: 'http://finance.eastmoney.com/a/202607243820422690.html' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'UNVERIFIED_NAVIGATION_URL' }),
    )
    expect(bridge).not.toHaveBeenCalled()
  })

  it('open block message prefers the query-bearing same-path href over a bare one', async () => {
    // 同一笔记页面常同时有裸链 anchor（封面图）和带签名参数的 anchor：
    // 引导必须优先给带 query 的完整链接，推荐裸链会让 Agent 撞站点风控
    const bareHref = 'https://www.xiaohongshu.com/explore/69f884a5'
    const tokenHref = 'https://www.xiaohongshu.com/explore/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search'
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/explore', [bareHref, tokenHref])
    const sendJSON = vi.fn()

    await handleTabsRoute(
      '/open',
      { url: 'https://www.xiaohongshu.com/explore/69f884a5?xsec_token=TAMPERED' },
      {} as any,
      sendJSON,
      executor,
    )

    const [, status, payload] = sendJSON.mock.calls[0]
    expect(status).toBe(400)
    expect(payload.message).toContain(`请改用: ${tokenHref}`)
  })

  it('open block message has no same-path candidate for a tampered-token cross-path guess', async () => {
    // 篡改 token 值 + 跨 path 的猜测 URL：仍拦，且 message 不夹带跨 path 的候选（防误导）
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/search_result?keyword=ai', [
      'https://www.xiaohongshu.com/search_result/69f884a5?xsec_token=ABGTaCn&xsec_source=pc_search',
    ])
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://www.xiaohongshu.com/explore/69f884a5?xsec_token=FORGED' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    const [, status, payload] = sendJSON.mock.calls[0]
    expect(status).toBe(400)
    expect(payload.code).toBe('UNVERIFIED_NAVIGATION_URL')
    expect(payload.message).not.toContain('请改用')
    expect(executor).not.toHaveBeenCalled()
  })

  it('open allows a URL absent from recorded evidence but present in the live DOM (page model)', async () => {
    // 事实源 = 页面真相：证据里没有这条链接（模拟 eval 采集 / observe 截断在 50 之外），
    // 但它真在当前 tab 的 DOM 里 → 实时求证后放行。
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/explore', [
      'https://www.xiaohongshu.com/other',
    ])
    const liveUrl = 'https://www.xiaohongshu.com/explore/6a44f441?xsec_token=LIVE&xsec_source=pc_feed'
    vi.mocked(resolveTabId).mockResolvedValue('view-live-1')
    executor.mockImplementation(async (action: any) => {
      if (action.type === 'eval') {
        return {
          success: true,
          data: {
            result: JSON.stringify({
              url: 'https://www.xiaohongshu.com/search_result_ai?keyword=x',
              hrefs: [liveUrl],
            }),
          },
        }
      }
      return { success: true, data: { status: 'loaded', finalUrl: liveUrl } }
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute('/open', { url: liveUrl }, {} as any, sendJSON, executor)

    expect(handled).toBe(true)
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ type: 'eval' }))
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load_tab_url',
      params: expect.objectContaining({ url: liveUrl }),
    }))
  })

  it('open still blocks a guessed URL absent from both evidence and the live DOM', async () => {
    // 凭空猜的 URL：证据没有、实时 DOM 也没有 → 求证过但仍拦（反幻觉不变）
    recordBrowserNavigationEvidenceFromHrefs('https://www.xiaohongshu.com/explore', [
      'https://www.xiaohongshu.com/other',
    ])
    vi.mocked(resolveTabId).mockResolvedValue('view-live-1')
    executor.mockImplementation(async (action: any) => {
      if (action.type === 'eval') {
        return {
          success: true,
          data: {
            result: JSON.stringify({
              url: 'https://www.xiaohongshu.com/explore',
              hrefs: ['https://www.xiaohongshu.com/somethingelse'],
            }),
          },
        }
      }
      return { success: true, data: { status: 'loaded' } }
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://www.xiaohongshu.com/explore/GUESSED?xsec_token=x' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ type: 'eval' }))
    expect(executor).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'load_tab_url' }))
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'UNVERIFIED_NAVIGATION_URL' }),
    )
  })

  it('#5376：open 成功后内嵌观察结果（observed_elements 进响应）', async () => {
    runObserveForOpen.mockResolvedValueOnce({
      observed_elements: [{ ref: 'e1', role: 'button', class: 'pagination-next' }],
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/open',
      { url: 'https://example.com/' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(runObserveForOpen).toHaveBeenCalledWith(executor, expect.anything(), 'view-cs-scope-1-1')
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          observed_elements: [{ ref: 'e1', role: 'button', class: 'pagination-next' }],
        }),
      }),
    )
  })

  it('#5376：--observe=false 跳过内嵌观察', async () => {
    const sendJSON = vi.fn()

    await handleTabsRoute(
      '/open',
      { url: 'https://example.com/', observe: false },
      {} as any,
      sendJSON,
      executor,
    )

    expect(runObserveForOpen).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ ok: true }),
    )
  })

  it('#5376：导航失败（recoverable）时跳过内嵌观察，响应形状不变', async () => {
    executor.mockResolvedValueOnce({ success: false, error: 'TIMEOUT' })
    const sendJSON = vi.fn()

    await handleTabsRoute(
      '/open',
      { url: 'https://example.com/' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(runObserveForOpen).not.toHaveBeenCalled()
    const [, status, payload] = sendJSON.mock.calls[0]
    expect(status).toBe(200)
    expect(payload.data.navigation).toMatchObject({ success: false, recoverable: true })
    expect(payload.data.observed_elements).toBeUndefined()
  })

  it('open 的 load_tab_url 不 settle 时先内部超时，再用观察结果给 Agent 可恢复响应', async () => {
    vi.useFakeTimers()
    try {
      executor.mockReturnValueOnce(new Promise(() => {}))
      runObserveForOpen.mockResolvedValueOnce({
        observed_elements: [{ ref: 'e1', text: '创投平台' }],
      })
      const sendJSON = vi.fn()

      const routePromise = handleTabsRoute(
        '/open',
        { url: 'https://36kr.com/' },
        {} as any,
        sendJSON,
        executor,
      )

      await vi.advanceTimersByTimeAsync(30_001)
      const handled = await routePromise

      expect(handled).toBe(true)
      expect(runObserveForOpen).toHaveBeenCalledWith(executor, expect.anything(), 'view-cs-scope-1-1')
      const [, status, payload] = sendJSON.mock.calls[0]
      expect(status).toBe(200)
      expect(payload.ok).toBe(true)
      expect(payload.data.navigation).toMatchObject({
        success: false,
        recoverable: true,
        status: 'timeout',
        error: expect.objectContaining({ code: 'CONNECTION_TIMEOUT' }),
      })
      expect(payload.data.observed_elements).toEqual([{ ref: 'e1', text: '创投平台' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('#5376：内嵌观察失败（返回 undefined）不影响 open 成功响应', async () => {
    runObserveForOpen.mockResolvedValueOnce(undefined)
    const sendJSON = vi.fn()

    await handleTabsRoute('/open', { url: 'https://example.com/' }, {} as any, sendJSON, executor)

    const [, status, payload] = sendJSON.mock.calls[0]
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(payload.data.observed_elements).toBeUndefined()
  })

  it('tab-switch 把 renderer 中的 deferred 标签交给统一激活桥，不在 main 提前拒绝', async () => {
    vi.mocked(resolveContextBrowserTabId).mockResolvedValue('view-deferred')
    bridge.mockResolvedValue({
      success: true,
      data: { activeTabKey: 'tabweb:view-deferred' },
    })
    const sendJSON = vi.fn()

    const handled = await handleTabsRoute(
      '/tab-switch',
      { tabId: 'view-deferred', spaceId: 'space-1', crawlspaceId: 'cs-1' },
      {} as any,
      sendJSON,
      executor,
    )

    expect(handled).toBe(true)
    expect(bridge).toHaveBeenCalledWith('set_active_context_tab', {
      spaceId: 'space-1',
      tabKey: 'tabweb:view-deferred',
      crawlspaceId: 'cs-1',
    })
    expect(sendJSON).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ ok: true }),
    )
  })

  it('#6538：tab-switch 统一透传 originating thread scope', async () => {
    vi.mocked(resolveContextBrowserTabId).mockResolvedValue('view-session-a')
    const sendJSON = vi.fn()
    const body = {
      tabId: 'view-session-a',
      space_id: 'space-1',
      crawlspace_id: 'cs-a',
      thread_id: 'session-A',
    }

    await handleTabsRoute('/tab-switch', body, {} as any, sendJSON, executor)

    expect(buildBrowserRequestScope).toHaveBeenCalledWith(body)
    expect(resolveContextBrowserTabId).toHaveBeenCalledWith(
      'view-session-a',
      expect.objectContaining({ _thread_id: 'session-A' }),
    )
    expect(bridge).toHaveBeenCalledWith(
      'set_active_context_tab',
      expect.objectContaining({ _thread_id: 'session-A' }),
    )
  })

  it('#6538：tab-close 统一透传 originating thread scope', async () => {
    // ：close 改用 renderer 标签清单解析（resolveContextBrowserTabId），
    // 不再要求 WebContents 存在——未挂载的僵尸标签也能关掉。
    vi.mocked(resolveContextBrowserTabId).mockResolvedValue('view-session-a')
    const sendJSON = vi.fn()
    const body = {
      tabId: 'view-session-a',
      spaceId: 'space-1',
      crawlspaceId: 'cs-a',
      _thread_id: 'session-A',
    }

    await handleTabsRoute('/tab-close', body, {} as any, sendJSON, executor)

    expect(buildBrowserRequestScope).toHaveBeenCalledWith(body)
    expect(resolveContextBrowserTabId).toHaveBeenCalledWith(
      'view-session-a',
      expect.objectContaining({ _thread_id: 'session-A' }),
    )
    expect(bridge).toHaveBeenCalledWith(
      'close_context_tab',
      expect.objectContaining({ _thread_id: 'session-A' }),
      expect.any(Number),
    )
  })
})
