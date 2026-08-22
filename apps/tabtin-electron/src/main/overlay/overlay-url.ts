import { join } from 'path'

import { app } from 'electron'

const PACKAGED_OVERLAY_URL = 'tabtin-file://app/overlay.html'

export function resolveOverlayRendererUrl(isDev: boolean, rendererUrl?: string): string {
  if (isDev && rendererUrl) {
    try {
      const base = new URL(rendererUrl)
      return `${base.origin}/overlay.html`
    } catch {
      const port = process.env.VITE_DEV_SERVER_PORT || '5173'
      return `http://127.0.0.1:${port}/overlay.html`
    }
  }
  return PACKAGED_OVERLAY_URL
}

/** 子窗口 URL：同一 overlay.html，带 role 区分渲染（modal 半透明蒙层 / toast 透明穿透）。 */
export function resolveOverlayWindowUrl(
  role: 'modal' | 'toast',
  isDev: boolean,
  rendererUrl?: string,
): string {
  return `${resolveOverlayRendererUrl(isDev, rendererUrl)}?role=${role}`
}

export function resolveOverlayPreloadPath(): string {
  return join(app.getAppPath(), 'out/preload/index.cjs')
}
