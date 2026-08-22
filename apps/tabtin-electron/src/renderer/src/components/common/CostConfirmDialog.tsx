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
  Separator,
} from '@tabtin/smartsheet-ui'
import { AlertTriangle } from 'lucide-react'

export interface CostConfirmDialogProps {
  open: boolean
  serviceName: string
  quantity: number
  unitPrice: number
  unit: string
  totalCost: number
  currency?: string
  walletBalance?: number
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
  onRecharge?: () => void
}

export const CostConfirmDialog: React.FC<CostConfirmDialogProps> = ({
  open,
  serviceName,
  quantity,
  unitPrice,
  unit,
  totalCost,
  currency = 'credits',
  walletBalance,
  loading,
  onConfirm,
  onCancel,
  onRecharge,
}) => {
  const { t } = useTranslation('settings')
  const insufficientBalance = walletBalance !== undefined && walletBalance < totalCost

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle className="text-subtitle">{t('organizationServices.costConfirm.title')}</DialogTitle>
          <DialogDescription className="text-body text-muted-foreground/80">
            {t('organizationServices.costConfirm.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex justify-between text-body">
            <span className="text-muted-foreground/80">{t('organizationServices.costConfirm.service')}</span>
            <span className="font-medium">{serviceName}</span>
          </div>
          <div className="flex justify-between text-body">
            <span className="text-muted-foreground/80">{t('organizationServices.costConfirm.quantity')}</span>
            <span>{quantity} {unit}</span>
          </div>
          <div className="flex justify-between text-body">
            <span className="text-muted-foreground/80">{t('organizationServices.costConfirm.unitPrice')}</span>
            <span>{unitPrice.toFixed(2)} {currency}/{unit}</span>
          </div>

          <Separator />

          <div className="flex justify-between text-body font-medium">
            <span>{t('organizationServices.costConfirm.estimatedCost')}</span>
            <span className="text-accent">{totalCost.toFixed(2)} {currency}</span>
          </div>

          {walletBalance !== undefined && (
            <div className="flex justify-between text-body">
              <span className="text-muted-foreground/80">{t('organizationServices.costConfirm.currentBalance')}</span>
              <span className={insufficientBalance ? 'text-destructive' : ''}>
                {walletBalance.toFixed(2)} {currency}
              </span>
            </div>
          )}

          {insufficientBalance && (
            <div className="flex items-center justify-between text-caption text-destructive bg-destructive/10 rounded-md px-2.5 py-1.5">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{t('organizationServices.costConfirm.insufficientBalance')}</span>
              </div>
              {onRecharge && (
                <Button
                  variant="link"
                  size="sm"
                  className="text-caption text-destructive underline p-0 h-auto"
                  onClick={onRecharge}
                >
                  {t('organizationServices.costConfirm.goRecharge')}
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
            {t('organizationServices.costConfirm.cancel')}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={loading || insufficientBalance}>
            {loading ? t('organizationServices.costConfirm.executing') : t('organizationServices.costConfirm.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
