/**
 * BlacklistDialog —— 把「不保存密码的网站」从主面板挪进 Dialog 弹出管理。
 *
 * 这是极低频管理项，从 toolbar `⋯` 入口触发。
 */

import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { SaveBlacklistSection } from './SaveBlacklistSection'

interface BlacklistDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const BlacklistDialog: React.FC<BlacklistDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation('settings')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('credentialVault.saveBlacklist.title')}
          </DialogTitle>
          <DialogDescription>
            {t('credentialVault.saveBlacklist.subtitle')}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <SaveBlacklistSection />
        </div>
      </DialogContent>
    </Dialog>
  )
}
