import { OrganizationLlmApiService } from '@/services/organizationLlmApi'
import type { ByokPlanPreset } from './byok-plan-presets'

export async function provisionByokPlan(params: {
  organizationId: string
  preset: ByokPlanPreset
  apiKey: string
  scope: 'organization' | 'user'
  /** 可覆盖套餐默认端点（中转站等，） */
  baseUrl?: string
}): Promise<{ providerId: string; modelsCreated: number }> {
  const { organizationId, preset, apiKey, scope, baseUrl } = params
  const resolvedBaseUrl = (baseUrl ?? preset.base_url).trim()

  const created = await OrganizationLlmApiService.createProvider(organizationId, {
    provider_name: preset.provider_name,
    provider_key: preset.provider_key,
    display_name: preset.display_name,
    base_url: resolvedBaseUrl,
    api_key: apiKey.trim(),
    scope,
  })

  let modelsCreated = 0
  for (const model of preset.models) {
    await OrganizationLlmApiService.createModel(organizationId, {
      provider_id: created.provider_id,
      model_name: model.model_name,
      display_name: model.display_name,
      base_url: resolvedBaseUrl,
      max_tokens: model.max_tokens,
      supports_streaming: true,
      supports_vision: model.supports_vision ?? false,
    })
    modelsCreated += 1
  }

  return { providerId: created.provider_id, modelsCreated }
}
