import React from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Input,
} from '@tabtin/smartsheet-ui'

export interface SaveAsViewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  onNameChange: (name: string) => void
  onSave: () => void
  translate: (key: string, options?: Record<string, unknown>) => string
}

export const SaveAsViewDialog: React.FC<SaveAsViewDialogProps> = ({
  open,
  onOpenChange,
  name,
  onNameChange,
  onSave,
  translate: t,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{t('view:saveAs.title')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-2">
        <Input
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
          placeholder={t('view:saveAs.placeholder')}
        />
      </div>
      <DialogFooter className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('common:cancel')}
        </Button>
        <Button onClick={onSave} disabled={!name.trim()}>
          {t('common:save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)
