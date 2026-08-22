import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import type { CrawlTab } from '@stores/useCrawlTabStore'
import { crawlspaceContextClient } from '@/crawlspace/electron/crawlspace-context-client'
import { ensureLegacyOk } from '@/services/legacy-result'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceTabs')

/**
 * 工作区与预览视图的统一工具，避免硬编码前缀和重复清理逻辑
 *
 * ✅ 新模型约定：
 * - Sidebar/ContentArea 的“工作区 Tab”使用 crawlspaceId（UUID）
 * - 工作区内部页面使用 viewId（来自 crawlspace Context 快照）
 */
export class WorkspaceTabHelpers {
  /**
   * 创建预览 View ID（不创建 view 本身）
   */
  static createPreviewViewId(crawlspaceId: string): string {
    return `view-${crawlspaceId}-${Date.now()}`
  }

  /**
   * 查找工作区当前的预览 View（最新的一个）
   */
  static findPreviewViewId(crawlspaceId: string): string | null {
    const store = useCrawlTabStore.getState()
    const previews = store.getCrawlspaceViews(crawlspaceId).filter(v => v.isPreview)
    if (previews.length === 0) return null
    return previews.sort((a, b) => b.createdAt - a.createdAt)[0]?.viewId || null
  }

  /**
   * 清理旧的预览 View，只保留最新的一个
   */
  static async cleanupOldPreviewViews(crawlspaceId: string): Promise<void> {
    const store = useCrawlTabStore.getState()
    const previews = store.getCrawlspaceViews(crawlspaceId).filter(v => v.isPreview)
    if (previews.length <= 1) return

    const sorted = previews.sort((a, b) => b.createdAt - a.createdAt)

    // 保留最新的第一个，其余关闭（销毁 WebContentsView + 从 viewList 移除）
    for (const view of sorted.slice(1)) {
      try {
        const closeRes = await crawlspaceContextClient.closeView(
          crawlspaceId,
          view.viewId,
          'WorkspaceTabHelpers.cleanupOldPreviewViews'
        )
        // contract W2-β: channel 在 LEGACY_HANDLERS 内（preload 透传 raw {success, error?}）。
        // 用 ensureLegacyOk 把 legacy `{success: false}` 主动转 throw —— main 端迁
        // envelope 后 invokeIpc 自身会 throw，本 helper 调用退化为 identity。
        ensureLegacyOk(closeRes, 'closeView')
        log.debug('清理旧预览视图:', view.viewId)
      } catch (err) {
        // fail-soft：清理是后台任务，单条失败不阻断其他视图清理（也不打扰用户）
        log.warn('清理预览视图失败:', view.viewId, err)
      }
    }
  }
}

/**
 * @deprecated 旧命名兼容（preview “tab” 已废弃，实际是 preview “view”）
 */
export const WorkspaceViewHelpers = WorkspaceTabHelpers
