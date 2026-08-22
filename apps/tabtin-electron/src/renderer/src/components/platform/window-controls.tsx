import { useEffect, useState } from 'react'
import { TOPBAR_CHROME_ACTION } from '@components/layout/sidebarUi'
import { cn } from '@/utils/cn'

/**
 * 自绘窗口控件（最小化 / 最大化·还原 / 关闭）—— 飞书风格。
 *
 * 背景：Windows frameless 窗口此前依赖原生 titleBarOverlay 画系统按钮，但原生
 * 覆盖层浮在所有内容之上，鼠标悬浮右上角会遮挡我们的 UI（且样式不可控）。改为
 * renderer 自绘后，右上角按钮区由 shell overlay 控制，悬浮不再串味。
 *
 * 平台策略：
 *   - Windows / Linux：渲染这组按钮。主窗放在 ShellTopBar 右侧独立 no-drag 槽；
 *     无顶栏窗口（私信独立窗）由 ShellTitleBar fallbackDrag 浮层承载。
 *   - macOS：用系统红绿灯（窗口 trafficLightPosition），本组件返回 null。
 *
 * 最小 / 最大化：尺寸与 hover 对齐顶栏 chrome（TOPBAR_CHROME_ACTION）。
 * 关闭：略加宽（w-12），悬停恢复 Windows 红底（#e81123）。
 *
 * 容器与按钮均为 no-drag，必须落在 drag 容器之外或 no-drag 祖先内。
 */

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/Mac|Macintosh/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''))

const MinimizeIcon = () => (
  <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <line x1="1" y1="5" x2="9" y2="5" />
  </svg>
)

const MaximizeIcon = () => (
  <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <rect x="1" y="1" width="8" height="8" />
  </svg>
)

const RestoreIcon = () => (
  <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <rect x="1" y="3" width="6" height="6" />
    <path d="M3 3 V1 H9 V7 H7" />
  </svg>
)

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
    <line x1="1" y1="1" x2="9" y2="9" />
    <line x1="9" y1="1" x2="1" y2="9" />
  </svg>
)

interface WindowControlsProps {
  className?: string
}

/** 与顶栏 Network / ResourceMonitor / 折叠钮同款 hit area + hover */
const BUTTON_BASE = cn(
  TOPBAR_CHROME_ACTION,
  'app-region-no-drag text-muted-foreground/60 hover:text-foreground focus:outline-none',
)

/** 关闭：加宽 + Win 红底悬停（不复用 chrome hover，避免灰底与红底冲突） */
const CLOSE_BUTTON =
  'app-region-no-drag inline-flex h-8 w-12 shrink-0 items-center justify-center ' +
  'rounded-interactive text-muted-foreground/60 transition-colors focus:outline-none ' +
  'hover:bg-[#e81123] hover:text-white'

export function WindowControls({ className }: WindowControlsProps) {
  const controls = typeof window !== 'undefined' ? window.tabtin?.windowControls : undefined
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!controls) return
    let active = true
    controls
      .isMaximized()
      .then((value) => {
        if (active) setIsMaximized(value)
      })
      .catch(() => {})
    const unsubscribe = controls.onMaximizeChange((value) => {
      setIsMaximized(value)
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [controls])

  // macOS 用系统红绿灯；preload 缺失时（异常/测试环境）也不渲染。
  if (isMacPlatform() || !controls) return null

  return (
    <div className={cn('app-region-no-drag flex h-8 items-center gap-1', className)}>
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        onClick={() => controls.minimize()}
        className={BUTTON_BASE}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? '向下还原' : '最大化'}
        title={isMaximized ? '向下还原' : '最大化'}
        onClick={() => controls.toggleMaximize()}
        className={BUTTON_BASE}
      >
        {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        onClick={() => controls.close()}
        className={CLOSE_BUTTON}
      >
        <CloseIcon />
      </button>
    </div>
  )
}
