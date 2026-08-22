/**
 * OverlayScrim — renderer 专用「合规遮罩 + 居中浮层」积木
 *
 * 用于少数**非表单**的自定义浮层（图片 lightbox、自定义选择器等）：当一个完整
 * 的 Radix `Dialog` / `Sheet` 过重、又不想各自手写 `fixed inset-0 bg-black/40 ...`
 * 时，用本组件得到符合 design-system 的遮罩与浮层材质：
 *   - 遮罩：`.bg-modal-scrim`（真源 `--modal-scrim`）+ `z-modal`；
 *   - 浮层面：`OVERLAY_SURFACE_CLASS`（半透明暖灰毛玻璃 + 单层投影 + 顶缘内高光）
 *     + `rounded-interactive`（8px 交互圆角，design-system §12）。
 *
 * 表单类确认 / 编辑浮层请优先用 `@tabtin/smartsheet-ui` 的 `ConfirmDialog` /
 * `Dialog` / `Sheet`（带焦点陷阱、可访问性），不要用本组件替代它们。
 */
import * as React from 'react'
import { cn, OVERLAY_SURFACE_CLASS } from '@tabtin/smartsheet-ui'

export interface OverlayScrimProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** 浮层面板额外类名（默认已含 OVERLAY_SURFACE_CLASS + rounded-interactive） */
  panelClassName?: string
  /** 遮罩层额外类名 */
  scrimClassName?: string
  /** 点击遮罩是否关闭（默认 true） */
  closeOnBackdrop?: boolean
  /** 按 Esc 是否关闭（默认 true） */
  closeOnEscape?: boolean
  /** 无障碍标签 */
  ariaLabel?: string
}

export const OverlayScrim: React.FC<OverlayScrimProps> = ({
  open,
  onClose,
  children,
  panelClassName,
  scrimClassName,
  closeOnBackdrop = true,
  closeOnEscape = true,
  ariaLabel,
}) => {
  React.useEffect(() => {
    if (!open || !closeOnEscape) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 通用浮层 primitive，监听已由 open 受控启停，无 hot-Space zombie effect 问题
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeOnEscape, onClose])

  if (!open) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-modal flex items-center justify-center bg-modal-scrim',
        scrimClassName,
      )}
      onClick={closeOnBackdrop ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className={cn('rounded-interactive', OVERLAY_SURFACE_CLASS, panelClassName)}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
