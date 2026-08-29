import { OrganizationLlmApiService } from '@/services/organizationLlmApi'
import { getCustomApiModelRecommendations } from './byok-custom-api-recommendations'

export async function provisionByokApi(params: {
  organizationId: string
  providerName: string
  baseUrl: string
  apiKey: string
  scope: 'organization' | 'user'
  providerKey?: string
  displayName?: string
}): Promise<{ providerId: string; modelsCreated: number }> {
  const {
    organizationId,
    providerName,
    baseUrl,
    apiKey,
    scope,
    // 旧客户端不传 providerKey 时保持 provider_key = provider_name（第一套官方连接）。
    providerKey = providerName,
    displayName,
  } = params

  const created = await OrganizationLlmApiService.createProvider(organizationId, {
    provider_name: providerName,
    provider_key: providerKey,
    display_name: displayName,
    base_url: baseUrl,
    api_key: apiKey.trim(),
    scope,
  })

  const recommendations = getCustomApiModelRecommendations(providerName)
  let modelsCreated = 0
  for (const model of recommendations) {
    await OrganizationLlmApiService.createModel(organizationId, {
      provider_id: created.provider_id,
      model_name: model.model_name,
      display_name: model.display_name,
      base_url: baseUrl,
      max_tokens: model.max_tokens,
      supports_streaming: true,
      supports_vision: model.supports_vision ?? false,
    })
    modelsCreated += 1
  }

  return { providerId: created.provider_id, modelsCreated }
}
