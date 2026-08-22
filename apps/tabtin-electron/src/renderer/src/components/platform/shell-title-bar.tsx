import {
  WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH,
  WindowDragRegion,
} from './drag-region'
import { WindowControls } from './window-controls'

const TITLE_BAR_HEIGHT = 36

/**
 * 无 ShellTopBar 时的窗口框兜底 —— 仅 Windows / Linux。
 *
 * 主窗由 `ShellTopBar` 承载拖窗与自绘窗口控件。本组件默认不渲染，
 * 仅在私信独立窗等无顶栏场景传 `fallbackDrag` 时提供：全宽拖拽带（右留控件宽）
 * + 右上角 WindowControls。
 *
 * macOS 不渲染（系统红绿灯）。
 */

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/Mac|Macintosh/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''))

interface ShellTitleBarProps {
  /** 无 ShellTopBar 时开启兜底拖拽 + 窗口控件 */
  fallbackDrag?: boolean
}

export function ShellTitleBar({ fallbackDrag = false }: ShellTitleBarProps) {
  if (isMacPlatform() || !fallbackDrag) return null

  return (
    <div
      data-testid="shell-window-frame-overlay"
      className="pointer-events-none absolute inset-x-0 top-0 z-banner select-none bg-transparent"
    >
      <WindowDragRegion
        className="pointer-events-auto"
        height={TITLE_BAR_HEIGHT}
        reserveRight={WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH}
      />
      <WindowControls className="app-region-no-drag pointer-events-auto absolute right-1 top-1/2 z-sticky -translate-y-1/2" />
    </div>
  )
}
