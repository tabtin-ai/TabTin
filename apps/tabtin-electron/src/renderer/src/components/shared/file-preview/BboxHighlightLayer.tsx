/**
 * BboxHighlightLayer — PDF 页面上的 bbox 高亮叠加层
 *
 * 在 PDF Page 上方叠加一个 SVG 层，用于绘制文档引用的 bbox 高亮框。
 * bbox 使用 PDF 点坐标（与页面实际尺寸一致），组件自动根据 scale 缩放。
 */

import React from 'react'
import { ZIndex } from '@tabtin/app-shell'
import { cn } from '@utils/cn'

export interface BboxRect {
  /** 唯一 ID */
  id: string
  /** 左上 x (PDF pt) */
  x0: number
  /** 左上 y (PDF pt) */
  y0: number
  /** 右下 x (PDF pt) */
  x1: number
  /** 右下 y (PDF pt) */
  y1: number
  /** 高亮颜色（默认 blue） */
  color?: string
  /** 引用文本（tooltip） */
  label?: string
}

interface BboxHighlightLayerProps {
  bboxes: BboxRect[]
  pageWidth: number
  pageHeight: number
  scale: number
  onBboxClick?: (bbox: BboxRect) => void
  className?: string
}

export const BboxHighlightLayer: React.FC<BboxHighlightLayerProps> = ({
  bboxes,
  pageWidth,
  pageHeight,
  scale,
  onBboxClick,
  className,
}) => {
  if (!bboxes.length) return null

  const w = pageWidth * scale
  const h = pageHeight * scale

  return (
    <svg
      className={cn('absolute top-0 left-0 pointer-events-none', className)}
      width={w}
      height={h}
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
      style={{ zIndex: ZIndex.sticky }}
    >
      {bboxes.map((bbox) => {
        const color = bbox.color || '#3b82f6'
        return (
          <rect
            key={bbox.id}
            x={bbox.x0}
            y={bbox.y0}
            width={bbox.x1 - bbox.x0}
            height={bbox.y1 - bbox.y0}
            fill={color}
            fillOpacity={0.15}
            stroke={color}
            strokeWidth={1.5}
            strokeOpacity={0.6}
            rx={2}
            className="pointer-events-auto cursor-pointer hover:fill-opacity-25 transition-all"
            onClick={() => onBboxClick?.(bbox)}
          >
            {bbox.label && <title>{bbox.label}</title>}
          </rect>
        )
      })}
    </svg>
  )
}

BboxHighlightLayer.displayName = 'BboxHighlightLayer'
