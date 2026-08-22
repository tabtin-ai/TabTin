/**
 * AppVaultSyncPopover —— 应用 vault 的同步 ⟳ 下拉。
 */

import React, { useState } from 'react'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@tabtin/smartsheet-ui'
import { RotateCw, Smartphone, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../../settingsUi'
import { cn } from '@utils/cn'

interface AppVaultSyncPopoverProps {
  onScanDevice: () => void
  onPickManual: () => void
  hasSpace: boolean
}

export const AppVaultSyncPopover: React.FC<AppVaultSyncPopoverProps> = ({
  onScanDevice,
  onPickManual,
  hasSpace,
}) => {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground/80 hover:text-foreground"
          aria-label={t('credentialVault.toolbar.sync', { defaultValue: '添加' })}
          title={t('credentialVault.toolbar.sync', { defaultValue: '添加' })}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        <div>
          <h4 className="text-body font-medium text-foreground">
            {t('credentialVault.appSync.title', { defaultValue: '添加应用凭据' })}
          </h4>
          <p className={cn(SETTINGS_HINT, 'mt-0.5')}>
            {t('credentialVault.appSync.subtitle', { defaultValue: '从当前工作空间关联设备扫描已装 App，或手动添加' })}
          </p>
        </div>

        <div className="space-y-1">
          <button
            type="button"
            disabled={!hasSpace}
            onClick={() => {
              if (!hasSpace) return
              setOpen(false)
              onScanDevice()
            }}
            className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed')}
          >
            <Smartphone className="h-3.5 w-3.5" />
            <span>{t('credentialVault.appSync.scanDevice', { defaultValue: '从设备扫描已装 App' })}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onPickManual()
            }}
            className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors')}
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>{t('credentialVault.appSync.manual', { defaultValue: '手动添加应用' })}</span>
          </button>
        </div>

        {!hasSpace && (
          <p className={SETTINGS_HINT}>
            {t('credentialVault.appSync.noSpaceHint', { defaultValue: '设备扫描需要先选中一个 Space' })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
