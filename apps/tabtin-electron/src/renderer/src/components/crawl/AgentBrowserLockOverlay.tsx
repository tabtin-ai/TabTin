import { type CSSProperties, type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'
import { useBrowserTabLockStore } from '@stores/useBrowserTabLockStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { isWebviewContainerEnabled } from '@/utils/browserContainerMode'
import {
  beginCrawlViewMousePassthrough,
  endCrawlViewMousePassthrough,
} from '@/crawlspace/crawl-view-mouse-passthrough-depth'

interface AgentBrowserLockOverlayProps {
  paneRef: RefObject<HTMLElement | null>
  viewId: string
  isActive: boolean
  spaceId: string | null
}

interface PaneRect {
  top: number
  left: number
  width: number
  height: number
}

const EMPTY_RECT: PaneRect = { top: 0, left: 0, width: 0, height: 0 }

/**
 * 中间要看网页，不能铺实底；把流光裁成一圈，网页从挖空处露出来。
 */
const RING_MASK_STYLE: CSSProperties = {
  padding: 5,
  WebkitMask: 'linear-gradient( 0 0) content-box, linear-gradient( 0 0)',
  WebkitMaskComposite: 'xor',
  mask: 'linear-gradient( 0 0) content-box, linear-gradient( 0 0)',
  maskComposite: 'exclude',
}

const getPaneRect = (pane: HTMLElement | null): PaneRect => {
  if (!pane) return EMPTY_RECT

  const { top, left, width, height } = pane.getBoundingClientRect()
  return { top, left, width, height }
}

function resolveForegroundSessionTitle(
  spaceId: string | null,
  currentSessionIdBySpaceId: Record<string, string | null>,
  sessions: Array<{ id: string; title: string }>,
  sessionsBySpaceId: Record<string, Array<{ id: string; title: string }>>,
): string | null {
  if (!spaceId) return null
  const sessionId = currentSessionIdBySpaceId[spaceId]
  if (!sessionId) return null
  const session =
    sessions.find((item) => item.id === sessionId)
    ?? sessionsBySpaceId[spaceId]?.find((item) => item.id === sessionId)
  const title = session?.title?.trim()
  return title || null
}

export function AgentBrowserLockOverlay({
  paneRef,
  viewId,
  isActive,
  spaceId,
}: AgentBrowserLockOverlayProps) {
  const { t } = useTranslation('crawl')
  const isLocked = useBrowserTabLockStore((state) => state.isLocked(viewId))
  const sessionTitle = useChatStore((state) =>
    resolveForegroundSessionTitle(
      spaceId,
      state.currentSessionIdBySpaceId,
      state.sessions,
      state.sessionsBySpaceId,
    ),
  )
  const untitled = t('embedded.agentLockUntitled', '新任务')
  const statusCopy = t('embedded.agentLockOverlay', 'Agent 正在控制')
  const displayTitle = sessionTitle ?? untitled
  const shouldRender = isWebviewContainerEnabled() && isActive && isLocked
  const [paneRect, setPaneRect] = useState<PaneRect>(EMPTY_RECT)
  const updatePaneRect = useCallback(() => {
    const nextRect = getPaneRect(paneRef.current)
    if (nextRect.width <= 0 || nextRect.height <= 0) return
    setPaneRect(nextRect)
  }, [paneRef])

  useLayoutEffect(() => {
    if (!shouldRender) return

    let cancelled = false
    let rafId = 0
    let observer: ResizeObserver | undefined

    const observePane = (pane: HTMLElement) => {
      if (typeof ResizeObserver === 'undefined') return
      // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 锁膜在 Activity 外，必须自己跟随面板尺寸。
      observer = new ResizeObserver(updatePaneRect)
      observer.observe(pane)
    }

    const measureUntilReady = () => {
      if (cancelled) return
      const pane = paneRef.current
      const nextRect = getPaneRect(pane)
      if (nextRect.width > 0 && nextRect.height > 0) {
        setPaneRect(nextRect)
        if (pane) observePane(pane)
        return
      }
      rafId = requestAnimationFrame(measureUntilReady)
    }

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 锁膜在 Activity 外，必须自己跟随窗口尺寸。
    window.addEventListener('resize', updatePaneRect)
    measureUntilReady()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updatePaneRect)
      observer?.disconnect()
    }
  }, [paneRef, shouldRender, updatePaneRect])

  useEffect(() => {
    if (!shouldRender) return

    beginCrawlViewMousePassthrough()
    return endCrawlViewMousePassthrough
  }, [shouldRender])

  if (!shouldRender || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="pointer-events-auto fixed z-modal overflow-hidden"
      style={paneRect}
      role="status"
      aria-label={`${displayTitle}，${statusCopy}`}
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
      <div
        data-testid="agent-browser-lock-banner"
        className="pointer-events-none absolute bottom-6 left-1/2 z-10 flex max-w-[min(90%,28rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 text-sm shadow-sm backdrop-blur-md"
        aria-hidden
      >
        <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span
          data-testid="agent-browser-lock-banner-title"
          className="min-w-0 truncate text-foreground"
        >
          {displayTitle}
        </span>
        <span
          data-testid="agent-browser-lock-banner-status"
          className="shrink-0 text-primary"
        >
          {statusCopy}
        </span>
      </div>
    </div>,
    document.body,
  )
}
