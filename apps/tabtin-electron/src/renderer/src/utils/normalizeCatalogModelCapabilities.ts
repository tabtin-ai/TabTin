import type { Model } from '@tabtin/chat-client'

function readStructuredFlag(
  model: Model,
  sectionName: string,
  fieldName: string
): boolean | undefined {
  const section = model.capabilities_config?.[sectionName]
  if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined
  const value = section[fieldName]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * capabilities_config 的结构化字段是真值来源；Catalog 顶层 supports_* 是旧客户端兼容镜像。
 * 后端版本尚未对齐或历史缓存导致两者漂移时，客户端仍按结构化声明开放正确入口。
 */
export function normalizeCatalogModelCapabilities(model: Model): Model {
  return {
    ...model,
    supports_streaming:
      readStructuredFlag(model, 'wire', 'stream_supported') ?? model.supports_streaming,
    supports_function_calling:
      readStructuredFlag(model, 'tool', 'enabled') ?? model.supports_function_calling,
    supports_vision: readStructuredFlag(model, 'image', 'enabled') ?? model.supports_vision,
  }
}
