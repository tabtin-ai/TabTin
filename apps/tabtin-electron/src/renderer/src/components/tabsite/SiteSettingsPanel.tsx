import React, { useState, useCallback } from 'react'
import {
  Button, Input, Label, Switch, Separator, toast,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@tabtin/smartsheet-ui'
import { Archive, ArchiveRestore, Copy, Check, Pencil, Loader2, Lock, LockOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface SiteSettingsData {
  id: string
  name: string
  slug: string
  is_public: boolean
  custom_domain: string
  status: string
  password_protected?: boolean
}

interface SiteSettingsPanelProps {
  site: SiteSettingsData
  onUpdate: () => void
}

const SiteSettingsPanel: React.FC<SiteSettingsPanelProps> = ({ site, onUpdate }) => {
  const { t } = useTranslation('tabsite')
  const [saving, setSaving] = useState(false)
  const isArchived = site.status === 'archived'

  // ── Inline name editing ──
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(site.name)

  const saveName = useCallback(async () => {
    if (!nameValue.trim() || nameValue === site.name) {
      setEditingName(false)
      setNameValue(site.name)
      return
    }
    setSaving(true)
    try {
      const { apiService } = await import('@/services/api')
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${site.id}/`,
        data: { name: nameValue.trim() },
      })
      toast({ title: t('settings.nameUpdated', { defaultValue: '站点名称已更新' }) })
      setEditingName(false)
      onUpdate()
    } catch (err: any) {
      toast({
        title: t('settings.updateFailed', { defaultValue: '更新失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [site.id, site.name, nameValue, onUpdate, t])

  // ── Visibility toggle ──
  const handleVisibilityToggle = useCallback(async (checked: boolean) => {
    setSaving(true)
    try {
      const { apiService } = await import('@/services/api')
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${site.id}/`,
        data: { is_public: checked },
      })
      toast({
        title: checked
          ? t('settings.madePublic', { defaultValue: '站点已设为公开' })
          : t('settings.madePrivate', { defaultValue: '站点已设为私有' }),
      })
      onUpdate()
    } catch (err: any) {
      toast({
        title: t('settings.updateFailed', { defaultValue: '更新失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [site.id, onUpdate, t])

  // ── Custom domain ──
  const [domainValue, setDomainValue] = useState(site.custom_domain || '')
  const [savingDomain, setSavingDomain] = useState(false)

  const saveDomain = useCallback(async () => {
    setSavingDomain(true)
    try {
      const { apiService } = await import('@/services/api')
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${site.id}/`,
        data: { custom_domain: domainValue.trim() },
      })
      toast({ title: t('settings.domainUpdated', { defaultValue: '域名已更新' }) })
      onUpdate()
    } catch (err: any) {
      toast({
        title: t('settings.updateFailed', { defaultValue: '更新失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setSavingDomain(false)
    }
  }, [site.id, domainValue, onUpdate, t])

  // ── Archive / Restore ──
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const handleArchiveOrRestore = useCallback(async () => {
    setArchiving(true)
    try {
      const { apiService } = await import('@/services/api')
      const newStatus = isArchived ? 'draft' : 'archived'
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${site.id}/`,
        data: { status: newStatus },
      })
      toast({
        title: isArchived
          ? t('settings.restored', { defaultValue: '站点已恢复' })
          : t('settings.archived', { defaultValue: '站点已归档' }),
      })
      setArchiveDialogOpen(false)
      onUpdate()
    } catch (err: any) {
      toast({
        title: t('settings.updateFailed', { defaultValue: '操作失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setArchiving(false)
    }
  }, [site.id, isArchived, onUpdate, t])

  // ── Slug copy ──
  const [slugCopied, setSlugCopied] = useState(false)
  const copySlug = useCallback(() => {
    navigator.clipboard.writeText(site.slug).then(() => {
      setSlugCopied(true)
      setTimeout(() => setSlugCopied(false), 1500)
    })
  }, [site.slug])

  return (
    <div className="space-y-4">
      <h3 className="text-body font-medium uppercase text-muted-foreground">
        {t('settings.title', { defaultValue: '站点设置' })}
      </h3>

      {/* Name */}
      <div className="space-y-1">
        <Label className="text-body text-muted-foreground">
          {t('settings.name', { defaultValue: '站点名称' })}
        </Label>
        {editingName ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              className="h-7 text-body"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveName()
                if (e.key === 'Escape') { setEditingName(false); setNameValue(site.name) }
              }}
            />
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={saveName} disabled={saving}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            </Button>
          </div>
        ) : (
          <div className="group flex items-center gap-1">
            <span className="text-body">{site.name}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
              onClick={() => { setNameValue(site.name); setEditingName(true) }}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Slug */}
      <div className="space-y-1">
        <Label className="text-body text-muted-foreground">Slug</Label>
        <div className="flex items-center gap-1">
          <code className="rounded bg-muted px-1.5 py-0.5 text-caption">{site.slug}</code>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={copySlug}>
            {slugCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {/* Visibility */}
      <div className="space-y-1">
        <Label className="text-body text-muted-foreground">
          {t('settings.visibility', { defaultValue: '公开访问' })}
        </Label>
        <div className="flex items-center justify-between">
          <span className="text-body">
            {site.is_public
              ? t('settings.publicHint', { defaultValue: '任何人可通过链接访问' })
              : t('settings.privateHint', { defaultValue: '仅组织成员可访问' })}
          </span>
          <Switch
            checked={site.is_public}
            onCheckedChange={handleVisibilityToggle}
            disabled={saving || isArchived}
          />
        </div>
      </div>

      {/* Custom Domain */}
      <div className="space-y-1">
        <Label className="text-body text-muted-foreground">
          {t('settings.customDomain', { defaultValue: '自定义域名' })}
        </Label>
        <div className="flex items-center gap-1.5">
          <Input
            value={domainValue}
            onChange={(e) => setDomainValue(e.target.value)}
            placeholder="example.com"
            className="h-7 text-body"
            disabled={isArchived}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={saveDomain}
            disabled={savingDomain || isArchived || domainValue === (site.custom_domain || '')}
          >
            {savingDomain ? <Loader2 className="h-3 w-3 animate-spin" /> : t('settings.save', { defaultValue: '保存' })}
          </Button>
        </div>
        {domainValue && (
          <p className="text-caption text-muted-foreground/60">
            {t('settings.cnameHint', { defaultValue: '请将域名的 CNAME 记录指向 site.example.com' })}
          </p>
        )}
      </div>

      {/* Password protection */}
      <PasswordSection siteId={site.id} passwordProtected={!!site.password_protected} isArchived={isArchived} onUpdate={onUpdate} />

      <Separator />

      {/* Archive / Restore */}
      <div className="space-y-1">
        <Label className="text-body text-muted-foreground">
          {t('settings.dangerZone', { defaultValue: '危险操作' })}
        </Label>
        <Button
          variant="outline"
          size="sm"
          className={isArchived ? 'text-primary' : 'text-destructive hover:text-destructive'}
          onClick={() => setArchiveDialogOpen(true)}
        >
          {isArchived ? (
            <>
              <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.restore', { defaultValue: '恢复站点' })}
            </>
          ) : (
            <>
              <Archive className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.archive', { defaultValue: '归档站点' })}
            </>
          )}
        </Button>
      </div>

      {/* Archive confirmation dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {isArchived
                ? t('settings.restoreTitle', { defaultValue: '确认恢复站点？' })
                : t('settings.archiveTitle', { defaultValue: '确认归档站点？' })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-body text-muted-foreground">
            {isArchived
              ? t('settings.restoreDesc', { defaultValue: '恢复后站点将重新变为可编辑状态' })
              : t('settings.archiveDesc', { defaultValue: '归档后站点将不可预览、不可发布、不可回滚' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveDialogOpen(false)} disabled={archiving}>
              {t('dialog.cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              variant={isArchived ? 'default' : 'destructive'}
              onClick={handleArchiveOrRestore}
              disabled={archiving}
            >
              {archiving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isArchived
                ? t('settings.confirmRestore', { defaultValue: '确认恢复' })
                : t('settings.confirmArchive', { defaultValue: '确认归档' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PasswordSection({
  siteId, passwordProtected, isArchived, onUpdate,
}: {
  siteId: string; passwordProtected: boolean; isArchived: boolean; onUpdate: () => void
}) {
  const { t } = useTranslation('tabsite')
  const [passwordValue, setPasswordValue] = useState('')
  const [saving, setSaving] = useState(false)

  const setPassword = useCallback(async () => {
    if (!passwordValue.trim()) return
    setSaving(true)
    try {
      const { apiService } = await import('@/services/api')
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${siteId}/`,
        data: { password: passwordValue },
      })
      toast({ title: t('settings.passwordSet', { defaultValue: '密码已设置' }) })
      setPasswordValue('')
      onUpdate()
    } catch (err: any) {
      toast({ title: t('settings.updateFailed', { defaultValue: '设置失败' }), description: err?.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [siteId, passwordValue, onUpdate, t])

  const clearPassword = useCallback(async () => {
    setSaving(true)
    try {
      const { apiService } = await import('@/services/api')
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${siteId}/`,
        data: { password: '' },
      })
      toast({ title: t('settings.passwordCleared', { defaultValue: '密码已清除' }) })
      onUpdate()
    } catch (err: any) {
      toast({ title: t('settings.updateFailed', { defaultValue: '清除失败' }), description: err?.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [siteId, onUpdate, t])

  return (
    <div className="space-y-1">
      <Label className="text-body text-muted-foreground">
        {passwordProtected ? <Lock className="mr-1 inline h-3 w-3" /> : <LockOpen className="mr-1 inline h-3 w-3" />}
        {t('settings.password', { defaultValue: '访问密码' })}
      </Label>
      {passwordProtected ? (
        <div className="flex items-center justify-between">
          <span className="text-body text-emerald-600">
            {t('settings.passwordActive', { defaultValue: '已设置密码保护' })}
          </span>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={clearPassword} disabled={saving || isArchived}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : t('settings.clearPassword', { defaultValue: '清除' })}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            value={passwordValue}
            onChange={(e) => setPasswordValue(e.target.value)}
            placeholder={t('settings.passwordPlaceholder', { defaultValue: '设置访问密码' })}
            className="h-7 text-body"
            disabled={isArchived}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) setPassword()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={setPassword}
            disabled={saving || isArchived || !passwordValue.trim()}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : t('settings.save', { defaultValue: '保存' })}
          </Button>
        </div>
      )}
    </div>
  )
}

export default SiteSettingsPanel
