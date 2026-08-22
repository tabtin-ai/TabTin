/**
 * requestAgentForBrowser — 在「浏览器」首页把示例任务直接交给 Agent 的统一入口
 *
 * 触发场景：用户在浏览器首页的「让 AI 帮你处理浏览器」介绍区点某张示例任务卡片，
 * 或在「全部能力」弹窗里对某条 CLI 能力点「交给 Tin」。
 *
 * 行为：
 *   1. 展开右侧 ChatSidePanel（如果折叠）——Agent 在副驾栏开干，用户停留在当前页面
 *   2. 新建一轮会话——「点示例 = 开一个独立任务」，不污染既有对话
 *   3. 直接把示例 prompt 作为用户消息发出去，Agent 立刻开干
 *
 * 律 1「唤起不流放」（principle/workspace-project.md §7.2，）：
 * 唤起 AI 不切走画布——历史版本的 setActiveKey(spaceId, null) 已移除，
 * 理由见 requestAgentForTable 文件头。注意 getCurrentBrowserView 对
 * useSpaceContextTabsStore 只剩「读」（识别当前页），不再有任何写入。
 *
 * 设计原则：
 * - 与 requestAgentForDoc / requestAgentForTable 同源：store / UI 编排集中在一个 helper，
 *   业务组件只管点。
 * - 这里走「直接发送」而非「注入 preset 表单」——浏览器示例本身就是一条完整可执行的请求。
 */

import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@/stores/useCrawlTabStore'
import { requestAppCollaboration } from '@/services/requestAppCollaboration'

export interface BrowserAgentRequestMeta {
  source?: 'featured' | 'capability-dialog' | 'manual'
  commandName?: string
  scenarioKey?: string
  title?: string
}

interface BrowserPageContextBlock extends Record<string, unknown> {
  type: 'webpage'
  preview: string
  url: string
  page_title: string
  tab_type: 'tabweb'
  favicon?: string
}

function isUsablePageUrl(url: string | null | undefined): url is string {
  const trimmed = url?.trim()
  return Boolean(trimmed && trimmed !== 'about:blank')
}

function findViewById(viewId: string): CrawlspaceViewInfo | null {
  const crawlState = useCrawlTabStore.getState()
  for (const cache of Object.values(crawlState.crawlspaceContextCache)) {
    const view = cache.viewList.find(v => v.viewId === viewId)
    if (view && isUsablePageUrl(view.url)) return view
  }
  return null
}

function getCurrentBrowserView(spaceId: string): CrawlspaceViewInfo | null {
  const tabState = useSpaceContextTabsStore.getState()
  const activeKey = tabState.getActiveKey(spaceId)
  if (activeKey?.startsWith('tabweb:')) {
    const activeView = findViewById(activeKey.slice('tabweb:'.length))
    if (activeView) return activeView
  }

  const crawlState = useCrawlTabStore.getState()
  const crawlspaceId = crawlState.getSpaceCrawlspace(spaceId)?.id
  if (!crawlspaceId) return null

  const activeViewId = crawlState.getActiveCrawlspaceViewId(crawlspaceId)
  if (activeViewId) {
    const activeView = findViewById(activeViewId)
    if (activeView) return activeView
  }

  const usableViews = crawlState.getCrawlspaceViews(crawlspaceId).filter(view => isUsablePageUrl(view.url))
  return usableViews.length === 1 ? usableViews[0] : null
}

function buildCurrentPageContextBlock(spaceId: string): BrowserPageContextBlock | undefined {
  const view = getCurrentBrowserView(spaceId)
  if (!view || !isUsablePageUrl(view.url)) return undefined
  const title = view.title?.trim() || view.url
  return {
    type: 'webpage',
    preview: title,
    url: view.url,
    page_title: title,
    tab_type: 'tabweb',
    ...(view.favicon ? { favicon: view.favicon } : {}),
  }
}

export async function requestAgentForBrowser(
  spaceId: string,
  prompt: string,
  meta: BrowserAgentRequestMeta = {},
): Promise<void> {
  const body = prompt.trim()
  if (!spaceId || !body) return
  const currentPageContextBlock = buildCurrentPageContextBlock(spaceId)
  requestAppCollaboration({
    sourceLabel: meta.title || '浏览器',
    spaceId,
    prompt: body,
    contextBlocks: currentPageContextBlock ? [currentPageContextBlock] : undefined,
  })
}
