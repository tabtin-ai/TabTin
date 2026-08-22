import type { ModelCatalogEntry } from '@tabtin/agent-runtime/engine'
import { isOpenAICodexModel } from './openai-codex-models.js'

export type ModelExecutionRoute =
  | { kind: 'local_codex'; isByok: true }
  | { kind: 'proxy'; isByok: boolean }

/** 共享 Space 模板不能固定绑定只存在于某台设备上的 ChatGPT 登录。 */
export function resolveSharedTemplateModelId(modelId: string | null | undefined): string {
  const normalized = modelId?.trim() ?? ''
  return normalized && !isOpenAICodexModel(normalized) ? normalized : ''
}

/**
 * 模型 ID、Provider 与计费/错误语义的单一裁决点。
 *
 * 主进程目录是平台/API Key BYOK 的权威；renderer hint 只在目录冷启动 miss 时
 * 兼容旧请求。这样即使 UI 状态滞后，也不会再次拼出“一个渠道 + 另一个渠道的
 * 模型语义”。
 */
export function resolveModelExecutionRoute(input: {
  modelId: string
  catalogEntry?: Pick<ModelCatalogEntry, 'providerScope'>
  rendererByokHint?: boolean
}): ModelExecutionRoute {
  if (isOpenAICodexModel(input.modelId)) {
    return { kind: 'local_codex', isByok: true }
  }

  const scope = input.catalogEntry?.providerScope?.trim().toLowerCase()
  if (scope === 'organization' || scope === 'user') {
    return { kind: 'proxy', isByok: true }
  }
  if (scope === 'global') {
    return { kind: 'proxy', isByok: false }
  }
  return { kind: 'proxy', isByok: input.rendererByokHint === true }
}
