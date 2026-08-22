import React from 'react'
import { Bot } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTableStore } from '@stores/useTableStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { getAgentWorkspaceDefaults } from '@/crawlspace/workspace-defaults'
import { getOrganizationBrowserPartition } from '@stores/browserEnvSnapshot'
import { useTranslation } from 'react-i18next'

export const AgentOrganizationButton: React.FC = () => {
  const { t } = useTranslation('sidebar')
  const selectTable = useTableStore((s) => s.selectTable)
  const createWorkspace = useCrawlTabStore((s) => s.createWorkspace)

  const handleClick = () => {
    selectTable(null)

    // 入口 (匿名 / 未关联 Space) 走当前 Organization 的共享浏览器罐（Phase 3a）；
    // 与桌面 + 同 organization 下所有 Space/对话共享同一份 cookie。无 organization 时
    // getOrganizationBrowserPartition 回落默认 env partition。
    const defaults = getAgentWorkspaceDefaults()
    createWorkspace({
      profile: defaults.profile,
      runPrefix: defaults.runPrefix,
      uiConfig: defaults.uiConfig,
      partition: getOrganizationBrowserPartition(),
    })
  }

  return (
    <Button
      variant="outline"
      className="w-full justify-start gap-2 h-9 border-success bg-success/10 hover:bg-success/20 hover:border-success transition-all duration-200 group"
      onClick={handleClick}
    >
      <Bot className="h-4 w-4 text-success group-hover:text-success transition-colors" />
      <span className="text-success font-medium group-hover:text-success">
        {t('actions.agentOrganization')}
      </span>
    </Button>
  )
}
