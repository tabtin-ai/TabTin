import React from 'react'
import {
  resolveWidgetPreviewViewportHeight,
  type WidgetPreviewLayout,
} from './widgetPreviewLayout'

interface WidgetPreviewFrameProps {
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  srcDoc: string
  title: string
  scale: number
  layout: WidgetPreviewLayout | null
}

/**
 * show_widget Lightbox 的有限 viewport。
 *
 * - 视口：iframe 铺满 viewer 内容盒；内容按宽度铺满，溢出再纵向滚
 * - 缩放：与 ImageBody / PNG 一致，用 transform: scale。
 *   不要对 iframe 设 CSS zoom——只会放大「视窗盒子」，图本身不变。
 */
export const WidgetPreviewFrame: React.FC<WidgetPreviewFrameProps> = ({
  iframeRef,
  srcDoc,
  title,
  scale,
  layout,
}) => {
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null)

  React.useLayoutEffect(() => {
    const parent = viewportRef.current?.parentElement
    if (!parent) return

    const measure = () => {
      const next = parent.clientHeight
      if (Number.isFinite(next) && next > 0) {
        setAvailableHeight(next)
      }
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const viewportHeight = resolveWidgetPreviewViewportHeight(layout, availableHeight)

  return (
    <div
      ref={viewportRef}
      data-widget-preview-viewport
      className="max-h-full min-h-0 max-w-[min(960px,88vw)] w-full overflow-hidden rounded-lg bg-background transition-transform duration-100"
      style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
      onClick={(event) => event.stopPropagation()}
    >
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="block w-full max-h-full min-h-0 border-0 bg-background"
        style={{ height: `${viewportHeight}px`, minHeight: 0 }}
        title={title}
        referrerPolicy="no-referrer"
        data-preview-scale={scale}
        data-height-capped={layout?.capped ? 'true' : undefined}
        data-available-height={availableHeight ?? undefined}
      />
    </div>
  )
}

WidgetPreviewFrame.displayName = 'WidgetPreviewFrame'
