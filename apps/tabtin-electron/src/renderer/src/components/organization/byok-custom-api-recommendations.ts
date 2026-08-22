/** 自定义 API 接入时，按 provider 类型展示的常用模型快捷选项 */

export type ByokCustomApiModelRecommendation = {
  model_name: string
  display_name: string
  max_tokens: number
  supports_vision?: boolean
}

export const BYOK_CUSTOM_API_MODEL_RECOMMENDATIONS: Record<string, ByokCustomApiModelRecommendation[]> = {
  qwen: [],
  volcengine: [],
  zhipu: [],
  minimax: [],
}

export function getCustomApiModelRecommendations(providerName: string): ByokCustomApiModelRecommendation[] {
  return BYOK_CUSTOM_API_MODEL_RECOMMENDATIONS[providerName] ?? []
}
