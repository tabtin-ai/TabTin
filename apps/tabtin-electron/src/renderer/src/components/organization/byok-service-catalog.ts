/** 统一「添加模型服务」目录：只映射当前已有 plan / API preset，不新增 Provider 类型。 */

import { BYOK_API_PROVIDER_OPTIONS } from './byok-api-provider-options'
import { BYOK_PLAN_PRESETS, type ByokPlanPreset } from './byok-plan-presets'
import { OPENAI_CODEX_BYOK_UI_ENABLED } from '@/utils/featureFlags'

export const OPENROUTER_PRESET_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENAI_COMPATIBLE_SERVICE_ID = 'openai_compatible'
export const OPENAI_OFFICIAL_SERVICE_ID = 'openai'
export const OPENROUTER_SERVICE_ID = 'openrouter'
export const CHATGPT_CODEX_SERVICE_ID = 'chatgpt_codex'

export type ByokServiceKind = 'plan' | 'api' | 'openai_compatible' | 'openrouter' | 'chatgpt_codex'
export type ByokServiceGroup = 'recommended' | 'more' | 'other'

export type ByokServiceItem = {
  id: string
  kind: ByokServiceKind
  group: ByokServiceGroup
  labelKey: string
  subtitleKey?: string
  iconKey?: string
  providerName?: string
  preset?: ByokPlanPreset
  defaultBaseUrl?: string
  hideBaseUrl?: boolean
}

const RECOMMENDED_PLAN_IDS = [
  'volcengine_coding_plan',
  'kimi_coding',
  'minimax_token_plan',
  'dashscope_coding_plan',
  'zhipu_coding_plan',
] as const

const RECOMMENDED_API_IDS = ['deepseek', 'openai'] as const
const MORE_API_IDS = ['claude', 'gemini', 'qwen', 'moonshot', 'minimax', 'volcengine'] as const

function apiOption(providerName: string) {
  return BYOK_API_PROVIDER_OPTIONS.find((option) => option.provider_name === providerName)
}

function planItem(presetId: string): ByokServiceItem | null {
  const preset = BYOK_PLAN_PRESETS.find((item) => item.id === presetId)
  if (!preset) return null
  return {
    id: preset.id,
    kind: 'plan',
    group: 'recommended',
    labelKey: preset.vendorLabelKey,
    subtitleKey: preset.subtitleKey,
    iconKey: preset.icon_key,
    providerName: preset.provider_name,
    preset,
    defaultBaseUrl: preset.base_url,
    hideBaseUrl: true,
  }
}

function apiItem(
  providerName: string,
  group: Extract<ByokServiceGroup, 'recommended' | 'more'>,
): ByokServiceItem | null {
  const option = apiOption(providerName)
  if (!option) return null
  return {
    id: option.provider_name,
    kind: 'api',
    group,
    labelKey: providerName === 'openai'
      ? 'llm.serviceCatalog.openaiOfficial.label'
      : option.vendorLabelKey,
    subtitleKey: providerName === 'openai'
      ? 'llm.serviceCatalog.openaiOfficial.subtitle'
      : option.subtitleKey,
    providerName: option.provider_name,
  }
}

export function getByokServiceCatalog(
  includeOpenAICodex: boolean = OPENAI_CODEX_BYOK_UI_ENABLED,
): ByokServiceItem[] {
  const items: ByokServiceItem[] = []

  for (const presetId of RECOMMENDED_PLAN_IDS) {
    const item = planItem(presetId)
    if (item) items.push(item)
  }

  for (const providerName of RECOMMENDED_API_IDS) {
    const item = apiItem(providerName, 'recommended')
    if (item) items.push(item)
  }

  items.push({
    id: OPENROUTER_SERVICE_ID,
    kind: 'openrouter',
    group: 'recommended',
    labelKey: 'llm.serviceCatalog.openrouter.label',
    subtitleKey: 'llm.serviceCatalog.openrouter.subtitle',
    iconKey: 'openrouter',
    providerName: 'openai',
    defaultBaseUrl: OPENROUTER_PRESET_BASE_URL,
  })

  if (includeOpenAICodex) {
    items.push({
      id: CHATGPT_CODEX_SERVICE_ID,
      kind: 'chatgpt_codex',
      group: 'recommended',
      labelKey: 'llm.codex.vendorLabel',
      subtitleKey: 'llm.codex.description',
      iconKey: 'openai',
      providerName: 'openai',
    })
  }

  for (const providerName of MORE_API_IDS) {
    const item = apiItem(providerName, 'more')
    if (item) items.push(item)
  }

  items.push({
    id: OPENAI_COMPATIBLE_SERVICE_ID,
    kind: 'openai_compatible',
    group: 'other',
    labelKey: 'llm.serviceCatalog.openaiCompatible.label',
    subtitleKey: 'llm.serviceCatalog.openaiCompatible.subtitle',
    providerName: 'openai',
    defaultBaseUrl: '',
  })

  return items
}

export function findByokService(
  serviceId: string,
  includeOpenAICodex: boolean = OPENAI_CODEX_BYOK_UI_ENABLED,
): ByokServiceItem | undefined {
  return getByokServiceCatalog(includeOpenAICodex).find((item) => item.id === serviceId)
}

export function findPlanPresetByProviderKey(providerKey: string): ByokPlanPreset | undefined {
  return BYOK_PLAN_PRESETS.find((preset) => preset.provider_key === providerKey)
}

export function resolveLegacyServiceId(params: {
  mode?: 'plan' | 'api'
  tabId?: string
}): string | undefined {
  const { mode, tabId } = params
  if (!tabId) {
    if (mode === 'plan') return 'volcengine_coding_plan'
    if (mode === 'api') return OPENAI_COMPATIBLE_SERVICE_ID
    return undefined
  }
  if (tabId === 'chatgpt_codex') return CHATGPT_CODEX_SERVICE_ID
  if (mode === 'api' && tabId === 'openai') return OPENAI_COMPATIBLE_SERVICE_ID
  return tabId
}
