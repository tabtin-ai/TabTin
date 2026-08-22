import React from 'react'
import { Trans } from 'react-i18next'
import { openAgentHub } from '@/services/agentMemoryNavigation'

/**
 * 技能库页头副标题：说明 Agent 可用 Skill，并链到 AI 分身去添加。
 */
export function SkillsPageSubtitle(): React.ReactElement {
  return (
    <Trans
      ns="context"
      i18nKey="skills.subtitle"
      components={{
        agentHub: (
          <button
            type="button"
            className="inline p-0 m-0 border-0 bg-transparent font-inherit text-accent hover:text-accent/80 underline-offset-2 hover:underline transition-colors cursor-pointer"
            onClick={() => openAgentHub()}
          />
        ),
      }}
    />
  )
}
