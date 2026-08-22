/**
 * useBrowserActions — 浏览器标签的操作 handler（后退/前进/搜索/缩放/聚焦地址栏）
 *
 * 通过 handler.hasBrowserActions 判断是否执行，无硬编码类型检查。
 *
 * **zoom 路径（Wave 6.2 自修）**：直接调 module-level `adjustBrowserZoom`，
 * 不再走 `window.dispatchEvent('browser:zoom')` → CrawlspaceWorkspace useEffect
 * 监听的中转——后者在 canvas mode 下随内层 Activity hidden 一起 cleanup，
 * 会让用户分屏时 Cmd+/Cmd- 失灵。详见 `services/browserZoomController.ts`。
 */
import { useCallback } from 'react'
import type { ContextItem } from '../registry/types'
import { contextRegistry } from '../registry'
import { adjustBrowserZoom } from '@/services/browserZoomController'
import { requestGridSearch } from '@tabtin/table-ui'
import { requestTabDocFind } from '@tabtin/tabdoc-ui/find-request'

export function useBrowserActions() {
  const isBrowser = (item: ContextItem) =>
    Boolean(contextRegistry.getHandler(item.type)?.hasBrowserActions)

  const handleBackItem = useCallback((item: ContextItem) => {
    if (isBrowser(item)) void window.tabtin?.crawlView?.goBack(item.id)
  }, [])

  const handleForwardItem = useCallback((item: ContextItem) => {
    if (isBrowser(item)) void window.tabtin?.crawlView?.goForward(item.id)
  }, [])

  const handleFindItem = useCallback((item: ContextItem) => {
    if (isBrowser(item)) {
      window.dispatchEvent(new CustomEvent('browser:find-toggle', { detail: { viewId: item.id } }))
      return
    }
    if (item.type === 'tabdata') {
      requestGridSearch(item.id)
      return
    }
    if (item.type === 'tabdoc') {
      requestTabDocFind(item.id)
    }
  }, [])

  const handleZoomItem = useCallback((item: ContextItem, direction: 'in' | 'out' | 'reset') => {
    if (isBrowser(item)) {
      adjustBrowserZoom(item.id, direction)
    }
  }, [])

  const handleFocusUrl = useCallback(() => {
    window.dispatchEvent(new CustomEvent('browser:focus-url'))
  }, [])

  return {
    handleBackItem,
    handleForwardItem,
    handleFindItem,
    handleZoomItem,
    handleFocusUrl,
  }
}
