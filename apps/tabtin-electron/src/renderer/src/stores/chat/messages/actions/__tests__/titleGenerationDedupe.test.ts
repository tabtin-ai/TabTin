/**
 * 单测 — titleGenerationDedupe（：必带 userMessage）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  _resetTitleGenerationDedupeForTests,
  defaultShouldGenerateTitle,
  shouldGenerateTitleOnSend,
  requestTitleGenerationOnSend,
  requestTitleGenerationOnce,
} from '../titleGenerationDedupe'

function makeMsgs(roles: Array<ChatMessage['role']>): ChatMessage[] {
  return roles.map((role, i) => ({
    id: `m-${i}`,
    role,
    content: 'hi',
    created_at: new Date().toISOString(),
  })) as ChatMessage[]
}

function makeEnvContextUser(afterIndex: number): ChatMessage {
  return {
    id: `env-${afterIndex}`,
    role: 'user',
    message_kind: 'environment_context',
    content: '<context type="environment">\ncurrent_datetime: 2026\n</context>',
    created_at: new Date().toISOString(),
  }
}

function makeSystemPromptContextUser(afterIndex: number): ChatMessage {
  return {
    id: `sys-${afterIndex}`,
    role: 'user',
    message_kind: 'system_prompt_context',
    content: '<identity>\nsystem rules\n</identity>',
    created_at: new Date().toISOString(),
  }
}

const TTL_MS = 5 * 60 * 1000

type TitleGenResultMock =
  | { accepted: true }
  | { accepted: false; reason: 'already_has_title' | 'empty_user_message' }

function buildDeps(opts: {
  sessionId?: string
  userMessage?: string
  shouldTrigger?: () => boolean
  force?: boolean
  generateTitleImpl?: (
    sessionId: string,
    options: { userMessage: string; force?: boolean },
  ) => Promise<TitleGenResultMock>
} = {}) {
  const sessionId = opts.sessionId ?? 'sess-aaa'
  const generateTitle = vi.fn(
    opts.generateTitleImpl ?? (async () => ({ accepted: true } as const)),
  )
  const getChatClient = vi.fn(() => ({
    sessions: { generateTitle },
  })) as unknown as () => import('@tabtin/chat-client').ChatClient

  return {
    sessionId,
    userMessage: opts.userMessage ?? '你好',
    shouldTrigger: opts.shouldTrigger ?? (() => true),
    force: opts.force,
    getChatClient,
    generateTitle,
  }
}

describe('requestTitleGenerationOnce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetTitleGenerationDedupeForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('空 userMessage 不发请求', () => {
    const deps = buildDeps({ userMessage: '   ' })
    expect(requestTitleGenerationOnce(deps)).toBe(false)
    expect(deps.generateTitle).not.toHaveBeenCalled()
  })

  it('shouldTrigger=false 时不发请求且返回 false', () => {
    const deps = buildDeps({ shouldTrigger: () => false })
    expect(requestTitleGenerationOnce(deps)).toBe(false)
    expect(deps.generateTitle).not.toHaveBeenCalled()
  })

  it('首次触发时带 userMessage 发请求', async () => {
    const deps = buildDeps({ userMessage: '帮我写报告' })
    expect(requestTitleGenerationOnce(deps)).toBe(true)
    expect(deps.generateTitle).toHaveBeenCalledWith('sess-aaa', {
      userMessage: '帮我写报告',
      force: false,
    })
    await vi.waitFor(() => expect(deps.generateTitle).toHaveBeenCalledTimes(1))
  })

  it('同一 sessionId 在 TTL 窗口内只发一次', () => {
    const deps = buildDeps()
    expect(requestTitleGenerationOnce(deps)).toBe(true)
    expect(requestTitleGenerationOnce(deps)).toBe(false)
    expect(deps.generateTitle).toHaveBeenCalledTimes(1)
  })

  it('不同 sessionId 互不影响', () => {
    const a = buildDeps({ sessionId: 'sess-a' })
    const b = buildDeps({ sessionId: 'sess-b' })
    expect(requestTitleGenerationOnce(a)).toBe(true)
    expect(requestTitleGenerationOnce(b)).toBe(true)
    expect(a.generateTitle).toHaveBeenCalledTimes(1)
    expect(b.generateTitle).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后同一 sessionId 可以再次触发', () => {
    const deps = buildDeps()
    requestTitleGenerationOnce(deps)
    expect(deps.generateTitle).toHaveBeenCalledTimes(1)
    expect(requestTitleGenerationOnce(deps)).toBe(false)

    vi.advanceTimersByTime(TTL_MS + 1)
    expect(requestTitleGenerationOnce(deps)).toBe(true)
    expect(deps.generateTitle).toHaveBeenCalledTimes(2)
  })

  it('accepted=false 释放 dedupe 后可重试', async () => {
    const deps = buildDeps({
      generateTitleImpl: async () => ({ accepted: false, reason: 'already_has_title' }),
    })
    expect(requestTitleGenerationOnce(deps)).toBe(true)
    await vi.waitFor(() => expect(deps.generateTitle).toHaveBeenCalledTimes(1))
    expect(requestTitleGenerationOnce(deps)).toBe(true)
  })

  it('force=true 绕过 dedupe', () => {
    const deps = buildDeps({ force: true })
    expect(requestTitleGenerationOnce(deps)).toBe(true)
    expect(requestTitleGenerationOnce({ ...deps, force: true })).toBe(true)
    expect(deps.generateTitle).toHaveBeenCalledTimes(2)
    expect(deps.generateTitle).toHaveBeenLastCalledWith('sess-aaa', {
      userMessage: '你好',
      force: true,
    })
  })
})

describe('defaultShouldGenerateTitle', () => {
  it('0 或 1 条真实 user → true；2 条 → false', () => {
    expect(defaultShouldGenerateTitle([])).toBe(true)
    expect(defaultShouldGenerateTitle(makeMsgs(['user']))).toBe(true)
    expect(defaultShouldGenerateTitle(makeMsgs(['user', 'assistant', 'user']))).toBe(false)
  })

  it('合成 environment_context user 不计入', () => {
    const msgs = [makeEnvContextUser(0), ...makeMsgs(['user'])]
    expect(defaultShouldGenerateTitle(msgs)).toBe(true)
  })

  it('合成 system_prompt_context user 不计入', () => {
    const msgs = [makeSystemPromptContextUser(0), ...makeMsgs(['user'])]
    expect(defaultShouldGenerateTitle(msgs)).toBe(true)
  })
})

describe('shouldGenerateTitleOnSend', () => {
  it('fork 占位 + title_is_default：多条拷贝 user 仍触发', () => {
    expect(
      shouldGenerateTitleOnSend(makeMsgs(['user', 'assistant', 'user']), {
        forked_from_id: 'parent',
        title_is_default: true,
        title_generation_status: 'pending',
      }),
    ).toBe(true)
  })

  it('fork 已 done：不触发', () => {
    expect(
      shouldGenerateTitleOnSend(makeMsgs(['user', 'assistant', 'user']), {
        forked_from_id: 'parent',
        title_is_default: false,
        title_generation_status: 'done',
      }),
    ).toBe(false)
  })

  it('非 fork 多轮：不触发', () => {
    expect(
      shouldGenerateTitleOnSend(makeMsgs(['user', 'assistant', 'user']), {
        forked_from_id: null,
        title_is_default: false,
        title_generation_status: 'done',
      }),
    ).toBe(false)
  })
})

describe('requestTitleGenerationOnSend', () => {
  beforeEach(() => {
    _resetTitleGenerationDedupeForTests()
  })

  it('首轮真实 user → 发 generateTitle', () => {
    const generateTitle = vi.fn(async () => ({ accepted: true as const }))
    const fired = requestTitleGenerationOnSend({
      sessionId: 'sess-aaa',
      userMessage: '你好',
      getMessages: () => makeMsgs(['user']),
      getChatClient: () =>
        ({ sessions: { generateTitle } }) as unknown as import('@tabtin/chat-client').ChatClient,
    })
    expect(fired).toBe(true)
    expect(generateTitle).toHaveBeenCalledWith('sess-aaa', {
      userMessage: '你好',
      force: false,
    })
  })

  it('第二轮真实 user → 不发', () => {
    const generateTitle = vi.fn(async () => ({ accepted: true as const }))
    const fired = requestTitleGenerationOnSend({
      sessionId: 'sess-aaa',
      userMessage: '第二句',
      getMessages: () => makeMsgs(['user', 'assistant', 'user']),
      getChatClient: () =>
        ({ sessions: { generateTitle } }) as unknown as import('@tabtin/chat-client').ChatClient,
    })
    expect(fired).toBe(false)
    expect(generateTitle).not.toHaveBeenCalled()
  })
})
