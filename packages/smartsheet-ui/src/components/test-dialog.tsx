import React from 'react'
import { Button } from './button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from './dialog'
import { t } from "../i18n"

export interface TestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const TestDialog: React.FC<TestDialogProps> = ({
  open,
  onOpenChange
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('testDialog.title')}</DialogTitle>
        </DialogHeader>
        <div>
          <p>{t('testDialog.description')}</p>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
