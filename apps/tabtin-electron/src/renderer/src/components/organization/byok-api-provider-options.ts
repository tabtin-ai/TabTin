/** 自定义 API（按量）接入 — Tab 是协议类型（LLMProvider.name），不是连接身份。 */

export type ByokApiProviderOption = {
  /** 协议类型：写入 LLMProvider.name，供 Runtime 按 name 分发 */
  provider_name: string
  /** i18n：协议短名（芯片 / Tab） */
  vendorLabelKey: string
  /** i18n：picker 列表副标题 */
  subtitleKey: string
}

export const BYOK_API_PROVIDER_OPTIONS: ByokApiProviderOption[] = [
  {
    provider_name: 'openai',
    vendorLabelKey: 'llm.apiProviders.openai.vendorLabel',
    subtitleKey: 'llm.apiProviders.openai.subtitle',
  },
  {
    provider_name: 'claude',
    vendorLabelKey: 'llm.apiProviders.claude.vendorLabel',
    subtitleKey: 'llm.apiProviders.claude.subtitle',
  },
  {
    provider_name: 'qwen',
    vendorLabelKey: 'llm.apiProviders.qwen.vendorLabel',
    subtitleKey: 'llm.apiProviders.qwen.subtitle',
  },
  {
    provider_name: 'moonshot',
    vendorLabelKey: 'llm.apiProviders.moonshot.vendorLabel',
    subtitleKey: 'llm.apiProviders.moonshot.subtitle',
  },
  {
    provider_name: 'minimax',
    vendorLabelKey: 'llm.apiProviders.minimax.vendorLabel',
    subtitleKey: 'llm.apiProviders.minimax.subtitle',
  },
  {
    provider_name: 'volcengine',
    vendorLabelKey: 'llm.apiProviders.volcengine.vendorLabel',
    subtitleKey: 'llm.apiProviders.volcengine.subtitle',
  },
  {
    provider_name: 'zhipu',
    vendorLabelKey: 'llm.apiProviders.zhipu.vendorLabel',
    subtitleKey: 'llm.apiProviders.zhipu.subtitle',
  },
  {
    provider_name: 'deepseek',
    vendorLabelKey: 'llm.apiProviders.deepseek.vendorLabel',
    subtitleKey: 'llm.apiProviders.deepseek.subtitle',
  },
  {
    provider_name: 'gemini',
    vendorLabelKey: 'llm.apiProviders.gemini.vendorLabel',
    subtitleKey: 'llm.apiProviders.gemini.subtitle',
  },
]
