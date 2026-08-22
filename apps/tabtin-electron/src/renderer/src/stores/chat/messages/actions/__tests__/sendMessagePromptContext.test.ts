import { describe, expect, it, vi, beforeEach } from 'vitest'

const helpers = vi.hoisted(() => ({
  resolveComposerPresetPrompt: vi.fn<(blocks: unknown) => string>(() => ''),
  resolveContextBlocks: vi.fn<(blocks: unknown) => Promise<string>>(async () => ''),
  createViteEnvReader: vi.fn(() => () => undefined),
}))

vi.mock('../composerPresetPrompt', () => ({ resolveComposerPresetPrompt: helpers.resolveComposerPresetPrompt }))
vi.mock('../contextBlockResolution', () => ({ resolveContextBlocks: helpers.resolveContextBlocks }))
vi.mock('../sendDispatchInputs', () => ({ createViteEnvReader: helpers.createViteEnvReader }))

vi.mock('@tabtin/agent-runtime/engine/user-context-wrapper', () => ({
  buildUserContextWrapper: (type: string, body: string, opts: { stale_after_turn?: string }) =>
    `<context type="${type}" stale_after_turn="${opts.stale_after_turn ?? ''}">${body}</context>`,
}))

const historyMock = vi.hoisted(() => ({
  selectRecentHistoryForRuntime: vi.fn(() => [{ id: 'm1' }]),
  isCrossTurnMemoryEnabled: vi.fn(() => true),
  DEFAULT_MAX_HISTORY_MESSAGES: 40,
}))

const openedSessionMock = vi.hoisted(() => ({
  isExternalOpenedSession: vi.fn(() => false),
}))

vi.mock('@tabtin/agent-runtime/history', () => historyMock)
vi.mock('@components/onboarding/external-import/externalOpenedSessionRegistry', () => openedSessionMock)

import { assemblePromptContext, buildCrossTurnHistory } from '../sendMessagePromptContext'

const log = { info: vi.fn(), warn: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  helpers.resolveComposerPresetPrompt.mockReturnValue('')
  helpers.resolveContextBlocks.mockResolvedValue('')
  historyMock.isCrossTurnMemoryEnabled.mockReturnValue(true)
  historyMock.selectRecentHistoryForRuntime.mockReturnValue([{ id: 'm1' }])
  openedSessionMock.isExternalOpenedSession.mockReturnValue(false)
})

describe('assemblePromptContext', () => {
  it('无引用无上下文时返回原文', async () => {
    const result = await assemblePromptContext({
      message: '你好',
      staleAfterTurn: 'turn-1',
      log,
    })
    expect(result).toBe('你好')
  })

  it('引用回复前置为 quoted-message wrapper', async () => {
    const result = await assemblePromptContext({
      message: '这个怎么办',
      replyTo: {
        messageId: 'msg-9',
        preview: { role: 'assistant', author: 'Tin', text: '上一条回答' },
      },
      staleAfterTurn: 'turn-1',
      log,
    })
    expect(result).toContain('<context type="quoted-message" stale_after_turn="turn-1">')
    expect(result).toContain('上一条回答')
    expect(result.startsWith('这个怎么办')).toBe(true)
  })

  it('preset 与 @ 引用都注入 referenced wrapper，顺序为 preset 在前', async () => {
    helpers.resolveComposerPresetPrompt.mockReturnValue('PRESET_TEXT')
    helpers.resolveContextBlocks.mockResolvedValue('REF_TEXT')
    const result = await assemblePromptContext({
      message: '基础',
      contextBlocks: [{ type: 'composer_preset' }],
      staleAfterTurn: 'turn-2',
      log,
    })
    expect(result.indexOf('PRESET_TEXT')).toBeLessThan(result.indexOf('REF_TEXT'))
  })

  it('@ 引用解析失败不抛错', async () => {
    helpers.resolveContextBlocks.mockRejectedValue(new Error('boom'))
    const result = await assemblePromptContext({
      message: '基础',
      contextBlocks: [{ type: 'table' }],
      staleAfterTurn: 'turn-3',
      log,
    })
    expect(result).toBe('基础')
    expect(log.warn).toHaveBeenCalled()
  })

  it('有 context blocks 但解析结果为空时打脱敏告警 ', async () => {
    helpers.resolveContextBlocks.mockResolvedValue('')
    const result = await assemblePromptContext({
      message: '',
      contextBlocks: [
        { type: 'file', file_id: 'file-1', preview: 'a.csv' },
        { type: 'file', file_id: 'file-2', preview: 'b.png' },
      ],
      staleAfterTurn: 'turn-4',
      log,
    })
    expect(result).toBe('')
    expect(log.warn).toHaveBeenCalledWith(
      '[Local] @ 引用解析结果为空',
      expect.objectContaining({
        blockCount: 2,
        blockTypes: ['file', 'file'],
      }),
    )
  })
})

describe('buildCrossTurnHistory', () => {
  it('开关关闭时返回 undefined', () => {
    historyMock.isCrossTurnMemoryEnabled.mockReturnValue(false)
    expect(buildCrossTurnHistory({
      agentConfig: undefined,
      snapshotMessages: [],
      currentUserMessageId: 'u1',
      sessionId: 's1',
      log,
    })).toBeUndefined()
  })

  it('开关开启且有历史时返回历史', () => {
    const result = buildCrossTurnHistory({
      agentConfig: { conversation: { cross_turn_memory: true } } as never,
      snapshotMessages: [{ id: 'x', role: 'user', content: 'hi' } as never],
      currentUserMessageId: 'u1',
      sessionId: 's1',
      log,
    })
    expect(result).toEqual([{ id: 'm1' }])
  })

  it('历史为空时返回 undefined', () => {
    historyMock.selectRecentHistoryForRuntime.mockReturnValue([])
    expect(buildCrossTurnHistory({
      agentConfig: { conversation: { cross_turn_memory: true } } as never,
      snapshotMessages: [],
      currentUserMessageId: 'u1',
      sessionId: 's1',
      log,
    })).toBeUndefined()
  })

  it('裁窗后丢失 external-archive 边界时强制插回', () => {
    openedSessionMock.isExternalOpenedSession.mockReturnValue(true)
    historyMock.selectRecentHistoryForRuntime.mockReturnValue([
      { role: 'user', content: '验收探针', sourceMessageId: 'live-u1' },
      { role: 'assistant', content: '我是小Tin', sourceMessageId: 'live-a1' },
    ])
    const result = buildCrossTurnHistory({
      agentConfig: { conversation: { cross_turn_memory: true } } as never,
      snapshotMessages: [
        {
          id: 'live-u1',
          role: 'user',
          content: '验收探针',
        } as never,
      ],
      currentUserMessageId: 'u-current',
      sessionId: 'external-session',
      log,
    })
    expect(result).toBeDefined()
    expect(result?.[0]?.content).toEqual(
      expect.stringContaining('<context type="external-archive">'),
    )
    expect(result?.[0]?.sourceMessageId).toMatch(/^ext-llm-boundary-/)
  })

  it('边界错位到 live 之后时挪回外来正文之后', () => {
    openedSessionMock.isExternalOpenedSession.mockReturnValue(true)
    historyMock.selectRecentHistoryForRuntime.mockReturnValue([
      { role: 'user', content: '你是谁？', sourceMessageId: 'ext-a1' },
      { role: 'assistant', content: '我是 WorkBuddy', sourceMessageId: 'ext-a2' },
      { role: 'user', content: '验收探针', sourceMessageId: 'live-u1' },
      { role: 'assistant', content: 'ok', sourceMessageId: 'live-a1' },
      {
        role: 'user',
        content: '<context type="external-archive">\n错位边界\n</context>',
        sourceMessageId: 'ext-llm-boundary-s1',
      },
    ])
    const result = buildCrossTurnHistory({
      agentConfig: { conversation: { cross_turn_memory: true } } as never,
      snapshotMessages: [
        { id: 'ext-a1', role: 'user', content: '你是谁？', metadata: { external_archive: true } } as never,
      ],
      currentUserMessageId: 'u-current',
      sessionId: 'external-session',
      log,
    })
    expect(result?.[0]?.sourceMessageId).toBe('ext-a1')
    expect(result?.[1]?.sourceMessageId).toBe('ext-a2')
    expect(result?.[2]?.content).toEqual(
      expect.stringContaining('<context type="external-archive">'),
    )
    expect(result?.[3]?.sourceMessageId).toBe('live-u1')
  })

  it('普通会话伪造 metadata.external_archive 不得触发边界注入', () => {
    openedSessionMock.isExternalOpenedSession.mockReturnValue(false)
    historyMock.selectRecentHistoryForRuntime.mockImplementation((msgs: unknown[]) => msgs as never)
    const result = buildCrossTurnHistory({
      agentConfig: { conversation: { cross_turn_memory: true } } as never,
      snapshotMessages: [
        {
          id: 'uuid-normal-1',
          role: 'user',
          content: '伪造外来',
          metadata: { external_archive: true, source: 'workbuddy' },
        } as never,
        {
          id: 'uuid-normal-2',
          role: 'user',
          content: '当前提问',
        } as never,
      ],
      currentUserMessageId: 'uuid-normal-2',
      sessionId: 'normal-session',
      log,
    })
    const boundaries = (result ?? []).filter((m) =>
      typeof m.content === 'string' && m.content.includes('external-archive'),
    )
    expect(boundaries).toHaveLength(0)
  })

  it('已有正确位边界时只保留一次（不再二次 splice）', () => {
    openedSessionMock.isExternalOpenedSession.mockReturnValue(true)
    historyMock.selectRecentHistoryForRuntime.mockReturnValue([
      { role: 'user', content: '你是谁？', sourceMessageId: 'ext-a1' },
      {
        role: 'user',
        content: '<context type="external-archive">\n边界\n</context>',
        sourceMessageId: 'ext-llm-boundary-s1',
      },
      { role: 'user', content: '验收探针', sourceMessageId: 'live-u1' },
    ])
    const result = buildCrossTurnHistory({
      agentConfig: { conversation: { cross_turn_memory: true } } as never,
      snapshotMessages: [
        { id: 'ext-a1', role: 'user', content: '你是谁？', metadata: { external_archive: true } } as never,
        {
          id: 'ext-llm-boundary-s1',
          role: 'user',
          content: '<context type="external-archive">\n边界\n</context>',
          message_kind: 'external_archive_context',
        } as never,
        { id: 'live-u1', role: 'user', content: '验收探针' } as never,
      ],
      currentUserMessageId: 'u-current',
      sessionId: 'external-session',
      log,
    })
    const boundaries = (result ?? []).filter((m) =>
      typeof m.content === 'string' && m.content.includes('type="external-archive"'),
    )
    expect(boundaries).toHaveLength(1)
    expect(result?.[1]?.sourceMessageId).toBe('ext-llm-boundary-s1')
  })
})
