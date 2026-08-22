/**
 * openWebTabInSpace — 在 Space 内用 tabweb crawl view 真正打开一个 http(s) URL。
 *
 * # 背景（BR-31）
 *
 * chat 里点击裸 http(s) 链接「在 Space 内打开」、或点击 `web_selection` 上下文块时，
 * 旧实现只把一条 `{ type:'tabweb', id:<url> }` 的「壳 tab」塞进
 * `useSpaceContextTabsStore`——**从不创建 WebContentsView、也不导航**。结果：顶栏出现
 * 一个以 URL 原文为标题的标签，但右侧内容区全空白，页面根本没加载。
 *
 * 根因：tabweb 真正能加载页面的载体是 crawlspace 的 WebContentsView，tab 必须用
 * `viewId`（`view-<csId>-<ts>`）而非 URL 作 key；URL 只是导航目标。通用
 * `openResourceTab` 不懂 crawlspace，只会记一条 React state。
 *
 * # 正确流程（与 `useSpaceContextNavigation.createWebTab` 同序）
 *
 *   ensureScopedCrawlspace → createView(viewId, url) → setActiveView → setActiveKey(viewId)
 *
 * 关键顺序：**view 进 crawlspace cache 后再 `setActiveKey`**。否则
 * WorkbenchRestoreCoordinator 会把指向「尚不存在的 view」的「幽灵 tabweb key」判为
 * stale 自清，回退到 Agent 起始页（见 createWebTab 注释）。失败路径不 setActiveKey，
 * 避免留下空壳激活态。
 *
 * 返回 `{ ok:true }` = view 真创建 + 导航成功；`{ ok:false, error }` = 失败原因
 *（供 toast / ResourceRouter 透传，避免只剩泛化的
 * `openWebTabInSpace failed for url: …`，见 ）。
 */
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { resolveBrowserOpenTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { createLogger } from '@/utils/logger'
import { activateBrowserView } from '@/services/browserViewActivation'
import { seedManager } from '@stores/seed-manager'
import { resolveOpenIntent, type OpenIntentHints } from '@shared/open-intent'

const log = createLogger('openWebTabInSpace')

/** 单调递增计数器：保证同毫秒多次调用 viewId 不撞。 */
let _viewSeq = 0

export type OpenWebTabResult =
  | { ok: true; viewId: string; crawlspaceId: string }
  | { ok: false; error: string; reason?: 'preview_required' }

/**
 * id 是否是 http(s) URL（用于区分「要导航的网址」与「已存在的 crawl viewId」）。
 *
 * crawl viewId 形如 `view-<csId>-<ts>`，永远不会以 `http://` / `https://` 开头；
 * 因此前缀判断足够精确、且不依赖 `URL` 解析的边角行为。
 */
export function isHttpUrlId(id: string): boolean {
  return /^https?:\/\//i.test(id)
}

function normalizeComparableUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    // hash（如 Electron→tabweb 的 tabtin_handoff）不参与同页复用判断
    parsed.hash = ''
    return parsed.href
  } catch {
    return trimmed
  }
}

function fail(
  error: string,
  context: Record<string, unknown>,
  reason?: 'preview_required',
): OpenWebTabResult {
  log.warn(error, context)
  return { ok: false, error, ...(reason ? { reason } : {}) }
}

/**
 * 聚焦当前 Space 内已经存在的同 URL 网页视图。
 *
 * web_annotation 的「跳转到来源」语义是回到当时那页；如果这页还开着，
 * 复用原 view 可以保留页面状态、滚动位置和登录态，也避免用户看到重复 tab。
 */
export async function focusExistingWebTabInSpace(
  spaceId: string,
  url: string,
  options?: { tabScopeKey?: string | null },
): Promise<boolean> {
  const result = await focusExistingWebTabInSpaceDetailed(spaceId, url, options)
  return result.ok
}

export async function focusExistingWebTabInSpaceDetailed(
  spaceId: string,
  url: string,
  options?: { tabScopeKey?: string | null },
): Promise<OpenWebTabResult> {
  if (!spaceId || !url) return fail('spaceId 或 url 为空', { spaceId, url })
  const storageKey = resolveBrowserOpenTabScopeKey(spaceId, options?.tabScopeKey)

  try {
    const store = useCrawlTabStore.getState()
    const crawlspace = store.getScopedCrawlspace(storageKey) ?? store.getSpaceCrawlspace(spaceId)
    const crawlspaceId = crawlspace?.id
    if (!crawlspaceId) return fail('当前 scope 没有可用的浏览器工作区', { spaceId, storageKey })

    const targetUrl = normalizeComparableUrl(url)
    const existingView = store.getCrawlspaceViews(crawlspaceId).find(view => {
      if (view.isClosing) return false
      return normalizeComparableUrl(view.url) === targetUrl
    })
    if (!existingView) return fail('未找到同 URL 的已有网页标签', { spaceId, url })

    // silent：只占 tabOrder，active 仍由 activateBrowserView 设置；失败时不抢焦点。
    useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
      type: 'tabweb',
      id: existingView.viewId,
      title: existingView.title || existingView.url || url,
      meta: { url: existingView.url, crawlspaceId, spaceId },
      silent: true,
    })

    const result = await activateBrowserView(crawlspaceId, existingView.viewId, {
      spaceId,
      fallbackView: {
        viewId: existingView.viewId,
        url: existingView.url,
        title: existingView.title,
      },
      selection: { tabScopeKey: storageKey },
    })
    if (!result.ok) {
      return fail(result.message || `激活失败: ${result.code}`, {
        spaceId,
        viewId: existingView.viewId,
        result,
      })
    }
    if (result.code === 'cancelled') {
      return fail('浏览器标签激活被取消', { spaceId, viewId: existingView.viewId, result })
    }
    return { ok: true, viewId: existingView.viewId, crawlspaceId }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), { spaceId, url, err })
  }
}

/**
 * 在当前 tab scope 内用 tabweb crawl view 打开一个 http(s) URL。
 * 可预览资源必须由上游打开 Preview Modal；本层在任何状态写入前拒绝误调用。
 */
export async function openWebTabInSpace(
  spaceId: string,
  url: string,
  options?: {
    title?: string
    allowPrivateHostNavigation?: boolean
    tabScopeKey?: string | null
    openIntentHints?: OpenIntentHints
  },
): Promise<OpenWebTabResult> {
  if (!spaceId || !url) return fail('spaceId 或 url 为空', { spaceId, url })
  const openIntent = resolveOpenIntent({
    url,
    ...options?.openIntentHints,
  })
  if (openIntent.kind === 'preview') {
    return fail(
      '可预览资源不能创建浏览器标签',
      {
        spaceId,
        previewKind: openIntent.previewKind,
        confidence: openIntent.confidence,
      },
      'preview_required',
    )
  }
  const storageKey = resolveBrowserOpenTabScopeKey(spaceId, options?.tabScopeKey)

  try {
    const crawlspace = useCrawlTabStore.getState().ensureScopedCrawlspace(spaceId, storageKey)
    const crawlspaceId = crawlspace.id
    let createViewFailure: string | undefined
    const ipcAdapter = createElectronIpcAdapter(crawlspaceId, spaceId, {
      onCreateViewFailure: message => {
        createViewFailure = message
      },
    })
    const viewId = `view-${crawlspaceId}-${Date.now()}-${++_viewSeq}`
    const tabKey = `tabweb:${viewId}`
    const title = options?.title

    const created = await ipcAdapter.createView(
      viewId,
      url,
      undefined,
      title,
      undefined,
      {
        allowPrivateHostNavigation: options?.allowPrivateHostNavigation,
        openIntentHints: options?.openIntentHints,
      },
    )
    if (!created) {
      return fail(createViewFailure || 'createView 失败', { spaceId, url, crawlspaceId, viewId })
    }

    // createView 成功后立刻落 seed + 写入 tabOrder + 带 fallbackView 激活，避免：
    // 1) getContext 拉到不含新 view 的过期 snapshot 清空 cache；
    // 2) setActiveView 短暂 "view not found" 时 activate 走 missing_metadata；
    // 3) 只 setActiveKey 却未进 tabOrder →「key not in tabOrder」与 self-heal。
    const seedTitle = title || url
    seedManager.ensureSeed(crawlspaceId, {
      viewId,
      url,
      title: seedTitle,
      openIntentHints: options?.openIntentHints,
    })
    useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
      type: 'tabweb',
      id: viewId,
      title: seedTitle,
      meta: { url, crawlspaceId, spaceId, openIntentHints: options?.openIntentHints },
      silent: true,
    })

    const result = await activateBrowserView(crawlspaceId, viewId, {
      spaceId,
      fallbackView: { viewId, url, title: seedTitle },
      selection: { tabScopeKey: storageKey, tabKey },
    })
    if (!result.ok) {
      return fail(result.message || `activateBrowserView 失败: ${result.code}`, {
        spaceId,
        viewId,
        result,
      })
    }
    if (result.code === 'cancelled') {
      return fail('浏览器标签激活被取消', { spaceId, viewId, result })
    }
    return { ok: true, viewId, crawlspaceId }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), { spaceId, url, err })
  }
}
