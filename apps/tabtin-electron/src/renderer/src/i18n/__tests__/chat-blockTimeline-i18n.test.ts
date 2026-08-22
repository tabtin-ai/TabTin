import { describe, expect, it } from 'vitest'

import zhChat from '../locales/zh-CN/chat.json'
import enChat from '../locales/en-US/chat.json'

const REQUIRED_BLOCK_TIMELINE_KEYS = [
  'text.truncated',
  'partial.streamInterrupted',
  'partial.aborted',
  'thinking.streaming',
  'thinking.tokenCount',
  'thinking.redacted',
  'thinking.thought',
  'thinking.thoughtForSeconds',
  'toolUse.parseError',
  'toolUse.generatingArgs',
  'toolResult.error',
  'toolResult.truncated',
  'toolResult.errorNoBody',
  'serverTool.badge',
  'serverTool.webSearchResults',
  'serverTool.webSearchEmpty',
  'serverTool.codeExecution',
  'serverTool.bashExecution',
  'serverTool.textEditor',
  'mcp.toolUse',
  'mcp.parseError',
  'mcp.serverTooltip',
  'mcp.serverPrefix',
  'mcp.generatingArgs',
  'mcp.resultError',
  'mcp.result',
  'sourceRef.unknownTitle',
  'approvalRequest.title',
  'approvalRequest.howTo',
  'containerUpload.title',
  'image.unavailable',
  'document.untitled',
  'fallback.unsupported',
] as const

function getPath(locale: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, (locale as { blockTimeline?: unknown }).blockTimeline)
}

function getStringSection(locale: unknown, section: string): Record<string, string> {
  return (locale as Record<string, unknown>)[section] as Record<string, string>
}

describe('chat blockTimeline i18n', () => {
  it('zh-CN / en-US 都提供 blockTimeline 真实文案', () => {
    for (const key of REQUIRED_BLOCK_TIMELINE_KEYS) {
      expect(getPath(zhChat, key), `${key} missing in zh-CN`).toEqual(expect.any(String))
      expect(String(getPath(zhChat, key)).trim()).not.toBe('')
      expect(getPath(enChat, key), `${key} missing in en-US`).toEqual(expect.any(String))
      expect(String(getPath(enChat, key)).trim()).not.toBe('')
    }
  })

  it('中文 thinking 不再回落到英文 Thought', () => {
    const blockTimeline = (zhChat as { blockTimeline: { thinking: Record<string, string> } }).blockTimeline
    const thinking = blockTimeline.thinking

    expect(thinking.thought).toBe('已思考')
    expect(thinking.streaming).toBe('思考中…')
    expect(thinking.redacted).toBe('推理已加密')
    expect(thinking.thoughtForSeconds).toContain('{{seconds}}')
  })

  it('英文 blockTimeline 不混入中文 fallback', () => {
    for (const key of REQUIRED_BLOCK_TIMELINE_KEYS) {
      expect(String(getPath(enChat, key))).not.toMatch(/[一-鿿]/)
    }
  })

  it('工具标签双语存在，避免 read_file 直接暴露在 UI', () => {
    expect(getStringSection(zhChat, 'card').read_file).toBe('读取文件')
    expect(getStringSection(enChat, 'card').read_file).toBe('Read File')
    expect(getStringSection(zhChat, 'toolName').read_file).toBe('读取文件')
    expect(getStringSection(enChat, 'toolName').read_file).toBe('Read file')
    expect(getStringSection(zhChat, 'toolName').unknown).toBe('工具')
    expect(getStringSection(enChat, 'toolName').unknown).toBe('Tool')
  })
})
