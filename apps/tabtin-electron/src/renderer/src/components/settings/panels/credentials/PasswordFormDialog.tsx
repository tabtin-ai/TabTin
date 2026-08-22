/**
 * PasswordFormDialog —— 网站密码创建/编辑通用 Dialog。
 *
 * 同时承担两种模式：
 *  - create：新建一条 website credential
 *  - edit：编辑已有条目（密码留空 = 不修改）
 *
 * 抽出自原 WebsiteCredentialsSection 内部，供 BrowserDomainList 共用。
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
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@utils/cn'
import { apiClient } from '@/services/apiClient'
import { credentialKeys, type WebsiteCredentialItem } from '@/hooks/queries/credentials'
import { SETTINGS_CONTROL, SETTINGS_LABEL, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../../settingsUi'

function isValidUrl(value: string): boolean {
  if (!value.trim()) return false
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    new URL(withProtocol)
    return true
  } catch {
    return false
  }
}

export interface PasswordFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** edit 模式必填，create 模式置空 */
  item?: WebsiteCredentialItem | null
  /** 创建时预填 url（来自当前选中的 domain） */
  prefillUrl?: string
}

export const PasswordFormDialog: React.FC<PasswordFormDialogProps> = ({
  open,
  onOpenChange,
  item,
  prefillUrl,
}) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const mode: 'create' | 'edit' = item ? 'edit' : 'create'

  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [urlError, setUrlError] = useState(false)

  useEffect(() => {
    if (!open) return
    if (item) {
      setUrl(item.url)
      setUsername(item.username)
      setPassword('')
      setDisplayName(item.display_name || '')
    } else {
      setUrl(prefillUrl || '')
      setUsername('')
      setPassword('')
      setDisplayName('')
    }
    setShowPassword(false)
    setUrlError(false)
  }, [open, item, prefillUrl])

  const handleSubmit = async () => {
    if (mode === 'create') {
      if (!url.trim() || !username.trim() || !password) {
        toast({ title: t('credentialVault.websitePasswords.fillRequired'), variant: 'destructive' })
        return
      }
    }
    if (url.trim() && !isValidUrl(url)) {
      setUrlError(true)
      toast({ title: t('credentialVault.websitePasswords.invalidUrl'), variant: 'destructive' })
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'create') {
        await apiClient.post('/credential-vault/website/create', {
          url: url.trim(),
          username: username.trim(),
          password,
          display_name: displayName.trim(),
        })
        toast({ title: t('credentialVault.websitePasswords.saved') })
      } else if (item) {
        const payload: Record<string, any> = {}
        if (url.trim() && url.trim() !== item.url) payload.url = url.trim()
        if (username.trim() && username.trim() !== item.username) payload.username = username.trim()
        if (password) payload.password = password
        if (displayName.trim() !== (item.display_name || '')) payload.display_name = displayName.trim()

        if (Object.keys(payload).length === 0) {
          onOpenChange(false)
          return
        }
        await apiClient.put(`/credential-vault/website/${item.id}`, payload)
        toast({ title: t('credentialVault.websitePasswords.updated') })
      }
      void queryClient.invalidateQueries({ queryKey: credentialKeys.websiteCredentials() })
      onOpenChange(false)
    } catch (error: any) {
      toast({
        title:
          mode === 'create'
            ? t('credentialVault.websitePasswords.saveFailed')
            : t('credentialVault.websitePasswords.updateFailed'),
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
              ? t('credentialVault.websitePasswords.addTitle')
              : t('credentialVault.websitePasswords.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? t('credentialVault.websitePasswords.addDescription')
              : t('credentialVault.websitePasswords.editDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.websitePasswords.url')}</label>
            <Input
              value={url}
              onChange={(e) => { setUrl(e.target.value); setUrlError(false) }}
              placeholder={t('credentialVault.websitePasswords.urlPlaceholder')}
              className={cn(SETTINGS_CONTROL, urlError && 'border-destructive')}
            />
            {urlError && <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{t('credentialVault.websitePasswords.invalidUrl')}</p>}
          </div>
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.websitePasswords.username')}</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('credentialVault.websitePasswords.usernamePlaceholder')}
              className={SETTINGS_CONTROL}
            />
          </div>
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.websitePasswords.password')}</label>
            <div className="relative">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === 'create'
                    ? t('credentialVault.websitePasswords.passwordPlaceholder')
                    : t('credentialVault.websitePasswords.editPasswordPlaceholder')
                }
                className={cn(SETTINGS_CONTROL, 'font-mono pr-8')}
                type={showPassword ? 'text' : 'password'}
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
            <label className={SETTINGS_LABEL}>{t('credentialVault.websitePasswords.displayNameOptional')}</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('credentialVault.websitePasswords.displayNamePlaceholder')}
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
            {mode === 'create' ? t('credentialVault.websitePasswords.save') : t('credentialVault.serviceKeys.update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
