/** BYOK「Coding 订阅 / 会员」一键接入预设（OpenAI 兼容，用户只需填 Key） */

export type ByokPlanPresetModel = {
  model_name: string
  display_name: string
  max_tokens: number
  supports_vision?: boolean
}

export type ByokPlanPreset = {
  id: string
  /** 卡片标题 */
  titleKey: string
  /** 卡片副标题 */
  subtitleKey: string
  /** 接入弹窗说明 */
  connectDescKey: string
  /** 接入弹窗文档链接文案 */
  docsLinkKey: string
  /** 接入弹窗 Key 提示 */
  apiKeyHintKey: string
  /** 后端 LLMProvider.name（LiteLLM 路由用） */
  provider_name: string
  /** 组织内唯一 provider_key */
  provider_key: string
  display_name: string
  base_url: string
  docs_url: string
  api_key_placeholder_key: string
  /** 创建后自动添加的模型 */
  models: ByokPlanPresetModel[]
  /** 卡片角标：推荐套餐 */
  recommended?: boolean
  /** 厂家短名（芯片展示） */
  vendorLabelKey: string
  /** 品牌图标 stem（``provider-icons/<key>.svg``） */
  icon_key: string
}

/** 模型与端点见 Kimi Code 文档：https://www.kimi.com/code/docs/third-party-tools/codex.html */
export const BYOK_PLAN_PRESETS: ByokPlanPreset[] = [
  {
    id: 'volcengine_coding_plan',
    titleKey: 'llm.planPresets.volcengineCodingPlan.title',
    subtitleKey: 'llm.planPresets.volcengineCodingPlan.subtitle',
    connectDescKey: 'llm.planPresets.volcengineCodingPlan.connectDesc',
    docsLinkKey: 'llm.planPresets.volcengineCodingPlan.docsLink',
    apiKeyHintKey: 'llm.planPresets.volcengineCodingPlan.apiKeyHint',
    provider_name: 'volcengine',
    provider_key: 'volcengine_coding_plan',
    display_name: '火山方舟 Coding Plan',
    base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    docs_url: 'https://docs.volcengine.com/docs/82379/1928261?lang=zh',
    api_key_placeholder_key: 'llm.planPresets.volcengineCodingPlan.apiKeyPlaceholder',
    recommended: true,
    vendorLabelKey: 'llm.planPresets.volcengineCodingPlan.vendorLabel',
    icon_key: 'doubao',
    models: [],
  },
  {
    id: 'kimi_coding',
    titleKey: 'llm.planPresets.kimiCoding.title',
    subtitleKey: 'llm.planPresets.kimiCoding.subtitle',
    connectDescKey: 'llm.planPresets.kimiCoding.connectDesc',
    docsLinkKey: 'llm.planPresets.kimiCoding.docsLink',
    apiKeyHintKey: 'llm.planPresets.kimiCoding.apiKeyHint',
    provider_name: 'moonshot',
    provider_key: 'kimi_coding',
    display_name: 'Kimi For Coding',
    base_url: 'https://api.kimi.com/coding/v1',
    docs_url: 'https://www.kimi.com/code/docs/third-party-tools/codex.html',
    api_key_placeholder_key: 'llm.planPresets.kimiCoding.apiKeyPlaceholder',
    vendorLabelKey: 'llm.planPresets.kimiCoding.vendorLabel',
    icon_key: 'kimi',
    models: [],
  },
  {
    id: 'minimax_token_plan',
    titleKey: 'llm.planPresets.minimaxTokenPlan.title',
    subtitleKey: 'llm.planPresets.minimaxTokenPlan.subtitle',
    connectDescKey: 'llm.planPresets.minimaxTokenPlan.connectDesc',
    docsLinkKey: 'llm.planPresets.minimaxTokenPlan.docsLink',
    apiKeyHintKey: 'llm.planPresets.minimaxTokenPlan.apiKeyHint',
    provider_name: 'minimax',
    provider_key: 'minimax_token_plan',
    display_name: 'MiniMax Token Plan',
    base_url: 'https://api.minimaxi.com/anthropic',
    docs_url: 'https://platform.minimaxi.com/docs/token-plan/quickstart',
    api_key_placeholder_key: 'llm.planPresets.minimaxTokenPlan.apiKeyPlaceholder',
    vendorLabelKey: 'llm.planPresets.minimaxTokenPlan.vendorLabel',
    icon_key: 'minimax',
    models: [],
  },
  {
    id: 'dashscope_coding_plan',
    titleKey: 'llm.planPresets.dashscopeCodingPlan.title',
    subtitleKey: 'llm.planPresets.dashscopeCodingPlan.subtitle',
    connectDescKey: 'llm.planPresets.dashscopeCodingPlan.connectDesc',
    docsLinkKey: 'llm.planPresets.dashscopeCodingPlan.docsLink',
    apiKeyHintKey: 'llm.planPresets.dashscopeCodingPlan.apiKeyHint',
    provider_name: 'qwen',
    provider_key: 'dashscope_coding_plan',
    display_name: '百炼 Coding Plan',
    base_url: 'https://coding.dashscope.aliyuncs.com/v1',
    docs_url: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    api_key_placeholder_key: 'llm.planPresets.dashscopeCodingPlan.apiKeyPlaceholder',
    vendorLabelKey: 'llm.planPresets.dashscopeCodingPlan.vendorLabel',
    icon_key: 'qwen',
    models: [],
  },
  {
    id: 'zhipu_coding_plan',
    titleKey: 'llm.planPresets.zhipuCodingPlan.title',
    subtitleKey: 'llm.planPresets.zhipuCodingPlan.subtitle',
    connectDescKey: 'llm.planPresets.zhipuCodingPlan.connectDesc',
    docsLinkKey: 'llm.planPresets.zhipuCodingPlan.docsLink',
    apiKeyHintKey: 'llm.planPresets.zhipuCodingPlan.apiKeyHint',
    provider_name: 'zhipu',
    provider_key: 'zhipu_coding_plan',
    display_name: 'GLM Coding Plan',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    docs_url: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start',
    api_key_placeholder_key: 'llm.planPresets.zhipuCodingPlan.apiKeyPlaceholder',
    vendorLabelKey: 'llm.planPresets.zhipuCodingPlan.vendorLabel',
    icon_key: 'zhipu',
    models: [],
  },
]

export function getByokPlanPreset(presetId: string): ByokPlanPreset | undefined {
  return BYOK_PLAN_PRESETS.find((preset) => preset.id === presetId)
}
