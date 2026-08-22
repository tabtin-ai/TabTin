/**
 * DeviceAppPickerDialog —— 从当前 Space 关联设备扫描已安装应用，挑一个用作凭据目标。
 *
 * 选中后回调 onPicked，主面板用回调结果调起 AppCredentialFormDialog。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from '@components/ui'
import { Loader2, Search, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { apiClient } from '@/services/apiClient'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../../settingsUi'

interface DeviceAppInfo {
  package: string
  name: string
  system: boolean
}

interface DeviceAppPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string | null
  onPicked: (app: DeviceAppInfo) => void
}

export const DeviceAppPickerDialog: React.FC<DeviceAppPickerDialogProps> = ({
  open,
  onOpenChange,
  spaceId,
  onPicked,
}) => {
  const { t } = useTranslation('settings')
  const [apps, setApps] = useState<DeviceAppInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const fetchApps = useCallback(async () => {
    if (!spaceId) {
      setError(t('credentialVault.appCredentials.noSpace', { defaultValue: '请先选择一个 Space' }))
      return
    }
    setLoading(true)
    setError(null)
    setApps([])
    setSearch('')
    try {
      const result = await apiClient.post<{ success: boolean; data: { apps: DeviceAppInfo[] } }>(
        '/context/devices/query',
        {
          space_id: spaceId,
          action: 'list_installed_apps',
          params: { filter: 'user', limit: 500 },
          timeout_seconds: 15,
        },
      )
      const payload = result.data
      if (payload?.success === false) {
        throw new Error((payload as any)?.error || t('credentialVault.appCredentials.pickerUnknownError'))
      }
      const list = payload?.data?.apps ?? []
      list.sort((a, b) => a.name.localeCompare(b.name))
      setApps(list)
    } catch (e: any) {
      const raw = e?.response?.data?.error || e.message || ''
      const isOffline = /OFFLINE|UNAVAILABLE|未在线|未建立|timeout|超时/i.test(raw)
      setError(
        isOffline
          ? t('credentialVault.appCredentials.pickerDeviceOffline')
          : raw || t('credentialVault.appCredentials.pickerUnknownError'),
      )
    } finally {
      setLoading(false)
    }
  }, [spaceId, t])

  useEffect(() => {
    if (open) void fetchApps()
  }, [open, fetchApps])

  const filtered = useMemo(() => {
    if (!search.trim()) return apps
    const q = search.toLowerCase()
    return apps.filter((a) => a.name.toLowerCase().includes(q) || a.package.toLowerCase().includes(q))
  }, [apps, search])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-accent" />
            {t('credentialVault.appCredentials.pickerTitle', { defaultValue: '从设备选择 App' })}
          </DialogTitle>
          <DialogDescription>
            {t('credentialVault.appCredentials.pickerDescription', {
              defaultValue: '扫描当前工作空间关联设备上已安装的应用，选中后填入凭据信息',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('credentialVault.appCredentials.pickerSearchPlaceholder', { defaultValue: '搜索 App 名称或包名…' })}
              className={cn(SETTINGS_CONTROL, 'pl-8')}
              disabled={loading}
            />
          </div>

          <ScrollArea className="max-h-72 rounded-md border border-border/60">
            {loading ? (
              <div className={cn(SETTINGS_TEXT_META, 'flex items-center justify-center gap-2 py-8')}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('credentialVault.appCredentials.pickerLoading', { defaultValue: '正在扫描已安装应用…' })}
              </div>
            ) : error ? (
              <div className="py-8 text-center">
                <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{error}</p>
                <button type="button" onClick={() => void fetchApps()} className={cn(SETTINGS_TEXT_META_BASE, 'text-accent', 'mt-2 hover:underline')}>
                  {t('credentialVault.appCredentials.pickerRetry', { defaultValue: '重试' })}
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <p className={cn(SETTINGS_HINT, 'py-8 text-center')}>
                {t('credentialVault.appCredentials.pickerEmpty', { defaultValue: '未找到匹配应用' })}
              </p>
            ) : (
              <div className="divide-y divide-border/40">
                {filtered.map((app) => (
                  <button
                    key={app.package}
                    type="button"
                    onClick={() => {
                      onPicked(app)
                      onOpenChange(false)
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                  >
                    <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body text-foreground">{app.name}</div>
                      <code className={cn(SETTINGS_HINT, 'truncate font-mono')}>{app.package}</code>
                    </div>
                    {app.system && (
                      <span className={cn(SETTINGS_HINT, 'shrink-0 rounded-md bg-muted/40 px-1.5 py-0.5')}>
                        sys
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('credentialVault.serviceKeys.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
