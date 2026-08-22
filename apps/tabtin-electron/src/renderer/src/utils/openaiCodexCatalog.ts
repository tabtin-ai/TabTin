import type { Model, ModelRuntimeControl } from '@tabtin/chat-client'
import { resolveOpenAICodexModelCapabilities } from '../../../shared/openai-codex-models'

type OpenAICodexStatus = {
  connected: boolean
  models: Array<{ id: string; displayName: string }>
}

/**
 * ChatGPT Codex 推理强度：对齐 OpenAI Responses `reasoning.effort`
 * （GPT-5.6：low / medium / high / xhigh / max；默认 medium）。
 * 不声明 runtime_profile，避免 ThinkingModeChip。
 */
const CODEX_REASONING_EFFORT_CONTROL: ModelRuntimeControl = {
  key: 'reasoning_effort',
  label: '推理强度',
  description: '更高档位会更快消耗使用额度。',
  kind: 'select',
  param_path: 'reasoning_effort',
  default_value: 'medium',
  visibility: 'model_menu',
  options: [
    {
      value: 'low',
      label: '轻度',
      description: '偏快、省额度。',
    },
    {
      value: 'medium',
      label: '中',
      description: '官方默认，质量与速度平衡。',
    },
    {
      value: 'high',
      label: '高',
      description: '更强推理，适合复杂任务。',
    },
    {
      value: 'xhigh',
      label: '极高',
      description: '深度推理，耗时与额度更高。',
    },
    {
      value: 'max',
      label: '最大',
      description: '最高推理强度，优先质量。',
    },
  ],
}

/**
 * ChatGPT 已连接时将本机 Codex 模型附加到 Django 返回的聊天目录。
 * 这些模型不依赖 Django 路由，实际请求由 Electron 主进程直连 Codex。
 */
export function mergeConnectedOpenAICodexModels(
  models: Model[],
  status: OpenAICodexStatus,
): Model[] {
  if (!status.connected) return models

  const knownModelIds = new Set(models.map((model) => model.id))
  const localModels = status.models
    .filter((model) => !knownModelIds.has(model.id))
    .map(createOpenAICodexModel)

  return localModels.length > 0 ? [...models, ...localModels] : models
}

function createOpenAICodexModel(model: {
  id: string
  displayName: string
}): Model {
  // 窗口 / max_output 按模型官方文档取值（shared/openai-codex-models），
  // 禁止再统一写死 128K——那是 max_output，不是 context window。
  const { contextWindowTokens, maxOutputTokens } = resolveOpenAICodexModelCapabilities(model.id)
  return {
    id: model.id,
    name: model.id,
    model_name: model.id,
    display_name: model.displayName,
    provider: 'openai-codex',
    provider_display_name: 'OpenAI Codex / ChatGPT',
    provider_scope: 'user',
    description: '使用已登录的 ChatGPT 订阅套餐运行',
    max_tokens: contextWindowTokens,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    supports_streaming: true,
    supports_vision: true,
    supports_function_calling: true,
    cost_per_1k_tokens: 0,
    billing_type: 'chatgpt_subscription',
    is_default: false,
    // 沿用测试包「思考强度」旧控件；不声明 runtime_profile，避免 ThinkingModeChip。
    runtime_controls: [CODEX_REASONING_EFFORT_CONTROL],
  }
}
