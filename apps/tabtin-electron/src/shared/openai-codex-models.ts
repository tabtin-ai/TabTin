export type OpenAICodexModel = {
  id: string
  displayName: string
  /**
   * 官方 API 上下文窗口（tokens）。
   * @see https://developers.openai.com/api/docs/models/<id>
   */
  contextWindowTokens: number
  /** 官方 API 最大输出 tokens。 */
  maxOutputTokens: number
}

/**
 * ChatGPT 账号登录 Codex 时可用的模型（非 API Key）。
 * ID 以 OpenAI Learn「Choose a model」为准；`*-codex` 旧变体对 ChatGPT 登录常直接 400。
 * 窗口 / max_output 按 OpenAI model docs 按模型填写，禁止统一写死。
 * @see https://learn.chatgpt.com/docs/models
 * @see https://developers.openai.com/api/docs/models
 */
export const OPENAI_CODEX_MODELS: readonly OpenAICodexModel[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
  },
]

/** 未知 Codex 模型 id 的保守兜底（与当前主力家族官方窗口一致）。 */
const FALLBACK_CODEX_CONTEXT_WINDOW_TOKENS = 1_050_000
const FALLBACK_CODEX_MAX_OUTPUT_TOKENS = 128_000

export function isOpenAICodexModel(modelId: string): boolean {
  return OPENAI_CODEX_MODELS.some((model) => model.id === modelId)
}

export function getOpenAICodexModel(modelId: string): OpenAICodexModel | undefined {
  return OPENAI_CODEX_MODELS.find((model) => model.id === modelId)
}

/**
 * 解析 Codex 本地模型的窗口 / max_output。
 * 已知 id 走表；未知 id（未来 IPC 增补）用家族兜底，避免再退回 128K 假窗口。
 */
export function resolveOpenAICodexModelCapabilities(modelId: string): {
  contextWindowTokens: number
  maxOutputTokens: number
} {
  const hit = getOpenAICodexModel(modelId)
  return {
    contextWindowTokens: hit?.contextWindowTokens ?? FALLBACK_CODEX_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: hit?.maxOutputTokens ?? FALLBACK_CODEX_MAX_OUTPUT_TOKENS,
  }
}
