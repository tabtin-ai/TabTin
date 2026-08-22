/**
 * Agent 技能说明书：携带集详情和添加弹窗共用。
 * 只回答「会做什么 / 什么时候用 / 怎么叫」，不进技能库的编辑/版本页。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { CANVAS_TEXT_META, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { cn } from '@utils/cn'

export function splitSkillGuideCopy(description: string): {
  capability: string
  trigger: string | null
} {
  const text = description.replace(/\s+/g, ' ').trim()
  if (!text) return { capability: '', trigger: null }

  const triggerMatch = text.match(
    /(?:^|[。.!?\n])\s*((?:用户|User|When)[^。.!?\n]*(?:时(?:使用|激活|调用)|when (?:to )?(?:use|activate)).*)$/i,
  )
  if (triggerMatch && triggerMatch.index != null) {
    const trigger = triggerMatch[1].trim()
    const prefixLen = triggerMatch[0].length - triggerMatch[1].length
    const capability = text.slice(0, triggerMatch.index + prefixLen).replace(/[。.!\s]+$/, '').trim()
    if (capability) return { capability, trigger }
  }
  return { capability: text, trigger: null }
}

export const AgentSkillGuide: React.FC<{
  title: string
  description?: string
  slashCommand?: string
  groupLabel?: string
  emoji?: string
  footer?: React.ReactNode
}> = ({ title, description, slashCommand, groupLabel, emoji, footer }) => {
  const { t } = useTranslation('context')
  const { capability, trigger } = splitSkillGuideCopy(description || '')

  return (
    <div>
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 text-subtitle leading-none" aria-hidden>
          {emoji || '🔧'}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-subtitle font-semibold text-foreground">{title}</h3>
          {groupLabel ? (
            <span className="mt-1 inline-flex rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption text-muted-foreground/80">
              {groupLabel}
            </span>
          ) : null}
        </div>
      </div>

      {capability ? (
        <section className="mt-4 space-y-1">
          <h4 className={SETTINGS_GROUP_LABEL}>
            {t('skills.agentSkills.guideCapability', { defaultValue: '它会做什么' })}
          </h4>
          <p className={cn('leading-relaxed', CANVAS_TEXT_SECONDARY)}>
            {capability}
          </p>
        </section>
      ) : null}

      {trigger ? (
        <section className="mt-4 space-y-1">
          <h4 className={SETTINGS_GROUP_LABEL}>
            {t('skills.agentSkills.guideTrigger', { defaultValue: '什么时候会用' })}
          </h4>
          <p className={cn('leading-relaxed', CANVAS_TEXT_SECONDARY)}>
            {trigger}
          </p>
        </section>
      ) : null}

      {slashCommand ? (
        <section className="mt-4 space-y-1">
          <h4 className={SETTINGS_GROUP_LABEL}>
            {t('skills.agentSkills.guideInvoke', { defaultValue: '怎么叫它' })}
          </h4>
          <p className="font-mono text-body text-foreground">{slashCommand}</p>
          <p className={CANVAS_TEXT_META}>
            {t('skills.agentSkills.guideInvokeHint', {
              defaultValue: '对话里输入这个命令，或直接用上面的说法叫它。',
            })}
          </p>
        </section>
      ) : null}

      {!capability && !slashCommand ? (
        <p className={cn('mt-6', CANVAS_TEXT_SECONDARY)}>
          {t('skills.agentSkills.guideNoDetail', {
            defaultValue: '这份技能还没有更多说明。',
          })}
        </p>
      ) : null}

      {footer ? <div className="mt-3">{footer}</div> : null}
    </div>
  )
}

export const AgentSkillGuideEmpty: React.FC = () => {
  const { t } = useTranslation('context')
  return (
    <p className={cn('px-1 py-8', CANVAS_TEXT_SECONDARY)}>
      {t('skills.agentSkills.guideEmpty', {
        defaultValue: '从左侧选一个技能，看看它会做什么。',
      })}
    </p>
  )
}
