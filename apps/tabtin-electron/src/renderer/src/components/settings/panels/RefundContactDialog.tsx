/**
 * 账单「联系客服申请退款」：展示官网同源客服二维码（仅扫码，无 mailto / 企微外链）。
 */
import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import contactMeQrUrl from './assets/contact_me_qr.png?url'
import { SETTINGS_TEXT_META } from '../settingsUi'
import { cn } from '@utils/cn'

/** 默认无框；悬停 / 键盘聚焦时 2px 主题色描边（不用 ring，避免被 Dialog overflow-hidden 裁切） */
const CLOSE_BUTTON_CLASS =
  'rounded-md border-2 border-transparent p-1 focus:ring-0 focus:ring-offset-0 hover:border-primary focus-visible:border-primary'

interface RefundContactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const RefundContactDialog: React.FC<RefundContactDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation('settings')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm overflow-hidden p-0"
        closeClassName={CLOSE_BUTTON_CLASS}
      >
        <div className="bg-gradient-to-b from-primary/10 via-background to-background px-6 py-6 text-center">
          <DialogHeader className="space-y-2 text-center">
            <DialogTitle className="text-title font-semibold text-foreground">
              {t('billing.refund.dialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-body text-muted-foreground leading-relaxed">
              {t('billing.refund.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="mx-auto mt-5 w-fit rounded-3xl border border-border bg-background p-4 shadow-sm">
            <img
              src={contactMeQrUrl}
              alt={t('billing.refund.qrAlt')}
              className="h-56 w-56 rounded-2xl object-contain"
            />
          </div>
          <p className={cn(SETTINGS_TEXT_META, 'mt-3')}>
            {t('billing.refund.scanHint')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
