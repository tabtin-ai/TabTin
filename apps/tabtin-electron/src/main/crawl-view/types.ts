import type { ViewProfile } from '../view-factory/types'
import type { OpenIntentHints } from '../../shared/open-intent'

export type ViewOptions = {
  profile?: ViewProfile
  partition?: string
  crawlspaceId?: string
  spaceId?: string
  kind?: 'workspace-view' | 'normal-view'
  isPreview?: boolean
  allowMultiple?: boolean
  allowPrivateHostNavigation?: boolean
  /** 受限放行 `file://` 的根目录（当前 Space 工作目录）；见 utils.validateNavigationUrl。 */
  localPreviewRoot?: string
  openIntentHints?: OpenIntentHints
}

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'settled'

/**
 * 页面内容就绪度：
 * - settled：基础导航完成后 DOM 在安静窗口内不再变化，视为内容渲染稳定
 * - unsettled_timeout：到达 settle 观察上限时 DOM 仍在持续变化（如轮播/长轮询/数据未就绪）
 */
export type LoadReadiness = 'settled' | 'unsettled_timeout'

export type LoadUrlOptions = {
  waitUntil?: WaitUntil
  timeout?: number
  waitForSelector?: string
  waitForTimeout?: number
  waitForState?: 'attached' | 'visible' | 'hidden'
  allowPrivateHostNavigation?: boolean
  /** 受限放行 `file://` 的根目录（当前 Space 工作目录）；见 utils.validateNavigationUrl。 */
  localPreviewRoot?: string
  /**
   * Preview Guard：为 true 时允许可预览文件直链进入 BrowserView（Agent/crawl）。
   * 默认 false——xlsx/pdf/image 等会被 block。
   */
  forceBrowser?: boolean
  openIntentHints?: OpenIntentHints
}

export type WaitForOptions = {
  selector?: string
  state?: 'attached' | 'visible' | 'hidden'
  timeout?: number
  delay?: number
  pollInterval?: number
}

export type NavigationHistoryEntry = {
  url: string
  title: string
}

export type NavigationState = {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  url: string
  title: string
  history?: NavigationHistoryEntry[]
  activeIndex?: number
}
