import { type CSSProperties, type RefObject, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useBrowserTabLockStore } from '@stores/useBrowserTabLockStore'
import { isWebviewContainerEnabled } from '@/utils/browserContainerMode'
import {
  beginCrawlViewMousePassthrough,
  endCrawlViewMousePassthrough,
} from '@/crawlspace/crawl-view-mouse-passthrough-depth'
import { usePortalPaneRect } from './usePortalPaneRect'

interface AgentBrowserLockOverlayProps {
  paneRef: RefObject<HTMLElement | null>
  viewId: string
  isActive: boolean
}

/**
 * 中间要看网页，不能铺实底；把流光裁成一圈，网页从挖空处露出来。
 * `black` 是 mask 的不透明通道，不是产品色。
 */
const RING_MASK_STYLE: CSSProperties = {
  padding: 5,
  WebkitMask: 'linear-gradient(black 0 0) content-box, linear-gradient(black 0 0)',
  WebkitMaskComposite: 'xor',
  mask: 'linear-gradient(black 0 0) content-box, linear-gradient(black 0 0)',
  maskComposite: 'exclude',
}

export function AgentBrowserLockOverlay({
  paneRef,
  viewId,
  isActive,
}: AgentBrowserLockOverlayProps) {
  const { t } = useTranslation('crawl')
  const isLocked = useBrowserTabLockStore((state) => state.isLocked(viewId))
  const shouldRender = isWebviewContainerEnabled() && isActive && isLocked
  const paneRect = usePortalPaneRect(paneRef, shouldRender)

  useEffect(() => {
    if (!shouldRender) return
    beginCrawlViewMousePassthrough()
    return endCrawlViewMousePassthrough
  }, [shouldRender])

  if (!shouldRender || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="pointer-events-auto fixed z-overlay overflow-hidden"
      style={paneRect}
      role="status"
      aria-label={t('embedded.agentControlStatus')}
      data-testid="agent-browser-lock-overlay"
    >
      <div
        data-testid="agent-browser-lock-overlay-glow"
        className="agent-lock-steam pointer-events-none absolute inset-0"
        style={RING_MASK_STYLE}
        aria-hidden
      />
      <div
        data-testid="agent-browser-lock-overlay-fill"
        className="pointer-events-none absolute inset-[5px] bg-primary/5"
      />
    </div>,
    document.body,
  )
}
