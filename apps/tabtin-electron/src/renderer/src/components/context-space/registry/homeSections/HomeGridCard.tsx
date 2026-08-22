/**
 * HomeGridCard — 宫格视图的通用卡片组件。
 *
 * 封面预览分四层优先级：
 *   1. thumbnailUrl  — 图片封面
 *   2. coverContent  — 结构化视觉预览（迷你表格、节点图等）
 *   3. previewText   — 文本内容预览
 *   4. icon + 类型装饰 — 富 fallback
 */
import React, { useState } from 'react'
import { GRID_CARD_TEXT_MAX_CHARS } from '../../constants'
import { Pin } from 'lucide-react'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { getMemoTokenGradient } from './memoColorTokens'

export type HomeViewMode = 'list' | 'grid'

// ---------------------------------------------------------------------------
// Type → decoration gradient (Tailwind class)
// ---------------------------------------------------------------------------

const TYPE_DECORATION_GRADIENT = 'from-background/60 to-foreground/[0.045] dark:from-background/25 dark:to-foreground/[0.07]'

export function getTypeGradient(_type: string): string {
  return TYPE_DECORATION_GRADIENT
}

export function getMemoColorGradient(color: string): string {
  return getMemoTokenGradient(color, TYPE_DECORATION_GRADIENT)
}

// ---------------------------------------------------------------------------
// HomeGridCard
// ---------------------------------------------------------------------------

export interface HomeGridCardProps {
  gradient?: string
  gradientStyle?: React.CSSProperties
  thumbnailUrl?: string | null
  coverContent?: React.ReactNode
  previewText?: string | null
  icon?: React.ReactNode
  typeLabel?: string | null
  title: string
  subtitle?: React.ReactNode
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  isPinned?: boolean
  isDisabled?: boolean
  busyLabel?: string
  className?: string
}

export const HomeGridCard: React.FC<HomeGridCardProps> = ({
  gradient = TYPE_DECORATION_GRADIENT,
  gradientStyle,
  thumbnailUrl,
  coverContent,
  previewText,
  icon,
  typeLabel,
  title,
  subtitle,
  onClick,
  onContextMenu,
  isPinned,
  isDisabled = false,
  busyLabel,
  className,
}) => {
  const [imgError, setImgError] = useState(false)
  const showImage = !!thumbnailUrl && !imgError
  const showCover = !showImage && !!coverContent
  const showText = !showImage && !showCover && !!previewText?.trim()

  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-busy={Boolean(busyLabel)}
      className={cn(
        'surface-glass group relative flex min-w-0 w-full flex-col overflow-hidden rounded-[12px] text-left transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
        isPinned && 'ring-1 ring-foreground/[0.08] dark:ring-foreground/[0.1]',
        isDisabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
        className,
      )}
      onClick={isDisabled ? undefined : onClick}
      onContextMenu={isDisabled ? undefined : onContextMenu}
    >
      <div className="resource-card-theme-glow" aria-hidden="true" />

      {busyLabel && (
        <div className="absolute inset-0 z-sticky flex items-center justify-center bg-background/80">
          <div className={cn('flex', 'items-center', 'gap-1.5', 'rounded-full', 'bg-background/95', 'px-2', 'py-1', CANVAS_TEXT_META)}>
            <span className="h-3 w-3 rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground/80 animate-spin" />
            <span>{busyLabel}</span>
          </div>
        </div>
      )}
      {/* ── 封面区域 ── */}
      <div
        className={cn(
          "relative h-16 w-full overflow-hidden bg-gradient-to-br",
          gradient,
        )}
        style={gradientStyle}
      >
        {isPinned && (
          <div className="absolute right-1.5 top-1.5 z-sticky rounded-full bg-foreground/[0.08] p-0.5 text-primary-text dark:bg-foreground/[0.12]">
            <Pin className="h-3 w-3" />
          </div>
        )}
        {showImage && (
          <img
            src={thumbnailUrl!}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        )}

        {showCover && coverContent}

        {showText && (
          <div className="absolute inset-0 flex min-w-0 flex-col overflow-hidden px-2 pt-1.5 pb-1">
            <p className={cn('whitespace-pre-wrap', 'break-all', 'text-foreground/60', 'dark:text-foreground/60', 'line-clamp-4', 'leading-snug', CANVAS_TEXT_META)}>
              {previewText!.slice(0, GRID_CARD_TEXT_MAX_CHARS)}
            </p>
          </div>
        )}

        {!showImage && !showCover && !showText && (
          <div className="flex h-full flex-col items-center justify-center gap-0.5">
            {icon && (
              <span
                className="text-title leading-none opacity-60 transition-opacity duration-300 group-hover:opacity-80"
              >
                {icon}
              </span>
            )}
            {typeLabel && (
              <span className={cn('font-medium', 'text-foreground/30', 'dark:text-foreground/25', CANVAS_TEXT_META_BASE)}>
                {typeLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── 信息区域 ── */}
      <div className="flex min-h-[36px] min-w-0 flex-1 flex-col gap-0.5 px-3 py-1.5">
        <span className="block min-w-0 truncate text-body font-medium leading-snug text-foreground/80">{title}</span>
        {subtitle && (
          <div className={cn('flex', 'h-4', 'min-w-0', 'flex-nowrap', 'items-center', 'gap-1', 'overflow-hidden', 'text-muted-foreground/60', CANVAS_TEXT_META)}>
            {subtitle}
          </div>
        )}
      </div>
    </button>
  )
}
