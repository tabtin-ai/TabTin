/**
 * BrowserPrimitives — 浏览器驱动端口（Port）
 *
 * platform-reach 是 electron-free 纯包：适配器只依赖这个端口，不碰 CDP、不 import
 * Electron。宿主（`action-tools` 里的 route impl）把端口接到 `browser-core` 的
 * `handleBrowserAction`——Electron 用 WebContentsView+CDP、Daemon 用 Patchright，
 * 两端各自实现同一端口，适配器一份代码两端跑。
 *
 * 这与 browser-core 自身「orchestration 收 hostHooks、纯逻辑可单测」是同一套
 * 依赖倒置：把「最后一公里执行引擎」注入进来，核心逻辑保持可测、无副作用依赖。
 *
 * 端口只暴露适配器真正需要的最小动作集；要更多能力时在这里显式加，别让适配器
 * 绕过端口直接拿 webContents。
 */

export interface OpenInput {
  url: string
  /** 复用已有 tab（同域续会话，保留登录态）；不传则由宿主决定新开还是复用前台。 */
  tabId?: string
  /** 等待到某选择器 / 文本出现再返回。 */
  waitForSelector?: string
  timeoutMs?: number
}

export interface OpenResult {
  tabId: string
  url: string
  title?: string
}

export interface NetworkCaptureEntry {
  url: string
  method: string
  status?: number
  /** 响应体文本（JSON 平台在这拿结构化数据）。宿主可对超大 body 截断。 */
  responseBody?: string
  contentType?: string
}

export interface CaptureNetworkInput {
  tabId: string
  /** 只保留 URL 匹配该子串 / 正则源的请求。 */
  urlPattern?: string
  timeoutMs?: number
  /**
   * 响应体还需包含该子串才算「就绪」。
   * 用于 SSE/流式接口：过早拿到半截 body 时继续等（如问财 stream-query 要等 subjects）。
   */
  bodyIncludes?: string
}

export interface WaitForInput {
  tabId: string
  selector?: string
  text?: string
  timeoutMs?: number
}

/**
 * 适配器可用的浏览器动作。只声明已接线的最小集；要 glance/act/print 时再显式加。
 */
export interface BrowserPrimitives {
  open(input: OpenInput): Promise<OpenResult>
  /** 抓取页面发出的网络请求/响应（JSON 平台的主力取数手段）。 */
  captureNetwork(input: CaptureNetworkInput): Promise<NetworkCaptureEntry[]>
  /** 在页面上下文求值（读 hydrated store / 探登录指示元素）。 */
  eval(input: { tabId: string; expression: string }): Promise<unknown>
  waitFor(input: WaitForInput): Promise<void>
}
