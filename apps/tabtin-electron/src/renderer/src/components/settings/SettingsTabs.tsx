import React from 'react'
import { X } from 'lucide-react'
import { cn } from '@utils/cn'
import { SETTINGS_HOVER_ACTION } from './settingsUi'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'

export type SettingsTab = {
  key: string
  label: string
  icon?: React.ReactNode
  closable?: boolean
}

interface SettingsTabsProps {
  tabs: SettingsTab[]
  activeKey: string | null
  onSelect: (key: string) => void
  onClose?: (key: string) => void
  className?: string
}

export const SettingsTabs: React.FC<SettingsTabsProps> = ({
  tabs,
  activeKey,
  onSelect,
  onClose,
  className
}) => {
  const { t } = useTranslation('common')
  return (
    <ScrollArea
      className={cn('w-full pb-2', className)}
      scrollBar="horizontal"
    >
      <div className="inline-flex w-fit min-w-0 items-center gap-1 rounded-[12px] bg-foreground/[0.025] p-1 dark:bg-black/10">
        {tabs.map(tab => {
          const isActive = tab.key === activeKey
          return (
            <button
              key={tab.key}
              className={cn(
                'group relative flex h-7 shrink-0 items-center gap-1.5 rounded-interactive px-2.5 text-body transition-colors',
                isActive
                  ? 'bg-foreground/[0.06] font-medium text-accent-text dark:bg-foreground/[0.08]'
                  : 'font-normal text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]'
              )}
              onClick={() => onSelect(tab.key)}
            >
              {tab.icon && (
                <span className={cn(
                  'shrink-0 transition-colors',
                  isActive ? 'text-accent-text' : 'text-muted-foreground/60 group-hover:text-foreground'
                )}>
                  {tab.icon}
                </span>
              )}
              <span>{tab.label}</span>
              {tab.closable && onClose && (
                <span
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'ml-1 rounded-interactive p-0.5 transition-all hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                    isActive ? 'opacity-100' : SETTINGS_HOVER_ACTION
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    onClose(tab.key)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation()
                      onClose(tab.key)
                    }
                  }}
                  title={t('close')}
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}
