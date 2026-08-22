import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
} from '@tabtin/smartsheet-ui'

interface TabCodeConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void
  disabled?: boolean
  /**
   * Dialog portal 容器。传 `null` 强制挂到 document.body（fixed），
   * 避免收起画布 / 宽度为 0 的 OverlayContainer 把确认框挤没。
   */
  container?: HTMLElement | null
}

export const TabCodeConfirmDialog: React.FC<TabCodeConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  disabled = false,
  container,
}) => {
  const { t } = useTranslation('tabcode')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" container={container}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {cancelLabel || t('confirm.cancel')}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            size="sm"
            disabled={disabled}
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel || t('confirm.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
