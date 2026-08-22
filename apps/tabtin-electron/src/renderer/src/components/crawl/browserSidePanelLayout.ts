/**
 * browserSidePanelLayout — 资源中心 / Tins / 地址栏建议的布局与容器降级判定
 *
 * 背景（ 双容器契约 + WebviewManager 稳定层）：
 * - `webview` 容器：`<webview>` 挂在 body 直属稳定层（z-index=10，见
 *   WebviewManager.ensureLayer）。crawl 槽内部的 absolute/z-floating 浮层
 *   **盖不住**这层——必须 portal 到 body，并用 z-modal(50) 压过。
 * - `wcv` 容器：`WebContentsView` 是原生合成层，DOM 浮层一律盖不住，
 *   只能显式 hide，浮层关闭后再 show。
 *
 * 本文件收口：侧栏 class / portal 几何 / 是否因浮层 hide 原生视图。
 */

export type SidePanelKind = 'resource' | 'tins'
export type BrowserContainerModeForLayout = 'webview' | 'wcv'

export type RectLike = {
  left: number
  top: number
  width: number
  height: number
}

export function shouldHideWebviewForSidePanel(args: {
  panel: SidePanelKind | null
  resourceViewMode: 'narrow' | 'wide'
  containerMode: BrowserContainerModeForLayout
}): boolean {
  // webview 下靠 portal + z-modal 盖住，永不隐藏真实网页。
  if (args.containerMode !== 'wcv') return false
  return args.panel != null
}

export function shouldHideWebviewForAddressSuggestions(args: {
  visible: boolean
  containerMode: BrowserContainerModeForLayout
}): boolean {
  if (args.containerMode !== 'wcv') return false
  return args.visible
}

/** 侧栏 portal 到 body 后的定位 class（几何由 getBrowserSidePanelPortalStyle 提供）。 */
export function getBrowserSidePanelPositionClassName(args: {
  panel: SidePanelKind
  resourceViewMode: 'narrow' | 'wide'
}): string {
  const wide = args.panel === 'resource' && args.resourceViewMode === 'wide'
  return [
    // fixed + z-modal：必须高于 WebviewManager 稳定层（z=10），否则仍被网页盖住
    'fixed z-modal min-h-0 overflow-hidden border-l border-border bg-background',
    wide ? 'border-l-0' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export function getBrowserSidePanelPortalStyle(args: {
  contentRect: RectLike
  panel: SidePanelKind
  resourceViewMode: 'narrow' | 'wide'
  resourcePanelWidth: number
}): {
  top: number
  left: number
  width: number
  height: number
} {
  const { contentRect, panel, resourceViewMode, resourcePanelWidth } = args
  const wide = panel === 'resource' && resourceViewMode === 'wide'
  if (wide) {
    return {
      top: contentRect.top,
      left: contentRect.left,
      width: Math.max(0, contentRect.width),
      height: Math.max(0, contentRect.height),
    }
  }
  const width =
    panel === 'tins'
      ? Math.min(360, Math.max(0, contentRect.width * 0.45))
      : Math.min(resourcePanelWidth, Math.max(0, contentRect.width))
  return {
    top: contentRect.top,
    left: contentRect.left + Math.max(0, contentRect.width - width),
    width,
    height: Math.max(0, contentRect.height),
  }
}

export function getAddressBarSuggestionsPortalStyle(toolbarRect: RectLike): {
  top: number
  left: number
  width: number
} {
  return {
    top: toolbarRect.top + toolbarRect.height,
    left: toolbarRect.left,
    width: Math.max(0, toolbarRect.width),
  }
}
