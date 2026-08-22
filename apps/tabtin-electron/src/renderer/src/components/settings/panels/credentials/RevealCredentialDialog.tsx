import React, { useState, useCallback } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { apiClient } from '@/services/apiClient'
import { SETTINGS_CONTROL, SETTINGS_LABEL, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../../settingsUi'
import { cn } from '@utils/cn'

interface RevealCredentialDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string | null
  itemLabel: string
  apiPath: string
  titleKey: string
  descriptionKey: string
}

export const RevealCredentialDialog: React.FC<RevealCredentialDialogProps> = ({
  open,
  onOpenChange,
  itemId,
  itemLabel,
  apiPath,
  titleKey,
  descriptionKey,
}) => {
  const { t } = useTranslation('settings')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [revealedData, setRevealedData] = useState<Record<string, any> | null>(null)

  const handleClose = useCallback(() => {
    onOpenChange(false)
    setPassword('')
    setRevealedData(null)
  }, [onOpenChange])

  const handleReveal = useCallback(async () => {
    if (!itemId || !password.trim()) return
    setLoading(true)
    try {
      const result = await apiClient.post<{ success: boolean; data: Record<string, any> }>(
        `${apiPath}/${itemId}/reveal`,
        { password }
      )
      setRevealedData(result.data?.data || result.data)
    } catch (error: any) {
      toast({
        title: t('credentialVault.serviceKeys.revealFailed'),
        description: error.message,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [itemId, password, apiPath, t])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            {t(titleKey)}
          </DialogTitle>
          <DialogDescription>{t(descriptionKey)}</DialogDescription>
        </DialogHeader>

        {revealedData ? (
          <div className="space-y-2 py-2">
            <div className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'mb-1')}>
              {itemLabel}
            </div>
            {Object.entries(revealedData).map(([key, value]) => (
              <div key={key} className="space-y-1">
                <label className={SETTINGS_TEXT_META}>{key}</label>
                <code className="block w-full rounded-md border bg-muted/20 px-3 py-2 text-body font-mono break-all select-all">
                  {String(value)}
                </code>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className={SETTINGS_LABEL}>
                {t('credentialVault.serviceKeys.revealPassword')}
              </label>
              <Input
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('credentialVault.serviceKeys.revealPasswordPlaceholder')}
                className={SETTINGS_CONTROL}
                type="password"
                onKeyDown={e => { if (e.key === 'Enter' && password.trim()) handleReveal() }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            {t('credentialVault.serviceKeys.cancel')}
          </Button>
          {!revealedData && (
            <Button onClick={handleReveal} disabled={loading || !password.trim()}>
              {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {t(titleKey)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
