import { describe, expect, it } from 'vitest'

import {
  getToolDisplayName,
  normalizeChatI18nKey,
  type ChatTranslate,
} from '../toolDisplayName'

function makeT(dict: Record<string, string>): ChatTranslate {
  return (key, options) => {
    const value = dict[key]
    if (value) return value
    return typeof options?.defaultValue === 'string' ? options.defaultValue : key
  }
}

describe('toolDisplayName', () => {
  it('normalizes chat namespace prefixes before looking up labels', () => {
    expect(normalizeChatI18nKey('chat.card.read_file')).toBe('card.read_file')
    expect(normalizeChatI18nKey('chat:card.read_file')).toBe('card.read_file')
    expect(normalizeChatI18nKey('card.read_file')).toBe('card.read_file')
  })

  it('uses the registry label key without leaking raw snake_case tool names', () => {
    const t = makeT({
      'systemNotice.unknownTool': '工具',
      'toolName.read_file': '读取文件',
      'card.read_file': '读取文件',
    })

    expect(getToolDisplayName(t, 'read_file')).toBe('读取文件')
  })

  it('falls back to a generic localized tool label for unknown names', () => {
    const t = makeT({
      'systemNotice.unknownTool': '工具',
    })

    expect(getToolDisplayName(t, '__future_tool_v9__')).toBe('工具')
    expect(getToolDisplayName(t, 'unknown')).toBe('工具')
  })
})
