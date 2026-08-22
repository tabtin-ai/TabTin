import React, { useState, useEffect, useCallback } from 'react'
import {
  KeyRound,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  ToggleLeft,
  ToggleRight,
  Terminal,
} from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  toast,
  Input,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@components/ui'
import { cn } from '@utils/cn'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { useTranslation } from 'react-i18next'
import { apiClient } from '@/services/apiClient'
import { SETTINGS_CONTROL, SETTINGS_FLAT_SECTION, SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_SELECT_TRIGGER, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { formatDate } from '@/utils/i18n/format'

interface ApiKeyInfo {
  id: string
  organization_id: string
  name: string
  description: string
  key_display: string
  scopes: string[]
  rate_limit: number
  is_active: boolean
  expired_at: string | null
  last_used_at: string | null
  use_count: number
  created_at: string
}

interface OrganizationOption {
  id: string
  name: string
}

export const DeveloperApiKeyPanel: React.FC = () => {
  const { t } = useTranslation('settings')
  const [keys, setKeys] = useState<ApiKeyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('')
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([])
  const [plainKey, setPlainKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyInfo | null>(null)

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true)
      const { data: res } = await apiClient.get<{ success?: boolean; data?: { keys?: ApiKeyInfo[] }; keys?: ApiKeyInfo[] }>(
        '/api/auth/api-keys',
      )
      if (res.success) {
        setKeys(res.data?.keys ?? res.keys ?? [])
      }
    } catch {
      toast({ variant: 'destructive', title: t('developerApiKey.errors.loadFailed') })
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchOrganizations = useCallback(async () => {
    try {
      const { data: res } = await apiClient.get<{
        data?: { organizations?: OrganizationOption[] }
        organizations?: OrganizationOption[]
      }>('/api/context/organizations')
      const list = (res?.data?.organizations ?? res?.organizations ?? []) as OrganizationOption[]
      setOrganizations(list)
    } catch {
      toast({ variant: 'destructive', title: t('developerApiKey.errors.loadOrganizationsFailed') })
    }
  }, [t])

  useEffect(() => { fetchKeys(); fetchOrganizations() }, [fetchKeys, fetchOrganizations])

  const handleCreate = async () => {
    if (!newKeyName.trim()) return
    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        name: newKeyName.trim(),
        scopes: ['*'],
      }
      if (selectedOrganizationId) {
        body.organization_id = selectedOrganizationId
      }
      const { data: res } = await apiClient.post<{
        success?: boolean
        data?: { plain_key?: string }
        message?: string
      }>('/api/auth/api-keys', body)
      if (res.success && res.data?.plain_key) {
        setPlainKey(res.data.plain_key)
        setShowCreateDialog(false)
        setNewKeyName('')
        fetchKeys()
      } else {
        toast({ variant: 'destructive', title: res.message || t('developerApiKey.errors.createFailedMsg') })
      }
    } catch {
      toast({ variant: 'destructive', title: t('developerApiKey.errors.createFailed') })
    } finally {
      setCreating(false)
    }
  }

  const handleToggleActive = async (key: ApiKeyInfo) => {
    try {
      await apiClient.patch(`/api/auth/api-keys/${key.id}`, {
        is_active: !key.is_active,
      })
      fetchKeys()
      toast({ title: key.is_active ? t('developerApiKey.disable') : t('developerApiKey.enable') })
    } catch {
      toast({ variant: 'destructive', title: t('developerApiKey.errors.updateFailed') })
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await apiClient.delete(`/api/auth/api-keys/${deleteTarget.id}`)
      setDeleteTarget(null)
      fetchKeys()
      toast({ title: t('developerApiKey.errors.revokeSuccess') })
    } catch {
      toast({ variant: 'destructive', title: t('developerApiKey.errors.revokeFailed') })
    }
  }

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ variant: 'destructive', title: t('developerApiKey.errors.copyFailed') })
    }
  }

  const fmt = (iso: string | null) =>
    iso ? formatDate(iso, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Terminal className="h-4 w-4" />}
        title={t('developerApiKey.title')}
        subtitle={t('developerApiKey.subtitle')}
      />

      <SettingsSectionCard
        icon={<KeyRound className="h-4 w-4" />}
        title={t('developerApiKey.apiKeySection')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateDialog(true)}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('developerApiKey.create')}
          </Button>
        }
      >
        <p className={SETTINGS_HINT}>
          {t('developerApiKey.hint')}
        </p>

        <div className="mt-4 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
            </div>
          ) : keys.length === 0 ? (
            <div className="py-8 text-center">
              <KeyRound className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-body text-muted-foreground/60">{t('developerApiKey.empty')}</p>
              <p className={cn(SETTINGS_HINT, 'mt-1')}>
                {t('developerApiKey.emptyHint', { command: '' })}
                <code className={cn(SETTINGS_TEXT_MICRO, 'bg-muted px-1 py-0.5 rounded')}>tabtin login --token YOUR_KEY</code>
              </p>
            </div>
          ) : (
            keys.map((key) => (
              <div key={key.id} className={cn(SETTINGS_FLAT_SECTION, 'flex items-center gap-3')}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-body font-medium truncate">{key.name}</span>
                    <code className={cn(SETTINGS_HINT, 'bg-muted px-1 py-0.5 rounded shrink-0')}>
                      {key.key_display}
                    </code>
                    {!key.is_active && (
                      <span className={cn(SETTINGS_TEXT_MICRO, 'text-yellow-500/80 bg-yellow-500/10 px-1.5 py-0.5 rounded')}>{t('developerApiKey.disabled')}</span>
                    )}
                  </div>
                  <div className={cn(SETTINGS_HINT, 'mt-0.5 flex gap-3')}>
                    <span>{t('developerApiKey.createdAt', { date: fmt(key.created_at) })}</span>
                    <span>{t('developerApiKey.useCount', { count: key.use_count })}</span>
                    {key.last_used_at && <span>{t('developerApiKey.lastUsed', { date: fmt(key.last_used_at) })}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleActive(key)}
                    title={key.is_active ? t('developerApiKey.disable') : t('developerApiKey.enable')}
                    className="h-7 w-7 p-0"
                  >
                    {key.is_active
                      ? <ToggleRight className="h-4 w-4 text-green-500" />
                      : <ToggleLeft className="h-4 w-4 text-muted-foreground/60" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(key)}
                    className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        tone="muted"
        icon={<Terminal className="h-4 w-4" />}
        title={t('developerApiKey.cliTitle')}
      >
        <div className="space-y-2">
          <div className={SETTINGS_HINT}>
            <p>{t('developerApiKey.cliStep1')}</p>
            <p>{t('developerApiKey.cliStep2')}</p>
            <code className={cn(SETTINGS_TEXT_MICRO, 'block mt-1 bg-muted px-2 py-1.5 rounded font-mono')}>
              tabtin login --token ttn_xxxxxxxx_xxxxxxxxxxxxxxxx
            </code>
            <p className="mt-2">{t('developerApiKey.cliStep3')}</p>
            <code className={cn(SETTINGS_TEXT_MICRO, 'block mt-1 bg-muted px-2 py-1.5 rounded font-mono')}>
              tabtin &quot;hello&quot;
            </code>
          </div>
        </div>
      </SettingsSectionCard>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('developerApiKey.createTitle')}</DialogTitle>
            <DialogDescription>{t('developerApiKey.createDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className={SETTINGS_LABEL}>{t('developerApiKey.organizationLabel')}</label>
              <Select value={selectedOrganizationId || '__all__'} onValueChange={(v) => setSelectedOrganizationId(v === '__all__' ? '' : v)}>
                <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER, 'mt-1')}>
                  <SelectValue placeholder={t('developerApiKey.organizationAll')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('developerApiKey.organizationAll')}</SelectItem>
                  {organizations.map((wt) => (
                    <SelectItem key={wt.id} value={wt.id}>{wt.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className={cn(SETTINGS_HINT, 'mt-1')}>{t('developerApiKey.organizationHint')}</p>
            </div>
            <div>
              <label className={SETTINGS_LABEL}>{t('developerApiKey.nameLabel')}</label>
              <Input
                className={cn('mt-1', SETTINGS_CONTROL)}
                placeholder={t('developerApiKey.namePlaceholder')}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && handleCreate()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateDialog(false)}>{t('developerApiKey.cancel')}</Button>
            <Button onClick={handleCreate} disabled={creating || !newKeyName.trim()}>
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              {t('developerApiKey.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!plainKey} onOpenChange={() => setPlainKey(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('developerApiKey.createdTitle')}</DialogTitle>
            <DialogDescription>
              <span className="flex items-center gap-1.5 text-yellow-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('developerApiKey.createdWarning')}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <div className="flex items-center gap-2 bg-muted rounded-md px-3 py-2.5">
              <code className={cn(SETTINGS_TEXT_MICRO, 'font-mono', 'flex-1 break-all select-all')}>{plainKey}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy(plainKey!)}
                className="shrink-0 h-7 w-7 p-0"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setPlainKey(null)}>{t('developerApiKey.copiedClose')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title={t('developerApiKey.revokeTitle')}
        description={t('developerApiKey.revokeDesc', { name: deleteTarget?.name ?? '', display: deleteTarget?.key_display ?? '' })}
        confirmText={t('developerApiKey.revoke')}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </SettingsPanelLayout>
  )
}
