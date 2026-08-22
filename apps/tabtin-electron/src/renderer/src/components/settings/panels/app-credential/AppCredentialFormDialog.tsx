/**
 * AppCredentialFormDialog —— 应用凭据创建/编辑通用 Dialog。
 */

import React, { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys, type AppCredentialItem } from '@/hooks/queries/credentials'
import { SETTINGS_CONTROL, SETTINGS_LABEL } from '../../settingsUi'

interface AppCredentialFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item?: AppCredentialItem | null
  /** 创建时预填的 package / app_name（来自 device picker） */
  prefillPackage?: string
  prefillAppName?: string
}

export const AppCredentialFormDialog: React.FC<AppCredentialFormDialogProps> = ({
  open,
  onOpenChange,
  item,
  prefillPackage,
  prefillAppName,
}) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const mode: 'create' | 'edit' = item ? 'edit' : 'create'

  const [pkg, setPkg] = useState('')
  const [appName, setAppName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    if (item) {
      setPkg(item.app_package)
      setAppName(item.app_name || '')
      setUsername(item.username)
      setPassword('')
      setDisplayName(item.display_name || '')
    } else {
      setPkg(prefillPackage ?? '')
      setAppName(prefillAppName ?? '')
      setUsername('')
      setPassword('')
      setDisplayName('')
    }
    setShowPassword(false)
  }, [open, item, prefillPackage, prefillAppName])

  const handleSubmit = async () => {
    if (mode === 'create') {
      if (!pkg.trim() || !username.trim() || !password.trim()) {
        toast({ title: t('credentialVault.appCredentials.fillRequired'), variant: 'destructive' })
        return
      }
    }
    setSubmitting(true)
    try {
      if (mode === 'create') {
        await apiClient.post('/credential-vault/app/create', {
          app_package: pkg.trim(),
          app_name: appName.trim(),
          username: username.trim(),
          password,
          display_name: displayName.trim(),
        })
        toast({ title: t('credentialVault.appCredentials.saved') })
      } else if (item) {
        const payload: Record<string, any> = {}
        if (displayName.trim() !== (item.display_name || '')) payload.display_name = displayName.trim()
        const credData: Record<string, string> = {}
        if (username.trim() && username.trim() !== item.username) credData.username = username.trim()
        if (password) credData.password = password
        if (Object.keys(credData).length > 0) payload.credential_data = credData
        if (Object.keys(payload).length === 0) {
          onOpenChange(false)
          return
        }
        await apiClient.put(`/credential-vault/${item.id}`, payload)
        toast({ title: t('credentialVault.appCredentials.updated') })
      }
      void queryClient.invalidateQueries({ queryKey: credentialKeys.appCredentials() })
      onOpenChange(false)
    } catch (error: any) {
      toast({
        title:
          mode === 'create'
            ? t('credentialVault.appCredentials.saveFailed')
            : t('credentialVault.appCredentials.updateFailed'),
        description: error?.message,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? t('credentialVault.appCredentials.addTitle')
              : t('credentialVault.appCredentials.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? t('credentialVault.appCredentials.addDescription')
              : t('credentialVault.appCredentials.editDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.appCredentials.appPackage')}</label>
            <Input
              value={pkg}
              onChange={(e) => setPkg(e.target.value)}
              placeholder={t('credentialVault.appCredentials.appPackagePlaceholder')}
              disabled={mode === 'edit'}
              className={cn(SETTINGS_CONTROL, 'font-mono')}
            />
          </div>
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.appCredentials.appName')}</label>
            <Input
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder={t('credentialVault.appCredentials.appNamePlaceholder')}
              className={SETTINGS_CONTROL}
            />
          </div>
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.appCredentials.username')}</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('credentialVault.appCredentials.usernamePlaceholder')}
              className={SETTINGS_CONTROL}
            />
          </div>
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.appCredentials.password')}</label>
            <div className="relative">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === 'create'
                    ? t('credentialVault.appCredentials.passwordPlaceholder')
                    : t('credentialVault.appCredentials.editPasswordPlaceholder')
                }
                type={showPassword ? 'text' : 'password'}
                className={cn(SETTINGS_CONTROL, 'font-mono pr-8')}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.appCredentials.displayNameOptional')}</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('credentialVault.appCredentials.displayNamePlaceholder')}
              className={SETTINGS_CONTROL}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('credentialVault.serviceKeys.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {mode === 'create' ? t('credentialVault.appCredentials.save') : t('credentialVault.serviceKeys.update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
