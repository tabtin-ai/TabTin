import React from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@components/ui'
import type { RenameDialogState } from './useSessionSwitcherActions'
import { MAX_SESSION_TITLE_LENGTH } from './sessionSwitcherStorage'

export interface SessionRenameDialogProps {
  renameDialog: RenameDialogState | null
  isRenaming: boolean
  onOpenChange: (open: boolean) => void
  onValueChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const SessionRenameDialog: React.FC<SessionRenameDialogProps> = ({
  renameDialog,
  isRenaming,
  onOpenChange,
  onValueChange,
  onSubmit,
  onCancel,
  t,
}) => (
  <Dialog
    open={renameDialog !== null}
    onOpenChange={onOpenChange}
  >
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle className="text-subtitle font-semibold">
          {t('session.renameTitle', { defaultValue: '重命名对话' })}
        </DialogTitle>
        <DialogDescription>
          {t('session.renameDescription', { defaultValue: '给这个对话起一个更容易识别的名称。' })}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <Input
          value={renameDialog?.value ?? ''}
          onChange={(event) => onValueChange(event.target.value)}
          maxLength={MAX_SESSION_TITLE_LENGTH}
          autoFocus
          disabled={isRenaming}
          aria-label={t('session.renameInputLabel', { defaultValue: '对话名称' })}
          placeholder={t('session.renamePlaceholder', { defaultValue: '输入对话名称' })}
        />
        {renameDialog?.error ? (
          <p className="text-body text-destructive">{renameDialog.error}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isRenaming}
            onClick={onCancel}
          >
            {t('session.renameCancel', { defaultValue: '取消' })}
          </Button>
          <Button
            type="submit"
            disabled={isRenaming || !renameDialog?.value.trim()}
          >
            {isRenaming ? t('session.renameSaving', { defaultValue: '保存中...' }) : t('session.renameSave', { defaultValue: '保存' })}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
)
