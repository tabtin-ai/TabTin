import type { WebContentsView } from 'electron'
import { BROWSER_VIEW_BORDER_RADIUS_PX } from '@shared/browser-viewport-constraints'

export function applyBrowserViewBorderRadius(view: WebContentsView): void {
  view.setBorderRadius(BROWSER_VIEW_BORDER_RADIUS_PX)
}
