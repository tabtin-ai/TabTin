/**
 * BrowserSyncPopover —— 浏览器 vault 的同步 ⟳ 下拉。
 *
 * 浏览器特有：选浏览器 / 选 profile / 是否同步密码 + 立即同步；
 * 附带「高级」JSON 导入 / 导出。
 */

import React, { useState } from 'react'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from '@tabtin/smartsheet-ui'
import { Download, Globe, Loader2, RefreshCw, RotateCw, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BROWSER_ICONS } from './constants'
import { useBrowserSync } from './useBrowserSync'
import { SETTINGS_HINT, SETTINGS_SECTION_TITLE, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../../settingsUi'
import { cn } from '@utils/cn'

interface BrowserSyncPopoverProps {
  partition: string | null
  onSynced: () => void
}

export const BrowserSyncPopover: React.FC<BrowserSyncPopoverProps> = ({ partition, onSynced }) => {
  const { t } = useTranslation('settings')
  const sync = useBrowserSync()
  const [open, setOpen] = useState(false)
  const [jsonBusy, setJsonBusy] = useState<'import' | 'export' | null>(null)

  const browserIcon = sync.selectedBrowser
    ? BROWSER_ICONS[sync.selectedBrowser.name] ?? <Globe className="h-3.5 w-3.5" />
    : <Globe className="h-3.5 w-3.5" />

  const handleSync = async () => {
    const result = await sync.sync()
    if (result) {
      onSynced()
      setOpen(false)
    }
  }

  const handleJsonImport = async () => {
    if (!partition) {
      toast({ title: t('credentialVault.browserCookies.noSpace'), variant: 'destructive' })
      return
    }
    setJsonBusy('import')
    try {
      const res = await window.tabtin.credentialVault.importCookiesJson()
      if (!res.success) {
        if (res.error !== 'cancelled') {
          toast({ title: t('credentialVault.browserCookies.importFailed'), description: res.error, variant: 'destructive' })
        }
        return
      }
      if (res.cookies && res.cookies.length > 0) {
        const inj = await window.tabtin.credentialVault.injectCookies({ partition, cookies: res.cookies })
        if (inj.success) {
          toast({ title: t('credentialVault.browserCookies.importSuccess', { count: inj.injected }) })
          onSynced()
        }
      }
    } catch (e: any) {
      toast({ title: t('credentialVault.browserCookies.importFailed'), description: e?.message, variant: 'destructive' })
    } finally {
      setJsonBusy(null)
      setOpen(false)
    }
  }

  const handleJsonExport = async () => {
    if (!partition) return
    setJsonBusy('export')
    try {
      const res = await window.tabtin.credentialVault.exportCookiesJson({ partition })
      if (res.success) {
        toast({ title: t('credentialVault.browserCookies.exportSuccess', { count: res.count }) })
      } else if (res.error !== 'cancelled') {
        toast({ title: t('credentialVault.browserCookies.exportFailed'), description: res.error, variant: 'destructive' })
      }
    } catch (e: any) {
      toast({ title: t('credentialVault.browserCookies.exportFailed'), description: e?.message, variant: 'destructive' })
    } finally {
      setJsonBusy(null)
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground/80 hover:text-foreground"
          aria-label={t('credentialVault.toolbar.sync', { defaultValue: '同步浏览器' })}
          title={t('credentialVault.toolbar.sync', { defaultValue: '同步浏览器' })}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="space-y-3">
          <div>
            <h4 className="text-body font-medium text-foreground">
              {t('credentialVault.toolbar.syncTitle', { defaultValue: '同步浏览器登录态' })}
            </h4>
            <p className={cn(SETTINGS_HINT, 'mt-0.5')}>
              {t('credentialVault.hero.subtitle', { defaultValue: '同步到默认登录环境，所有共享同一登录环境的工作空间立即生效' })}
            </p>
          </div>

          {sync.detecting ? (
            <div className={cn(SETTINGS_HINT, 'flex items-center gap-1.5 py-2')}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t('credentialVault.browserCookies.detecting')}</span>
            </div>
          ) : sync.availableBrowsers.length === 0 ? (
            <p className={cn(SETTINGS_HINT, 'py-2')}>
              {t('credentialVault.onboarding.noBrowsersDetected')}
            </p>
          ) : (
            <>
              {sync.availableBrowsers.length > 1 && (
                <div>
                  <div className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground/80', 'mb-1.5')}>
                    {t('credentialVault.onboarding.selectBrowser', { defaultValue: '选择浏览器' })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sync.availableBrowsers.map((b) => {
                      const active = sync.selectedBrowser?.name === b.name
                      return (
                        <button
                          key={b.name}
                          type="button"
                          onClick={() => sync.selectBrowser(b.name)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors', SETTINGS_TEXT_MICRO,
                            active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40 text-foreground/80',
                          )}
                        >
                          {BROWSER_ICONS[b.name] || <Globe className="h-3.5 w-3.5" />}
                          <span>{b.displayName || b.name}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {sync.selectedBrowser && sync.selectedBrowser.profiles.length > 1 && (
                <div>
                  <div className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground/80', 'mb-1.5')}>
                    {t('credentialVault.onboarding.selectProfile', { defaultValue: '选择账号' })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sync.selectedBrowser.profiles.map((p) => {
                      const active = sync.selectedProfilePath === p.path
                      return (
                        <button
                          key={p.path}
                          type="button"
                          onClick={() => sync.selectProfile(p.path)}
                          className={cn(
                            'rounded-md px-2 py-1 transition-colors', SETTINGS_TEXT_MICRO,
                            active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40 text-foreground/80',
                          )}
                          title={p.path}
                        >
                          {p.name || (p.isDefault ? t('credentialVault.browserCookies.defaultProfile') : p.path)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <label
                className={cn(
                  'flex items-center gap-2 cursor-pointer select-none', SETTINGS_TEXT_MICRO,
                  !sync.passwordSupported && 'opacity-50 cursor-not-allowed',
                )}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={sync.includePasswords && sync.passwordSupported}
                  disabled={!sync.passwordSupported}
                  onChange={(e) => sync.setIncludePasswords(e.target.checked)}
                />
                <span className="text-foreground/90">
                  {t('credentialVault.onboarding.alsoImportPasswords', { defaultValue: '同时导入已保存的密码' })}
                </span>
              </label>

              <Button size="sm" onClick={handleSync} disabled={sync.isSyncing} className="w-full h-8 gap-1.5">
                {sync.isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span className="inline-flex items-center gap-1">
                  {browserIcon}
                  {t('credentialVault.hero.syncFrom', {
                    browser: sync.selectedBrowser?.displayName || sync.selectedBrowser?.name || '',
                    defaultValue: '同步 {{browser}}',
                  })}
                </span>
              </Button>

              <div className="pt-2 border-t border-border/30">
                <div className={cn(SETTINGS_SECTION_TITLE, 'mb-1.5')}>
                  {t('credentialVault.advanced.title', { defaultValue: '高级' })}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className={cn(SETTINGS_TEXT_MICRO, 'flex-1 h-7 gap-1.5')} onClick={handleJsonImport} disabled={jsonBusy !== null}>
                    <Upload className="h-3 w-3" />
                    {t('credentialVault.browserCookies.jsonImport', { defaultValue: 'JSON 导入' })}
                  </Button>
                  <Button variant="outline" size="sm" className={cn(SETTINGS_TEXT_MICRO, 'flex-1 h-7 gap-1.5')} onClick={handleJsonExport} disabled={jsonBusy !== null}>
                    <Download className="h-3 w-3" />
                    {t('credentialVault.browserCookies.jsonExport', { defaultValue: 'JSON 导出' })}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
