/**
 * PrefillingRowContainer
 *
 * Overlay container for new record row with prefilling support.
 */
import React, { useRef } from 'react'
import { useClickAway } from 'react-use'
import { Plus } from '../icons/inlineIcons'
import { isGridOverlayTarget } from '../grid/utils/isGridOverlayTarget'

/** Height (px) of the floating header bar — must stay in sync with `h-8` / `top-[-32px]` below */
export const PREFILLING_HEADER_HEIGHT = 32

interface IPrefillingRowContainerProps {
  style?: React.CSSProperties
  children?: React.ReactNode
  showBorder?: boolean
  isLoading?: boolean
  title?: string
  cancelLabel?: string
  onCancel?: () => void
  onClickOutside?: () => void
  /** 排除区域 — 点击此 ref 内部不触发 onClickOutside（通常为网格容器） */
  excludeRef?: React.RefObject<HTMLElement | null>
}

export const PrefillingRowContainer: React.FC<IPrefillingRowContainerProps> = (props) => {
  const {
    style,
    children,
    showBorder = true,
    isLoading,
    title = 'Add row',
    cancelLabel = 'Cancel',
    onCancel,
    onClickOutside,
    excludeRef,
  } = props
  const prefillingGridContainerRef = useRef<HTMLDivElement>(null)

  useClickAway(prefillingGridContainerRef, (event) => {
    const target = event.target as Element | null
    if (excludeRef?.current && target?.closest && excludeRef.current.contains(target)) {
      return
    }
    // 日期编辑器月/年 Select 等 portal 到 body，不能当成点外面关草稿行
    if (isGridOverlayTarget(target)) {
      return
    }
    onClickOutside?.()
  })

  const stopHeaderClickAway = (
    event:
      | React.MouseEvent<HTMLDivElement>
      | React.PointerEvent<HTMLDivElement>
      | React.TouchEvent<HTMLDivElement>
  ) => {
    if (!(event.target instanceof Element && event.target.closest('button'))) {
      event.preventDefault()
    }
    event.stopPropagation()
  }

  return (
    <div
      ref={prefillingGridContainerRef}
      className={`pointer-events-none absolute left-0 z-floating w-full ${showBorder ? 'border-y-2 border-type-webhook' : ''}`}
      style={style}
    >
      <div
        data-grid-overlay="prefilling-row-header"
        data-prefilling-row-header="true"
        className="pointer-events-auto absolute left-0 top-[-32px] flex h-8 items-center rounded-ss-lg bg-type-webhook px-2 py-1 text-background"
        onMouseDown={stopHeaderClickAway}
        onPointerDown={stopHeaderClickAway}
        onTouchStart={stopHeaderClickAway}
      >
        {isLoading ? (
          <svg
            className="mr-1 size-4 shrink-0 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <Plus className="mr-1 size-4 shrink-0" />
        )}
        <span className="whitespace-nowrap text-caption">{title}</span>
        <button
          type="button"
          onClick={() => onCancel?.()}
          className="ml-2 h-5 rounded-sm border border-background/25 bg-background/10 px-2 text-caption text-background transition hover:bg-background/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-background/60"
        >
          {cancelLabel}
        </button>
      </div>
      {children}
    </div>
  )
}
