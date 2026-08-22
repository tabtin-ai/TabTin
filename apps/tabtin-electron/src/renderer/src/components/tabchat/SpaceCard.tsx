/**
 * SpaceCard — Space 链接卡片
 *
 * 在 IM 消息中渲染的富文本卡片，点击跳转到 Space。
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Bot } from 'lucide-react'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'

interface Props {
  spaceId: string
  name: string
  icon?: string
}

export const SpaceCard: React.FC<Props> = ({ spaceId, name, icon }) => {
  const { t } = useTranslation('tabchat')
  const closeSettings = useSettingsSpaceStore(state => state.closeSettings)

  const handleClick = useCallback(() => {
    closeSettings()
    void ensureSpaceSelectedWithFeedback(spaceId, {
      failureToast: {
        title: t('spaceCardOpenFailed', { defaultValue: '无法打开该 Agent' }),
        description: t('spaceCardOpenFailedDesc', {
          defaultValue: '该 Agent 可能已归档、删除，或数据尚未同步完成',
        }),
        variant: 'destructive',
      },
    })
  }, [closeSettings, spaceId, t])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-background/60 border border-border/40 hover:bg-muted/30 hover:border-accent/30 transition-all cursor-pointer text-left w-full max-w-[280px]"
    >
      <div className="h-8 w-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0 overflow-hidden">
        {icon?.startsWith('http') ? (
          <img src={icon} alt={name} className="h-full w-full rounded-lg object-cover" />
        ) : name?.charAt(0) ? (
          <span className="text-accent text-body font-semibold">{name.charAt(0)}</span>
        ) : (
          <Bot className="h-4 w-4 text-accent" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-body font-medium text-foreground truncate">{name}</div>
        <div className="text-caption text-muted-foreground">{t('spaceCard')}</div>
      </div>
      <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
    </button>
  )
}
