import React, { useDeferredValue } from 'react'
import type { Slide, SlideTheme } from '../types/slides'
import SlideRenderer from './SlideRenderer'
import * as t from '../theme'
import { useT } from '../i18n'

interface ThumbnailProps {
  page: Slide
  theme?: SlideTheme
  index: number
  isActive: boolean
  canvasWidth: number
  canvasHeight: number
  thumbWidth: number
  hasRemark?: boolean
  onClick: (index: number) => void
  onRemarkClick?: (index: number) => void
  onDragStart?: (index: number) => void
  onDragOver?: (e: React.DragEvent<HTMLDivElement>, index: number) => void
  onDrop?: (e: React.DragEvent<HTMLDivElement>, index: number) => void
  onDragEnd?: () => void
  dragOverPosition?: 'before' | 'after' | null
  isDragging?: boolean
}

const Thumbnail: React.FC<ThumbnailProps> = ({
  page,
  theme,
  index,
  isActive,
  canvasWidth,
  canvasHeight,
  thumbWidth,
  hasRemark = false,
  onClick,
  onRemarkClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragOverPosition = null,
  isDragging = false,
}) => {
  const translate = useT()
  const scale = thumbWidth / canvasWidth
  const thumbHeight = canvasHeight * scale
  // 当前页缩略图在高频编辑（如拖动透明度/圆角）时会非常频繁地重渲染。
  // 这里对 active 页采用低优先级渲染，避免与主画布争抢交互帧预算。
  const deferredPage = useDeferredValue(page)
  const renderPage = isActive ? deferredPage : page

  return (
    <div
      draggable
      onClick={() => onClick(index)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(index))
        onDragStart?.(index)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        onDragOver?.(e, index)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onDrop?.(e, index)
      }}
      onDragEnd={onDragEnd}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0,
        padding: '2px 3px',
        cursor: 'pointer',
        borderRadius: t.radiusMd,
        background: isActive ? t.bgHover : 'transparent',
        transition: `background ${t.transitionFast}, opacity ${t.transitionFast}`,
        borderLeft: dragOverPosition === 'before' ? `2px solid ${t.accent}` : '2px solid transparent',
        borderRight: dragOverPosition === 'after' ? `2px solid ${t.accent}` : '2px solid transparent',
        opacity: isDragging ? 0 : 1,
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = t.bgHover
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = 'transparent'
      }}
    >
      {/* 缩略图 */}
      <div
        style={{
          width: thumbWidth,
          height: thumbHeight,
          overflow: 'hidden',
          borderRadius: 4,
          border: `1px solid ${isActive ? t.accent : t.borderLight}`,
          flexShrink: 0,
          transition: `border-color ${t.transitionFast}, box-shadow ${t.transitionFast}`,
          boxShadow: isActive
            ? `0 1px 4px rgba(0,0,0,0.08)`
            : '0 1px 2px rgba(0,0,0,0.04)',
          position: 'relative',
        }}
      >
        <SlideRenderer
          page={renderPage}
          theme={theme}
          scale={scale}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          thumbnail
        />
        <span
          style={{
            position: 'absolute',
            left: 3,
            bottom: 3,
            fontSize: 9,
            color: '#fff',
            background: 'rgba(0,0,0,0.55)',
            borderRadius: 3,
            padding: '0 3px',
            lineHeight: '13px',
            userSelect: 'none',
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {index + 1}
        </span>
        {hasRemark && (
          <button
            type="button"
            title={translate('property.remark')}
            aria-label={translate('property.remark')}
            onMouseDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onRemarkClick?.(index)
            }}
            style={{
              position: 'absolute',
              right: 3,
              top: 3,
              width: 16,
              height: 16,
              padding: 0,
              border: 'none',
              borderRadius: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              background: t.accent,
              color: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            }}
          >
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

export default React.memo(Thumbnail)
