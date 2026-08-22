/**
 * AgentSkillsPreview — Agent 档案页「技能」模块行预览（ W3）。
 *
 * 独立于 AgentSkillsPanel 的轻量文件：AgentProfilePane 首屏就要渲染预览，
 * 不应连带拉起技能面板整条依赖链（挑选器 / 配置 dialog / 指纹判定等）。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentSkillsQuery } from '@/hooks/queries/agentSkills'
import { resolveSkillCarryTitle } from '@components/context-space/skills/skillSlug'
import { useSpaceExecutionAgent } from './hooks/useSpaceExecutionAgent'
import { ItemList } from './profile/ProfileModuleRow'

const PREVIEW_LIMIT = 4

export const AgentSkillsPreview: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const { t } = useTranslation('context')
  const { agentId } = useSpaceExecutionAgent(spaceId)
  const { data: links } = useAgentSkillsQuery(agentId)
  const enabledLinks = (links ?? []).filter(link => link.enabled)

  if (!agentId || enabledLinks.length === 0) {
    return (
      <p className="text-body text-muted-foreground/60 leading-relaxed">
        {t('skills.agentSkills.previewEmpty', { defaultValue: '还没教它任何本事' })}
      </p>
    )
  }

  return (
    <ItemList
      items={enabledLinks.slice(0, PREVIEW_LIMIT).map(link => resolveSkillCarryTitle({
        name: link.name,
        skill_key: link.skill_canonical_key,
      }))}
      remaining={Math.max(0, enabledLinks.length - PREVIEW_LIMIT)}
    />
  )
}
