/**
 * browserContainerMode — renderer 侧浏览器容器 flag 薄读取器
 *
 * 判定权威在主进程（TABTIN_BROWSER_CONTAINER env），经 preload 以只读值
 * 暴露在 `window.tabtin.browserContainer.mode`。renderer 一律经本函数读取，
 * 不允许散落 `window.tabtin.browserContainer` 直接访问。
 *
 * 缺省（preload 未注入 / 测试环境 / 旧版本 preload）一律回落 'wcv'，
 * 保证 flag 关闭时现状行为零变化。
 */

export type BrowserContainerMode = 'wcv' | 'webview'

export function getBrowserContainerMode(): BrowserContainerMode {
  if (typeof window === 'undefined') return 'wcv'
  const mode = (window as unknown as { tabtin?: { browserContainer?: { mode?: string } } })
    .tabtin?.browserContainer?.mode
  return mode === 'webview' ? 'webview' : 'wcv'
}

export function isWebviewContainerEnabled(): boolean {
  return getBrowserContainerMode() === 'webview'
}
