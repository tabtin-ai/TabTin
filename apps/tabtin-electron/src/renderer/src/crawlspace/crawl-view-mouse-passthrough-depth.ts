/**
 * 嵌入浏览器容器会截获鼠标事件，两种容器机制不同、这里统一收口：
 * - WCV：原生层叠在主窗口 HTML 之上 → 主进程 setIgnoreMouseEventsForAttached
 * - <webview>（, flag=webview）：guest 独立收事件，宿主 document 收不到
 *   mousemove/mouseup（拖拽一进 webview 区域就冻住）→ 渲染侧 pointer-events:none
 * 多处逻辑（画布 tab 拖拽、chat rail 分隔条拖拽等）需要临时穿透。
 * 使用引用计数避免 canvas 拖拽与 chat rail 拖拽嵌套时互相提前关闭 passthrough。
 */

import { crawlViewClient } from '@/crawlspace/electron/crawl-view-client'
import { isWebviewContainerEnabled } from '@/utils/browserContainerMode'
import { getWebviewManager } from '@/crawlspace/webview-manager/WebviewManager'

let depth = 0

function hasPassthroughApi(): boolean {
  return Boolean(
    typeof window !== 'undefined' && window.tabtin?.crawlView?.setIgnoreMouseEventsForAttached,
  )
}

function applyPassthrough(enabled: boolean): void {
  if (isWebviewContainerEnabled()) {
    getWebviewManager().setMousePassthrough(enabled)
    return
  }
  if (!hasPassthroughApi()) return
  crawlViewClient.setIgnoreMouseEventsForAttached(enabled).catch(() => {})
}

export function beginCrawlViewMousePassthrough(): void {
  depth += 1
  if (depth === 1) {
    applyPassthrough(true)
  }
}

export function endCrawlViewMousePassthrough(): void {
  if (depth <= 0) return
  depth -= 1
  if (depth !== 0) return
  applyPassthrough(false)
}

/** 仅单测 / 极端恢复用 */
export function resetCrawlViewMousePassthroughDepthForTests(): void {
  depth = 0
}
