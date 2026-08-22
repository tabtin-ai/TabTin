import React, { useMemo } from 'react'
import type { Slide, SlideTheme } from '../types/slides'
import ElementRenderer from './elements/ElementRenderer'
import { getBackgroundCssValue } from '../utils/background'
import * as t from '../theme'

interface SlideRendererProps {
  page: Slide
  theme?: SlideTheme
  scale?: number
  canvasWidth: number
  canvasHeight: number
  showGrid?: boolean
  gridSize?: number
  thumbnail?: boolean
  editingElementId?: string | null
  onStartEdit?: (id: string) => void
}

const SlideRenderer: React.FC<SlideRendererProps> = ({
  page,
  theme,
  scale = 1,
  canvasWidth,
  canvasHeight,
  showGrid = false,
  gridSize = 10,
  thumbnail = false,
  editingElementId,
  onStartEdit,
}) => {
  const bgStyle = useMemo(
    () => ({ background: getBackgroundCssValue(page.background, theme) }),
    [page.background, theme],
  )
  const masterElements = useMemo(
    () => (page.masterElements || []).filter((el) => el.visible !== false),
    [page.masterElements],
  )
  const safeGridSize = Number.isFinite(gridSize) && gridSize > 0 ? Math.round(gridSize) : 10
  const isMainCanvas = !thumbnail

  return (
    <div
      style={{
        position: 'relative',
        width: canvasWidth,
        height: canvasHeight,
        transform: scale !== 1 ? `scale(${scale})` : undefined,
        transformOrigin: 'top left',
        overflow: 'hidden',
        border: `1px solid ${isMainCanvas ? t.border : t.borderLight}`,
        borderRadius: isMainCanvas ? 12 : 4,
        boxShadow: isMainCanvas ? t.shadowCanvas : 'none',
        ...bgStyle,
      }}
    >
      {showGrid && !thumbnail && (
        <div
          data-testid="tabslide-grid-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `
              linear-gradient(to right, ${t.borderLight} 1px, transparent 1px),
              linear-gradient(to bottom, ${t.borderLight} 1px, transparent 1px)
            `,
            backgroundSize: `${safeGridSize}px ${safeGridSize}px`,
            zIndex: 0,
          }}
        />
      )}
      {masterElements.map((el, idx) => (
        <ElementRenderer
          key={`master-${el.id}`}
          element={el}
          zIndex={idx + 1}
          thumbnail
        />
      ))}
      {page.elements
        .filter((el) => el.visible !== false)
        .map((el, idx) => (
          <ElementRenderer
            key={el.id}
            element={el}
            zIndex={masterElements.length + idx + 1}
            thumbnail={thumbnail}
            editingElementId={editingElementId}
            onStartEdit={onStartEdit}
          />
        ))}
    </div>
  )
}

export default React.memo(SlideRenderer)
