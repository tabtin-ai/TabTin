import type { TFunction } from 'i18next'
import type { AgentModeName } from '../../../stores/chat/shared/types'

export function resolveChatInputPlaceholder(input: {
  t: TFunction
  agentGatewayStatus: string
  isStreaming: boolean
  disabled: boolean
  disabledReason: string | null
  isVoiceActive: boolean
  pendingApproval: boolean
  pendingAskUser: boolean
  agentMode: AgentModeName
  /** 当前 Agent 展示名；缺省回落 input.defaultAgentName（小Tin / Tin） */
  agentDisplayName?: string | null
}): string {
  if (input.isVoiceActive) return input.t('voice.listening')
  if (input.disabled) {
    return input.t(`input.disabled_${input.disabledReason}`, { defaultValue: input.t('input.placeholderDisabled') })
  }
  if (input.pendingApproval) return input.t('input.placeholderPending')
  if (input.pendingAskUser) return input.t('input.placeholderAskUserPending')
  if (input.isStreaming) return input.t('input.placeholderStreaming')
  if (input.agentMode === 'ask') return input.t('input.placeholderAsk')
  if (input.agentMode === 'plan') return input.t('input.placeholderPlan')
  if (input.agentMode === 'study') return input.t('input.placeholderStudy')
  if (input.agentMode === 'group') return input.t('input.placeholderGroup')
  const agentName = input.agentDisplayName?.trim() || input.t('input.defaultAgentName')
  return input.t('input.placeholderDefault', { agentName })
}
