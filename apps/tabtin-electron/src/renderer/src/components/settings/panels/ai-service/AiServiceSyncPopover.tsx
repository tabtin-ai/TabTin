/**
 * AiServiceSyncPopover —— AI 服务 vault 的同步 ⟳ 下拉。
 *
 * 收纳：预设快速添加 + .env 粘贴 + 自定义服务。
 */

import React, { useState } from 'react'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@tabtin/smartsheet-ui'
import { ClipboardPaste, RotateCw, Sparkles, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SERVICE_PRESETS } from '../credentials/constants'
import { SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../../settingsUi'
import { cn } from '@utils/cn'

interface AiServiceSyncPopoverProps {
  /** 点预设触发创建对话框，预填该预设 */
  onPickPreset: (presetValue: string) => void
  /** 点 .env 粘贴 */
  onOpenEnvImport: () => void
  /** 点自定义服务（不预填预设） */
  onPickCustom: () => void
}

export const AiServiceSyncPopover: React.FC<AiServiceSyncPopoverProps> = ({
  onPickPreset,
  onOpenEnvImport,
  onPickCustom,
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
          aria-label={t('credentialVault.toolbar.sync', { defaultValue: '导入' })}
          title={t('credentialVault.toolbar.sync', { defaultValue: '导入' })}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        <div>
          <h4 className="text-body font-medium text-foreground">
            {t('credentialVault.aiSync.title', { defaultValue: '添加 AI 服务密钥' })}
          </h4>
          <p className={cn(SETTINGS_HINT, 'mt-0.5')}>
            {t('credentialVault.aiSync.subtitle', { defaultValue: '快速添加预设服务、批量从 .env 粘贴，或手动添加自定义服务' })}
          </p>
        </div>

        <div>
          <div className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground/80', 'mb-1.5')}>
            {t('credentialVault.aiSync.presetTitle', { defaultValue: '快速添加' })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SERVICE_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPickPreset(p.value)
                }}
                className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 hover:border-accent/30 hover:bg-accent/[0.05] transition-colors')}
              >
                <Sparkles className="h-3 w-3 text-accent/80" />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pt-2 border-t border-border/30 space-y-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onOpenEnvImport()
            }}
            className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors')}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>{t('credentialVault.aiSync.envPaste', { defaultValue: '从 .env 粘贴导入' })}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onPickCustom()
            }}
            className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors')}
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>{t('credentialVault.aiSync.customAdd', { defaultValue: '添加自定义服务' })}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
