/**
 * Compatibility helpers for direct file URL detection.
 *
 * Implementation delegates to shared `resolveOpenIntent` so main/renderer share
 * one Open Intent SSoT. Callers that only need a boolean keep using these APIs.
 */

import { isDirectOpenIntentUrl, resolveOpenIntent } from './open-intent'

export function isLegacyDirectPreviewUrl(url: string): boolean {
  return isDirectOpenIntentUrl(url)
}

/**
 * True when `url` is a direct https/blob/data file that should open in Preview
 * Modal (xlsx/xls/csv/pdf/image/…), not BrowserView.
 */
export function isPreviewableDirectFileUrl(raw: string): boolean {
  return resolveOpenIntent({ url: raw }).kind === 'preview'
}
