import * as React from 'react'
import { cn } from '../utils/cn'

type ScrollAreaMode = 'horizontal' | 'vertical' | 'both' | 'none'

type ScrollAreaProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'type'> & {
  scrollBar?: ScrollAreaMode
  viewportRef?: React.Ref<HTMLDivElement>
  type?: 'auto' | 'always' | 'scroll' | 'hover'
}

const setRef = <T,>(ref: React.Ref<T> | undefined, value: T | null) => {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  ;(ref as React.MutableRefObject<T | null>).current = value
}

const getOverflowClass = (scrollBar: ScrollAreaMode) => {
  switch (scrollBar) {
    case 'horizontal':
      return 'overflow-x-auto overflow-y-hidden'
    case 'both':
      return 'overflow-auto'
    case 'none':
      return 'overflow-hidden'
    case 'vertical':
    default:
      return 'overflow-y-auto overflow-x-hidden'
  }
}

const getScrollbarVisibilityClass = (type: ScrollAreaProps['type']) => {
  switch (type) {
    case 'always':
      return 'scrollbar-thin'
    case 'hover':
    case 'scroll':
      return 'scrollbar-hover'
    case 'auto':
    default:
      return null
  }
}

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, scrollBar = 'vertical', viewportRef, type, ...props }, ref) => {
    const mergedRef = React.useCallback((node: HTMLDivElement | null) => {
      setRef(ref, node)
      setRef(viewportRef, node)
    }, [ref, viewportRef])

    return (
      <div
        ref={mergedRef}
        className={cn(
          'relative min-h-0 rounded-[inherit]',
          getOverflowClass(scrollBar),
          getScrollbarVisibilityClass(type),
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  },
)
ScrollArea.displayName = 'ScrollArea'

type ScrollBarProps = React.HTMLAttributes<HTMLDivElement> & {
  orientation?: 'horizontal' | 'vertical'
}

const ScrollBar = React.forwardRef<HTMLDivElement, ScrollBarProps>(
  ({ className, orientation = 'vertical', ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn('hidden', orientation === 'horizontal' ? 'h-1.5' : 'w-1.5', className)}
      {...props}
    />
  ),
)
ScrollBar.displayName = 'ScrollBar'

export { ScrollArea, ScrollBar }
