import type { ByokPlanPreset } from './byok-plan-presets'
import { BYOK_PLAN_PRESETS } from './byok-plan-presets'
import { BYOK_API_PROVIDER_OPTIONS } from './byok-api-provider-options'
import { OPENAI_CODEX_BYOK_UI_ENABLED } from '@/utils/featureFlags'

export type ByokConnectPlanChannel = {
  kind: 'plan'
  tabId: string
  preset: ByokPlanPreset
}

export type ByokConnectCodexChannel = {
  kind: 'chatgpt_codex'
  tabId: 'chatgpt_codex'
  vendorLabelKey: string
}

export type ByokConnectSubscriptionChannel =
  | ByokConnectPlanChannel
  | ByokConnectCodexChannel

export type ByokConnectApiChannel = {
  kind: 'api'
  tabId: string
  providerName: string
  vendorLabelKey: string
  subtitleKey: string
}

export const DEFAULT_BYOK_PLAN_TAB_ID = 'volcengine_coding_plan'
export const DEFAULT_BYOK_API_TAB_ID = 'openai'
export const OPENAI_CODEX_TAB_ID = 'chatgpt_codex'

export function buildByokPlanChannels(
  includeOpenAICodex: boolean = OPENAI_CODEX_BYOK_UI_ENABLED,
): ByokConnectSubscriptionChannel[] {
  const channels: ByokConnectSubscriptionChannel[] = BYOK_PLAN_PRESETS.map((preset) => ({
    kind: 'plan',
    tabId: preset.id,
    preset,
  }))

  if (includeOpenAICodex) {
    channels.push({
      kind: 'chatgpt_codex',
      tabId: OPENAI_CODEX_TAB_ID,
      vendorLabelKey: 'llm.codex.vendorLabel',
    })
  }

  return channels
}

export function buildByokApiChannels(): ByokConnectApiChannel[] {
  return BYOK_API_PROVIDER_OPTIONS.map((option) => ({
    kind: 'api',
    tabId: option.provider_name,
    providerName: option.provider_name,
    vendorLabelKey: option.vendorLabelKey,
    subtitleKey: option.subtitleKey,
  }))
}

export function findByokPlanChannel(
  channels: ByokConnectSubscriptionChannel[],
  tabId: string,
): ByokConnectSubscriptionChannel | undefined {
  return channels.find((channel) => channel.tabId === tabId)
}

export function findByokApiChannel(
  channels: ByokConnectApiChannel[],
  tabId: string,
): ByokConnectApiChannel | undefined {
  return channels.find((channel) => channel.tabId === tabId)
}
