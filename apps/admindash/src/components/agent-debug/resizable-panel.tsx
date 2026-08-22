import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'

interface ResizablePanelProps {
  leftPanel: ReactNode
  rightPanel: ReactNode
  defaultLeftWidth?: number
  minLeftWidth?: number
  maxLeftWidth?: number
  stackBelowXl?: boolean
  resizeHandleLabel?: string
  disabled?: boolean
}

export function ResizablePanel({
  leftPanel,
  rightPanel,
  defaultLeftWidth = 30,
  minLeftWidth = 20,
  maxLeftWidth = 50,
  stackBelowXl = false,
  resizeHandleLabel = '调整左右面板宽度',
  disabled = false,
}: ResizablePanelProps) {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isDragging || disabled) return

    const handlePointerMove = (event: PointerEvent) => {
      if (!containerRef.current) return

      const containerRect = containerRef.current.getBoundingClientRect()
      const nextWidth = ((event.clientX - containerRect.left) / containerRect.width) * 100
      setLeftWidth(Math.max(minLeftWidth, Math.min(maxLeftWidth, nextWidth)))
    }

    const handlePointerUp = () => setIsDragging(false)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [disabled, isDragging, maxLeftWidth, minLeftWidth])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = leftWidth - 2
    if (event.key === 'ArrowRight') nextWidth = leftWidth + 2
    if (event.key === 'Home') nextWidth = minLeftWidth
    if (event.key === 'End') nextWidth = maxLeftWidth
    if (nextWidth === null) return

    event.preventDefault()
    setLeftWidth(Math.max(minLeftWidth, Math.min(maxLeftWidth, nextWidth)))
  }

  const responsiveWidthStyle = stackBelowXl
    ? ({ '--resizable-left-width': `${leftWidth}%` } as CSSProperties)
    : undefined

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 w-full ${stackBelowXl ? 'flex-col xl:flex-row' : ''}`}
      style={responsiveWidthStyle}
    >
      <div
        style={stackBelowXl ? undefined : { width: `${leftWidth}%` }}
        className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-border ${
          stackBelowXl
            ? disabled
              ? 'h-full w-full xl:w-[var(--resizable-left-width)]'
              : 'h-[45%] w-full border-b xl:h-full xl:w-[var(--resizable-left-width)] xl:border-b-0 xl:border-r'
            : 'border-r'
        }`}
      >
        {leftPanel}
      </div>

      <hr
        tabIndex={disabled ? -1 : 0}
        aria-label={resizeHandleLabel}
        aria-orientation="vertical"
        aria-valuemin={minLeftWidth}
        aria-valuemax={maxLeftWidth}
        aria-valuenow={Math.round(leftWidth)}
        className={`relative m-0 h-full w-2 shrink-0 self-stretch cursor-col-resize border-0 bg-transparent transition-colors before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
          stackBelowXl ? 'hidden xl:block' : ''
        } ${disabled ? 'hidden xl:hidden' : ''} ${
          isDragging ? 'before:bg-primary/80' : 'before:bg-border hover:before:bg-primary/50'
        }`}
        onPointerDown={(event) => {
          if (disabled) return
          event.preventDefault()
          setIsDragging(true)
        }}
        onDoubleClick={() => setLeftWidth(defaultLeftWidth)}
        onKeyDown={handleKeyDown}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{rightPanel}</div>
    </div>
  )
}
