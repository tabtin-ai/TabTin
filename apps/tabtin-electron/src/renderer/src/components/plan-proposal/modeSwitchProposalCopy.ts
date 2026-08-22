import type { TFunction } from 'i18next'
import type { AgentModeName } from '@stores/chat/shared/types'

export function modeSwitchTargetLabel(
  t: TFunction<'chat'>,
  mode: AgentModeName,
): string {
  return t(`agentMode.${mode}.name`)
}

export function modeSwitchProposalTitle(
  t: TFunction<'chat'>,
  targetMode: AgentModeName,
): string {
  return t('modeSwitchProposal.title', {
    targetMode: modeSwitchTargetLabel(t, targetMode),
  })
}

export function modeSwitchProposalDescription(
  t: TFunction<'chat'>,
  targetMode: AgentModeName,
  reason: string,
): string {
  const hasReason = reason.trim().length > 0
  if (targetMode === 'plan') {
    return hasReason
      ? t('modeSwitchProposal.descriptionToPlan', { reason })
      : t('modeSwitchProposal.descriptionToPlanNoReason')
  }
  if (targetMode === 'agent') {
    return hasReason
      ? t('modeSwitchProposal.descriptionToAgent', { reason })
      : t('modeSwitchProposal.descriptionToAgentNoReason')
  }
  return hasReason
    ? t('modeSwitchProposal.descriptionGeneric', {
        reason,
        targetMode: modeSwitchTargetLabel(t, targetMode),
      })
    : t('modeSwitchProposal.descriptionGenericNoReason', {
        targetMode: modeSwitchTargetLabel(t, targetMode),
      })
}

