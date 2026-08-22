import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tabtin/smartsheet-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import inviteCodeQrUrl from './assets/invite-code-qr.png?url'
import { useTranslation } from 'react-i18next'

type InviteCodeContactStripProps = {
  className?: string
  qrSize?: 'sm' | 'md'
}

export const InviteCodeContactStrip: React.FC<InviteCodeContactStripProps> = ({
  className,
  qrSize = 'sm',
}) => {
  const { t } = useTranslation('auth')
  const [showQrDialog, setShowQrDialog] = useState(false)
  const qrClass = qrSize === 'md' ? 'h-[3.75rem] w-[3.75rem]' : 'h-14 w-14'

  return (
    <>
      <button
        type="button"
        onClick={() => setShowQrDialog(true)}
        aria-label={t('invite.acquire.openDialog')}
        className={cn(
          'group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-2.5 text-left transition-colors',
          'hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
          className,
        )}
      >
        <span className="flex shrink-0 items-center justify-center rounded-md bg-background p-1 shadow-sm">
          <img
            src={inviteCodeQrUrl}
            alt=""
            aria-hidden="true"
            className={cn('rounded-[4px] object-contain', qrClass)}
          />
        </span>

        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block text-body font-medium leading-snug text-foreground">
            {t('invite.acquire.stripTitle')}
          </span>
          <span className="block text-caption leading-relaxed text-muted-foreground/80">
            {t('invite.acquire.stripHint')}
          </span>
        </span>

        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground/80"
        />
      </button>

      <InviteCodeAcquireDialog open={showQrDialog} onOpenChange={setShowQrDialog} />
    </>
  )
}

export const InviteCodeAcquireDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
}> = ({ open, onOpenChange }) => {
  const { t } = useTranslation('auth')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader className="space-y-2 text-center">
          <DialogTitle className="text-subtitle font-semibold text-foreground">
            {t('invite.acquire.dialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-body leading-relaxed text-muted-foreground">
            {t('invite.acquire.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-2 pt-1">
          <img
            src={inviteCodeQrUrl}
            alt={t('invite.acquire.qrAlt')}
            className="h-52 w-52 rounded-interactive object-contain"
          />
          <p className="text-caption text-muted-foreground/80">{t('invite.acquire.stripHint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
