/**
 * AgentToolsPanel — AI 分身「工具携带集」。
 *
 * 作用域是当前 Agent：只决定本分身是否携带某条 MCP，不再做「启用到哪些 Agent」多选。
 * 「添加工具」对齐技能携带集：从「技能和连接器 → 连接器」库
 * （推荐 + 组织精选 + 我的）里挑还未挂到当前分身的项。
 * 设备级多 Agent 配置 / 手动 JSON 仍在「设置 → 设备 → MCP 连接」。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { McpPanel } from '@components/space-settings/McpPanel'

interface AgentToolsPanelProps {
  organizationId: string
  /** 当前分身；携带开关只作用于该 Agent */
  agentId: string
  canManage?: boolean
  /** 外层已有 drill-in / Section 标题时隐藏 McpPanel 自带页眉 */
  hideHeader?: boolean
}

export const AgentToolsPanel: React.FC<AgentToolsPanelProps> = ({
  organizationId,
  agentId,
  canManage = true,
  hideHeader = true,
}) => {
  const { t } = useTranslation('settings')

  return (
    <McpPanel
      canManage={canManage}
      organizationId={organizationId}
      scopeAgentId={agentId}
      hideHeader={hideHeader}
      title={t('myAgents.toolsTitle', { defaultValue: '工具携带集' })}
      subtitle={t('myAgents.toolsSubtitle', {
        defaultValue: '这个 AI 分身会携带的连接器。点「添加工具」从连接器库里挑。',
      })}
    />
  )
}
