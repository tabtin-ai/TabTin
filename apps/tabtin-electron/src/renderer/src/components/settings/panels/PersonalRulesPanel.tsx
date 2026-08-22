/**
 * PersonalRulesPanel —— 个人「通用规则」（两层规则里的个人层）。
 *
 * 写 UserProfile.personal_rules（per-User 全局，跨 Organization）。运行时与 Agent
 * 专属规则一起进入 system prompt；冲突时由 Agent 专属规则覆盖，不冲突则叠加。
 * 空串=清空个人层。
 */
import React, { useCallback } from 'react'
import { UserCog } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { apiService } from '@/services/api'
import { setCachedPersonalRules } from '@/services/personalRulesRuntimeCache'
import { pushHostTurnState } from '@/services/agentConfigCacheApi'
import { RulesEditorPanel } from './RulesEditorPanel'

interface PersonalRulesPanelProps {
  /** 嵌入模式：只渲染规则编辑器主体，由外层「AI 设置」页提供页眉与分组标题。 */
  embedded?: boolean
}

export const PersonalRulesPanel: React.FC<PersonalRulesPanelProps> = ({ embedded = false }) => {
  const { t } = useTranslation('settings')
  const userId = useAuthStore((state) => state.user?.id)
  const ownerKey = userId != null ? String(userId) : 'anonymous'

  const load = useCallback(async () => {
    const res = await apiService.getPersonalRules()
    setCachedPersonalRules(res?.personal_rules, ownerKey)
    return res?.personal_rules ?? ''
  }, [ownerKey])

  const save = useCallback(async (value: string) => {
    await apiService.updatePersonalRules(value)
    setCachedPersonalRules(value, ownerKey)
    // 保存后刷新 agentCache，让 IPC 主路径 sendMessage 读到最新 personal_rules
    // （runtime 缓存键含 personalRules，下一发消息会触发重建）。
    const { agentCache, loadAgent } = useSpaceStore.getState()
    await Promise.all(
      Object.keys(agentCache).map((agentId) => loadAgent(agentId, { force: true })),
    )
    // 若当前 Electron 连的是尚未部署  后端修复的服务器，Agent API 仍不会返回
    // personal_rules；刷新后要把刚保存的个人层规则补回缓存，避免下一轮发送丢规则。
    useSpaceStore.setState((state) => {
      const nextAgentCache = Object.fromEntries(
        Object.entries(state.agentCache).map(([agentId, agent]) => [
          agentId,
          agent.user_id == null || String(agent.user_id) === ownerKey
            ? { ...agent, personal_rules: value }
            : agent,
        ]),
      )
      return {
        agentCache: nextAgentCache,
        selectedAgent: state.selectedAgent
          && (state.selectedAgent.user_id == null || String(state.selectedAgent.user_id) === ownerKey)
          ? { ...state.selectedAgent, personal_rules: value }
          : state.selectedAgent,
      }
    })
    // loadAgent 推送可能仍缺 personal_rules（旧后端）；补丁后显式推 Host turn 状态。
    for (const agent of Object.values(useSpaceStore.getState().agentCache)) {
      if (agent.user_id != null && String(agent.user_id) !== ownerKey) continue
      pushHostTurnState({
        agent: {
          id: agent.id,
          personal_rules: value,
        },
      })
    }
  }, [ownerKey])

  return (
    <RulesEditorPanel
      embedded={embedded}
      icon={<UserCog className="h-4 w-4" />}
      title={t('personalRules.title', { defaultValue: '通用规则' })}
      subtitle={t('personalRules.subtitle', {
        defaultValue: '对你所有 Agent 生效的口吻偏好，如称呼方式、回复语言、默认沟通风格等。',
      })}
      placeholder={t('personalRules.placeholder', {
        defaultValue: '例如：用中文回复；先给结论再讲原因；不要堆砌技术黑话。',
      })}
      // 嵌入「AI 设置」时说明已并入分区标题 ⓘ；独立页仍展示 hint。
      hint={embedded
        ? undefined
        : t('personalRules.hint', {
            defaultValue: '这是最底层的个人偏好；单个 Agent 的专属规则会在其之上叠加并优先。',
          })}
      load={load}
      save={save}
    />
  )
}

export default PersonalRulesPanel
