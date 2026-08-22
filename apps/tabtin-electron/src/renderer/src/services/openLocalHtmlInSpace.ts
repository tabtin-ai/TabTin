/**
 * openLocalHtmlInSpace — 在 Space 内嵌浏览器里打开一个「本地 HTML 产物」（file://）。
 *
 * # 背景
 *
 * Agent 用 write_file 落盘的 HTML 报告 / 采集结果，此前「预览」走 TabFiles 文本
 * 预览面板 → 只能看源码。对标内嵌浏览器本地 HTML 预览：应在内嵌浏览器（tabweb / crawlspace view）
 * 里真正渲染这张网页。
 *
 * # 与 openWebTabInSpace 的关系
 *
 * 复用同一套 crawl view 落地链路（ensureScopedCrawlspace → createView → activate），
 * 差别只有两点：
 *   1. URL 是 `file://<绝对路径>` 而非 http(s)；
 *   2. createView 带 `localPreviewRoot`（= 该 Space 工作目录）——主进程门禁
 *      （crawl-view/utils.validateNavigationUrl）据此**受限放行**落在工作目录内的
 *      file://，其余 file:// 一律拒绝。root 随 view config 持久化，⌘⇧T / discarded /
 *      重启恢复自动保持（无状态规则，见 view-display.resolveAllowedFileRoot）。
 *
 * 安全边界：只放行「工作目录内」的本地文件，且是用户在产物卡显式点「预览」这一
 * 可信入口。默认导航（地址栏 / 页面内跳转 / Agent loadUrl 工具）不带 root，file://
 * 维持拒绝。
 *
 * # 同 URL 复用
 *
 * 再次点「预览」/ 点卡片时，先按 `file://` URL 聚焦已有 tabweb（与
 * `focusExistingWebTabInSpace` 同口径），避免无限新开标签。
 *
 * # 返回值
 *
 * - `ok`：已在内嵌浏览器打开（含复用已有标签）
 * - `missing` / `unavailable`：路径解析失败（文件不存在、无工作目录等）——调用方应
 *   直接 toast，不要再级联 TabFiles / 系统打开（同一错误叠三次）
 * - `open_failed`：路径可用但 createView/激活失败——可回退通用打开路径
 */
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { activateBrowserView } from '@/services/browserViewActivation'
import { seedManager } from '@stores/seed-manager'
import { resolveLocalFilePath } from '@/services/localFileResourceResolver'
import { focusExistingWebTabInSpaceDetailed } from '@/services/openWebTabInSpace'
import { createLogger } from '@/utils/logger'
import type { ResourcePointer } from '@tabtin/resource-router'

const log = createLogger('openLocalHtmlInSpace')

let _viewSeq = 0

export type OpenLocalHtmlResult =
  | { ok: true }
  | {
      ok: false
      reason: 'missing' | 'unavailable' | 'open_failed'
      message?: string
    }

/**
 * 解析 Space 的执行工作目录——与 registry/index.ts 的 localFileResolver 同款口径：
 * Space.working_dir 优先，回退到绑定 Agent 的 working_dir。
 */
function resolveWorkingDir(spaceId: string): string | null {
  const state = useSpaceStore.getState()
  const space = state.spaces.find((s) => s.id === spaceId)
    ?? (state.selectedSpace?.id === spaceId ? state.selectedSpace : null)
  const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
  const agent = agentId
    ? (state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null))
    : null
  return space?.working_dir || agent?.working_dir || null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把绝对文件路径编码成 `file://` URL（各段单独 encodeURIComponent 兼容空格 / 中文）。
 * 与主进程 crawl-view/utils.fileUrlToLocalPath 的 decodeURIComponent 还原对称。
 */
export function buildLocalFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  // Windows：`C:/...` → `file:///C:/...`，保留盘符冒号不编码（Chromium 解析更稳）
  if (/^[A-Za-z]:\//.test(normalized)) {
    const [drive, ...rest] = normalized.split('/')
    const encoded = rest.map((seg) => (seg ? encodeURIComponent(seg) : '')).join('/')
    return `file:///${drive}/${encoded}`
  }
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = withLeadingSlash
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
    .join('/')
  return `file://${encoded}`
}

/**
 * 在当前 tab scope 内用 crawl view 打开一个本地 HTML 产物。
 */
export async function openLocalHtmlInSpace(
  spaceId: string,
  pointer: ResourcePointer,
  options?: { tabScopeKey?: string | null; title?: string },
): Promise<OpenLocalHtmlResult> {
  if (!spaceId) {
    return { ok: false, reason: 'unavailable', message: '缺少 Space 上下文' }
  }
  const storageKey = options?.tabScopeKey || spaceId

  const workingDir = resolveWorkingDir(spaceId)
  if (!workingDir) {
    log.warn('缺少工作目录，无法定位本地 HTML 产物', { spaceId })
    return {
      ok: false,
      reason: 'unavailable',
      message: '需要先设置或创建 Agent 工作目录',
    }
  }

  let absolutePath: string
  try {
    const resolved = await resolveLocalFilePath({
      pointer,
      workingDir,
      pathExists: async (p) => {
        const pathExists = window.tabtin?.fileSystem?.pathExists
        if (!pathExists) throw new Error('当前环境不支持本地文件检查')
        return pathExists(p)
      },
    })
    if (!resolved) {
      return { ok: false, reason: 'missing', message: '文件已删除或不可用' }
    }
    absolutePath = resolved.absolutePath
  } catch (err) {
    const message = errorMessage(err)
    log.warn('解析本地 HTML 产物路径失败', { spaceId, errorMessage: message })
    return { ok: false, reason: 'missing', message }
  }

  const url = buildLocalFileUrl(absolutePath)

  // ：同 file:// 已打开则只聚焦，不新建 view。
  const reused = await focusExistingWebTabInSpaceDetailed(spaceId, url, {
    tabScopeKey: options?.tabScopeKey,
  })
  if (reused.ok) {
    log.info('reused existing local html preview tab', {
      spaceId,
      viewId: reused.viewId,
      crawlspaceId: reused.crawlspaceId,
    })
    return { ok: true }
  }

  try {
    const crawlspace = useCrawlTabStore.getState().ensureScopedCrawlspace(spaceId, storageKey)
    const crawlspaceId = crawlspace.id
    const ipcAdapter = createElectronIpcAdapter(crawlspaceId, spaceId)
    const viewId = `view-${crawlspaceId}-${Date.now()}-${++_viewSeq}`
    const tabKey = `tabweb:${viewId}`

    const created = await ipcAdapter.createView(
      viewId,
      url,
      undefined,
      options?.title,
      undefined,
      { localPreviewRoot: workingDir },
    )
    if (!created) {
      log.warn('createView 失败', { spaceId, url })
      return { ok: false, reason: 'open_failed', message: '无法在内嵌浏览器打开' }
    }

    // 种子随 tab 持久化放行根：重启 / 冷启动恢复重建 view 时传回主进程，
    // 否则恢复出来的 file:// 预览 tab 会被安全门禁拒绝而空白。
    seedManager.ensureSeed(crawlspaceId, {
      viewId,
      url,
      title: options?.title,
      localPreviewRoot: workingDir,
    })

    const result = await activateBrowserView(crawlspaceId, viewId, {
      spaceId,
      selection: { tabScopeKey: storageKey, tabKey },
    })
    if (!result.ok || result.code === 'cancelled') {
      log.warn('activateBrowserView 失败', { spaceId, viewId, result })
      return { ok: false, reason: 'open_failed', message: '无法激活预览标签' }
    }
    return { ok: true }
  } catch (err) {
    const message = errorMessage(err)
    log.warn('打开本地 HTML 标签异常', { spaceId, url, errorMessage: message })
    return { ok: false, reason: 'open_failed', message }
  }
}
