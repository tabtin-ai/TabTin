import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/agent-runtime/engine/user-context-wrapper', () => ({
  buildUserContextWrapper: (type: string, body: string, opts: { stale_after_turn?: string }) =>
    `<context type="${type}" stale_after_turn="${opts.stale_after_turn ?? ''}">${body}</context>`,
}))

vi.mock('../../auth.js', () => ({
  TokenManager: { getAccessToken: vi.fn().mockResolvedValue('tok') },
}))

vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'https://api.test.local/api',
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path.startsWith('/') ? path : `/${path}`}`,
  API_ENDPOINTS: { AUTH: { PROFILE_PERSONAL_RULES: '/auth/profile/personal-rules' } },
}))

import {
  assembleHostPromptContext,
  filterHostPromptContextBlocks,
  renderMcpFocusContext,
  resolveHostContextBlocks,
} from '../assemble-host-prompt'
import { resolveComposerPresetPrompt } from '../composer-preset-prompt'

const log = { info: vi.fn(), warn: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveComposerPresetPrompt', () => {
  it('渲染 rendered_prompt 优先', () => {
    const text = resolveComposerPresetPrompt([{
      type: 'composer_preset',
      preset_id: 'slide',
      params: { rendered_prompt: '请做一页封面' },
    }])
    expect(text).toContain('slide')
    expect(text).toContain('请做一页封面')
  })
})

describe('renderMcpFocusContext', () => {
  it('生成 MCP focus 文案', () => {
    const text = renderMcpFocusContext([
      { type: 'mcp_server', connection_id: 'c1', server_name: 'github' },
    ])
    expect(text).toContain('server_name="github"')
    expect(text).toContain('connection_id="c1"')
  })
})

describe('filterHostPromptContextBlocks', () => {
  it('去掉 type===text 的气泡正文', () => {
    const filtered = filterHostPromptContextBlocks([
      { type: 'text', text: 'hi' },
      { type: 'webpage', url: 'https://x.test' },
    ])
    expect(filtered).toEqual([{ type: 'webpage', url: 'https://x.test' }])
  })
})

describe('assembleHostPromptContext', () => {
  it('无引用时返回原文', async () => {
    await expect(assembleHostPromptContext({
      message: '你好',
      staleAfterTurn: 't1',
      log,
    })).resolves.toBe('你好')
  })

  it('顺序：原文 → quoted → preset → @引用', async () => {
    const result = await assembleHostPromptContext({
      message: '基础',
      replyTo: {
        messageId: 'm1',
        preview: { role: 'assistant', author: 'Tin', text: '上一条' },
      },
      contextBlocks: [{ type: 'composer_preset', preset_id: 'p', params: { rendered_prompt: 'PRESET' } }],
      staleAfterTurn: 't2',
      log,
      resolveContextBlocks: async () => 'REF',
    })
    expect(result.indexOf('基础')).toBe(0)
    expect(result.indexOf('quoted-message')).toBeLessThan(result.indexOf('PRESET'))
    expect(result.indexOf('PRESET')).toBeLessThan(result.indexOf('REF'))
  })

  it('@ 引用失败不抛错', async () => {
    const result = await assembleHostPromptContext({
      message: '基础',
      contextBlocks: [{ type: 'table' }],
      staleAfterTurn: 't3',
      log,
      resolveContextBlocks: async () => { throw new Error('boom') },
    })
    expect(result).toBe('基础')
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('resolveHostContextBlocks', () => {
  it('无 token 时仅返回 MCP focus', async () => {
    const text = await resolveHostContextBlocks(
      [
        { type: 'table', table_id: 't1' },
        { type: 'mcp_server', connection_id: 'c1', server_name: 'gh' },
      ],
      { getAccessToken: async () => null },
    )
    expect(text).toContain('MCP focus')
    expect(text).not.toContain('table_id')
  })

  it('API 成功时拼接资源文本与 MCP focus（注入 TokenManager 默认 apiBase）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { context_text: 'RESOURCE' } }),
    })
    const text = await resolveHostContextBlocks(
      [
        { type: 'table', table_id: 't1' },
        { type: 'mcp_server', connection_id: 'c1', server_name: 'gh' },
      ],
      {
        getAccessToken: async () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect(text).toContain('RESOURCE')
    expect(text).toContain('MCP focus')
    expect(fetchImpl).toHaveBeenCalled()
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://api.test.local/api/chat/resolve-context',
    )
  })
})
