import { getToolLabelKey } from './toolCardRegistry'

export type ChatTranslate = (key: string, options?: Record<string, unknown>) => string

/**
 * Registry 里的历史 labelKey 大多写成 `chat.card.read_file`，但组件已经通过
 * `useTranslation('chat')` 绑定在 chat namespace 内。这里统一剥掉 chat 前缀，
 * 避免 i18n 查不到后 fallback 成 `read_file` 这类内部工具名。
 */
export function normalizeChatI18nKey(key: string | null | undefined): string | null {
  if (!key) return null
  if (key.startsWith('chat:')) return key.slice('chat:'.length)
  if (key.startsWith('chat.')) return key.slice('chat.'.length)
  return key
}

export function getUnknownToolDisplayName(t: ChatTranslate): string {
  const systemFallback = t('systemNotice.unknownTool', { defaultValue: 'Tool' })
  return t('toolName.unknown', { defaultValue: systemFallback })
}

export function getToolDisplayName(t: ChatTranslate, toolName: string | null | undefined): string {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : ''
  const unknownToolLabel = getUnknownToolDisplayName(t)

  if (!normalizedToolName || normalizedToolName === 'unknown') {
    return unknownToolLabel
  }

  const toolNameLabel = t(`toolName.${normalizedToolName}`, {
    defaultValue: unknownToolLabel,
  })
  const labelKey = normalizeChatI18nKey(getToolLabelKey(normalizedToolName))

  if (!labelKey) return toolNameLabel

  return t(labelKey, {
    defaultValue: toolNameLabel,
  })
}
