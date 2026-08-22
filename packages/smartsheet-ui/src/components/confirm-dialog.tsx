/**
 * ConfirmDialog - 确认对话框组件
 * 用于需要用户确认的操作（如删除）
 */

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'
import { Button } from './button'
import { t } from "../i18n"

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  children?: React.ReactNode
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void | Promise<void>
  isLoading?: boolean
  /**
   * When true, prevent Radix from restoring focus to a detached trigger
   * (e.g. context-menu item) and focus the TabData grid container instead.
   */
  restoreFocusOnClose?: boolean
  /** Optional override for restoreFocusOnClose; defaults to TabData grid selectors. */
  onRestoreFocus?: () => void
  /**
   * Portal container passthrough to DialogContent. `null` forces the global
   * (body-level) layer even when an OverlayContainerContext is present.
   */
  container?: HTMLElement | null
  /** Passthrough to DialogContent — e.g. keep open when clicking z-toast float panels. */
  onPointerDownOutside?: React.ComponentProps<typeof DialogContent>['onPointerDownOutside']
  onInteractOutside?: React.ComponentProps<typeof DialogContent>['onInteractOutside']
  onFocusOutside?: React.ComponentProps<typeof DialogContent>['onFocusOutside']
}

function defaultRestoreTableGridFocus(): void {
  if (typeof document === 'undefined') return

  const target =
    document.querySelector<HTMLElement>('[data-t-grid-view] [data-t-grid-container]') ??
    document.querySelector<HTMLElement>('[data-t-grid-container]')

  if (!target) return

  requestAnimationFrame(() => {
    target.focus({ preventScroll: true })
  })
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmText,
  cancelText,
  variant = 'default',
  onConfirm,
  isLoading = false,
  restoreFocusOnClose = false,
  onRestoreFocus,
  container,
  onPointerDownOutside,
  onInteractOutside,
  onFocusOutside,
}) => {
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const resolvedTitle = title ?? t('confirmDialog.title')
  const resolvedDescription = description ?? t('confirmDialog.description')
  const resolvedConfirmText = confirmText ?? t('common.confirm')
  const resolvedCancelText = cancelText ?? t('common.cancel')

  const handleConfirm = async () => {
    setIsSubmitting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      console.error('操作失败:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    if (!isSubmitting) {
      onOpenChange(false)
    }
  }

  // destructive 删除常从右键菜单触发：关闭时若把焦点还原到已卸载节点，
  // Win Electron 上会出现「能点出 IME、字进不了输入框」。默认拦截 autofocus。
  const shouldManageCloseFocus = restoreFocusOnClose || variant === 'destructive'

  const handleCloseAutoFocus = (event: Event) => {
    if (!shouldManageCloseFocus) return
    event.preventDefault()
    if (restoreFocusOnClose) {
      ;(onRestoreFocus ?? defaultRestoreTableGridFocus)()
      return
    }
    onRestoreFocus?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        container={container}
        onCloseAutoFocus={shouldManageCloseFocus ? handleCloseAutoFocus : undefined}
        onPointerDownOutside={onPointerDownOutside}
        onInteractOutside={onInteractOutside}
        onFocusOutside={onFocusOutside}
      >
        <DialogHeader>
          <DialogTitle>{resolvedTitle}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>

        {children ? <div className="space-y-3">{children}</div> : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isSubmitting || isLoading}
          >
            {resolvedCancelText}
          </Button>
          <Button
            type="button"
            variant={variant}
            onClick={handleConfirm}
            disabled={isSubmitting || isLoading}
          >
            {isSubmitting || isLoading ? t('common.processing') : resolvedConfirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
