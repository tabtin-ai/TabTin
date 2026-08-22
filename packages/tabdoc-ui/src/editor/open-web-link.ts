import type { TabDocOpenWebUrlInput } from '@tabtin/app-host-sdk'

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const closest = (target as { closest?: unknown } | null)?.closest
  if (typeof closest !== 'function') return null
  return closest.call(target, 'a[href]') as HTMLAnchorElement | null
}

export function resolveTabDocWebLinkInput(
  target: EventTarget | null,
): TabDocOpenWebUrlInput | null {
  const anchor = closestAnchor(target)
  if (!anchor) return null

  const url = anchor.getAttribute('href')?.trim() ?? ''
  if (!/^https?:\/\//i.test(url)) return null

  const filename = (
    anchor.getAttribute('download')
    || anchor.getAttribute('title')
    || anchor.textContent
    || ''
  ).trim()

  return {
    url,
    ...(filename ? { openIntentHints: { filename } } : {}),
  }
}
