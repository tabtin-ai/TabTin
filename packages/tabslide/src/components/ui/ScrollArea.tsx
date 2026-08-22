/**
 * TabSlide ScrollArea — 滚动条显隐封装。
 *
 * 项目中统一的「hover 才显示滚动条」方案有三套，各有适用场景：
 *
 * ① 本组件（tabslide ScrollArea）— native=true 模式
 *    运行时注入 CSS，WebKit 用 ::-webkit-scrollbar-thumb 颜色透明/切换，
 *    Firefox 用 scrollbar-color 透明/切换。适合 tabslide 内嵌于各种宿主的场景。
 *
 * ② CSS utility 类 `scrollbar-hover`（tabvideo / Electron / tabtin-web）
 *    由 tabvideo globals.css @utility 或 tailwind-preset 插件生成，
 *    直接 className="scrollbar-hover overflow-auto" 即可，无运行时开销。
 *    tabvideo 的 <ScrollArea variant="hover"> 即使用此方案。
 *
 * ③ 特殊场景（勿改）
 *    - 表格引擎 canvas：.tt-grid-scrollbar + data-scrolling JS 属性控制
 *    - Monaco 编辑器：.tabcode-editor .editor-scrollable opacity CSS 覆盖
 *
 * native=false 模式：使用 Radix ScrollArea type="hover"，带 scrollHideDelay 动画。
 */
import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import * as t from '../../theme'

export type ScrollBarDirection = 'horizontal' | 'vertical' | 'both' | 'none'
export const NATIVE_HOVER_SCROLLBAR_CLASS = 'tabslide-native-hover-scrollbar'

const NATIVE_SCROLL_STYLE_ID = 'tabslide-native-hover-scrollbar-style'

interface ScrollAreaProps
  extends Omit<React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>, 'type'> {
  scrollBar?: ScrollBarDirection
  native?: boolean
  viewportRef?: React.Ref<HTMLDivElement>
  viewportStyle?: React.CSSProperties
  viewportProps?: Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'>
}

const DEFAULT_THUMB_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  borderRadius: 9999,
  background: t.border,
}

const assignRef = <T,>(ref: React.Ref<T> | undefined, value: T | null): void => {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value as T)
    return
  }
  ;(ref as React.MutableRefObject<T | null>).current = value
}

const ensureNativeHoverScrollbarStyles = (): void => {
  if (typeof document === 'undefined') return
  if (document.getElementById(NATIVE_SCROLL_STYLE_ID)) return

  const style = document.createElement('style')
  style.id = NATIVE_SCROLL_STYLE_ID
  style.textContent = `
    .${NATIVE_HOVER_SCROLLBAR_CLASS} {
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
    }
    .${NATIVE_HOVER_SCROLLBAR_CLASS}:hover {
      scrollbar-color: ${t.border} transparent;
    }
    .${NATIVE_HOVER_SCROLLBAR_CLASS}::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    .${NATIVE_HOVER_SCROLLBAR_CLASS}::-webkit-scrollbar-track {
      background: transparent;
    }
    .${NATIVE_HOVER_SCROLLBAR_CLASS}::-webkit-scrollbar-thumb {
      background-color: transparent;
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .${NATIVE_HOVER_SCROLLBAR_CLASS}:hover::-webkit-scrollbar-thumb {
      background-color: ${t.border};
    }
  `
  document.head.appendChild(style)
}

const mergeClassName = (...names: Array<string | undefined>): string | undefined => {
  const resolved = names.filter(Boolean).join(' ')
  return resolved || undefined
}

const getNativeOverflowStyle = (scrollBar: ScrollBarDirection): React.CSSProperties => {
  switch (scrollBar) {
    case 'horizontal':
      return { overflowX: 'auto', overflowY: 'hidden' }
    case 'both':
      return { overflowX: 'auto', overflowY: 'auto' }
    case 'none':
      return { overflowX: 'hidden', overflowY: 'hidden' }
    case 'vertical':
    default:
      return { overflowX: 'hidden', overflowY: 'auto' }
  }
}

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ orientation = 'vertical', style, ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    style={{
      display: 'flex',
      touchAction: 'none',
      userSelect: 'none',
      transition: 'opacity 150ms ease',
      ...(orientation === 'vertical'
        ? {
            height: '100%',
            width: 10,
            padding: 1,
            borderLeft: '1px solid transparent',
          }
        : {
            height: 10,
            padding: 1,
            borderTop: '1px solid transparent',
          }),
      ...style,
    }}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb style={DEFAULT_THUMB_STYLE} />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))

ScrollBar.displayName = 'TabSlideScrollBar'

export const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(
  (
    {
      scrollBar = 'vertical',
      native = true,
      viewportRef,
      viewportStyle,
      viewportProps,
      children,
      style,
      scrollHideDelay = 600,
      ...props
    },
    ref
  ) => {
    React.useEffect(() => {
      ensureNativeHoverScrollbarStyles()
    }, [])

    const viewportRefStable = React.useRef(viewportRef)
    viewportRefStable.current = viewportRef

    const viewportRefCallback = React.useCallback(
      (node: HTMLDivElement | null) => {
        assignRef(viewportRefStable.current, node)
      },
      [],
    )

    if (native) {
      const {
        className: viewportClassName,
        ...restViewportProps
      } = viewportProps || {}

      return (
        <div
          ref={ref as React.Ref<HTMLDivElement>}
          style={{
            position: 'relative',
            overflow: 'hidden',
            minHeight: 0,
            ...style,
          }}
          {...props}
        >
          <div
            {...restViewportProps}
            className={mergeClassName(NATIVE_HOVER_SCROLLBAR_CLASS, viewportClassName)}
            ref={viewportRefCallback}
            style={{
              width: '100%',
              height: '100%',
              borderRadius: 'inherit',
              ...getNativeOverflowStyle(scrollBar),
              ...viewportStyle,
            }}
          >
            {children}
          </div>
        </div>
      )
    }

    return (
      <ScrollAreaPrimitive.Root
        ref={ref}
        type="hover"
        scrollHideDelay={scrollHideDelay}
        style={{
          position: 'relative',
          overflow: 'hidden',
          minHeight: 0,
          ...style,
        }}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          {...viewportProps}
          ref={viewportRefCallback}
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 'inherit',
            ...viewportStyle,
          }}
        >
          {children}
        </ScrollAreaPrimitive.Viewport>

        {(scrollBar === 'both' || scrollBar === 'vertical') && (
          <ScrollBar orientation="vertical" />
        )}
        {(scrollBar === 'both' || scrollBar === 'horizontal') && (
          <ScrollBar orientation="horizontal" />
        )}
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    )
  }
)

ScrollArea.displayName = 'TabSlideScrollArea'
