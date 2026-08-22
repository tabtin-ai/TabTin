import { describe, expect, it, beforeEach } from 'vitest'
import { StreamEvents } from '../src/engine/contracts/stream-events.js';

import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';
import { createCoreTools } from '../src/tools/core-tools.js'
import { __resetAskUserDedupForTest } from '../src/tools/ask-tools.js'

/**
 * ask-tools.test.ts — W4（ask 工具协议，2026-05-11）
 *
 * 三件套（ask_choice / ask_form / request_approval）合一为单 `ask_user`。
 * 测试覆盖：
 *   1. 注册：core-tools 暴露 `ask_user`，三件套旧名彻底消失
 *   2. schema 校验：questions 数量 / option 唯一性 / description 必填
 *   3. emit：走 `ASK_USER_REQUIRED` 单事件 + payload `tool_name='ask_user'`
 *   4. 自动注入 Other 选项
 *   5. OUTPUT 文案：完全正向（无任何 `Do NOT`），用户 answered / skipped / 自由文本
 *   6. host_unsupported / timeout fallback 文案也改正向（无 `Do NOT proceed`）
 */

function getTool(name: string) {
  const tool = createCoreTools({}).find(t => t.name === name)
  if (!tool) throw new Error(`${name} tool not found`)
  return tool
}

function makeCtx(
  events: unknown[] = [],
  response: unknown = { ok: true },
  threadId = 't',
  runtimeMode?: ToolContext['runtimeMode'],
): ToolContext {
  return {
    // §17.6 D4：threadId 是业务对话 thread；runtimeId 是 runtime UUID。
    // ask-tools 的 session-scoped dedup 改用 context.threadId（业务对话维度）。
    threadId,
    runtimeId: 'rt',
    // ：HITL transcript 要求非空 agentRunId
    agentRunId: 'ar-test',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    runtimeMode,
    emitStreamEvent: (event) => events.push(event),
    waitForUserInput: async () => response,
  }
}

function parseError(content: unknown): Record<string, unknown> {
  return JSON.parse(content as string) as Record<string, unknown>
}

// ：ask 三件套现在在 waiter 结束后对称补发 single_hitl_resolved 终态事件，
// 因此 emitStreamEvent 捕获的 events 会含 [*_required, single_hitl_resolved]。
// 下面「弹了几张卡」的计数断言只关心 *_required，故过滤出 required 事件再计数。
const REQUIRED_EVENT_TYPES = new Set<string>([
  StreamEvents.ASK_USER_REQUIRED,
  StreamEvents.ASK_FORM_REQUIRED,
  StreamEvents.REQUEST_APPROVAL_REQUIRED,
])
function requiredEvents(events: unknown[]): unknown[] {
  return events.filter(e => REQUIRED_EVENT_TYPES.has((e as { type?: string }).type ?? ''))
}
function resolvedEvents(events: unknown[]): Array<{ type: string; payload: Record<string, any> }> {
  return events.filter(
    e => (e as { type?: string }).type === StreamEvents.SINGLE_HITL_RESOLVED,
  ) as Array<{ type: string; payload: Record<string, any> }>
}
function terminalHitlFacts(events: unknown[]): Array<{ type: string; payload: Record<string, any> }> {
  return events.filter(e => {
    const event = e as { type?: string; payload?: Record<string, any> }
    return event.type === StreamEvents.PERSIST_MESSAGE &&
      event.payload?.message_kind === 'hitl_interaction' &&
      event.payload?.metadata?.hitl?.status === 'resolved'
  }) as Array<{ type: string; payload: Record<string, any> }>
}

describe('ask_user (W4 R3: 三件套并存，ask_user 兼容 ask_choice 场景)', () => {
  beforeEach(() => {
    // W4 R2 必修 1：每个测试隔离 session-dedup 缓存，避免相互污染。
    __resetAskUserDedupForTest()
  })

  it('registers ask_user + ask_form（request_approval 已随  下架）', () => {
    const names = createCoreTools({}).map(t => t.name)
    expect(names).toContain('ask_user')
    expect(names).toContain('ask_form')
    // ：request_approval 下架——审批意图由 ask_user / 纯文本承接
    expect(names).not.toContain('request_approval')
    // ask_choice 由 ask_user 兼容，不再单独注册（B 报告 §六明示）
    expect(names).not.toContain('ask_choice')
    // 历史 alias 也不应作为可调工具
    expect(names).not.toContain('ask_question')
  })

  it('ask_user 是 readOnly + isConcurrencySafe(input) 返回 false（避免同轮多 ask 竞态）', () => {
    const tool = getTool('ask_user')
    expect(tool.isReadOnly).toBe(true)
    expect(typeof tool.isConcurrencySafe).toBe('function')
    expect(tool.isConcurrencySafe!({})).toBe(false)
  })

  it('description 是短 + 正向 + 无任何反向指引', () => {
    // 2026-05-21 阶段 6.7 治理：ask_user description 重写为「围绕 ask_user /
    // ask_form / request_approval 三者边界」的自洽文案，断言同步为当前关键语义。
    const tool = getTool('ask_user')
    const desc = tool.description ?? ''
    // 核心用途：从 2-4 个具体选项里选一个
    expect(desc).toContain('让用户从 2-4 个具体选项里选一个')
    // 三件套边界说明（新文案的定义性内容）
    expect(desc).toContain('让用户填写密码 / URL / 多个文本字段')
    // 严禁任何反向指引（dogfood 实测：反向句让 LLM 重复确认）
    expect(desc).not.toMatch(/Do NOT call/i)
    expect(desc).not.toMatch(/Do NOT proceed/i)
    expect(desc).not.toMatch(/do NOT request/i)
  })

  it('单问题 + 2 选项 → emit ASK_USER_REQUIRED + 自动注入 Other 选项', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_user').execute({
      title: ' Pick path ',
      questions: [{
        id: 'q1',
        prompt: ' Which path? ',
        header: 'Path',
        options: [
          { id: 'a', label: 'A', description: 'Use option A.' },
          { id: 'b', label: 'B', description: 'Use option B.' },
        ],
      }],
    }, makeCtx(events, {
      answers: [{ question_id: 'q1', selected_options: ['a'], free_text: 'ok' }],
    }))

    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(1)
    const event = events[0] as { type: string; payload: Record<string, any> }
    expect(event.type).toBe(StreamEvents.ASK_USER_REQUIRED)
    expect(event.payload.tool_name).toBe('ask_user')
    expect(event.payload.interaction_type).toBe('ask_user')
    expect(event.payload.blocking_policy).toBe('hard')
    // 自动注入 Other 选项
    expect(event.payload.questions[0].options.at(-1)).toEqual({
      id: '__other__',
      label: 'Other',
      description: 'Use a custom answer not covered by the listed options.',
    })
    // OUTPUT 是正向单句，包含答案明细 + 提示继续
    expect(result.content).toContain('User has answered your questions')
    expect(result.content).toContain('Which path?')
    expect(result.content).toContain('ok')
    expect(result.content).toContain('You can now continue with the user\'s answers in mind')
    // 严禁反向指引
    expect(result.content).not.toMatch(/Do NOT/i)
    // W4 R2 (P2-5): 删除 Metadata 行——OUTPUT 完全按约定实现 纯净格式。
    expect(result.content).not.toMatch(/Metadata:/i)
    expect(result.content).not.toMatch(/request_id=/i)
    expect(terminalHitlFacts(events)).toHaveLength(1)
    expect(terminalHitlFacts(events)[0].payload.metadata.hitl.result.answers).toEqual([
      { question_id: 'q1', selected_options: ['a'], free_text: 'ok' },
    ])
  })

  it('LLM 提供 header（chip 标签）→ 透传到 wire payload', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Which library to use for date formatting?',
        header: 'Library',
        options: [
          { id: 'a', label: 'date-fns', description: 'Functional date utilities.' },
          { id: 'b', label: 'dayjs', description: 'Lightweight Moment.js alternative.' },
        ],
      }],
    }, makeCtx(events, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }))

    const event = events[0] as { payload: { questions: Array<{ header?: string }> } }
    expect(event.payload.questions[0].header).toBe('Library')
  })

  it('option 支持可选 preview', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick a layout?',
        header: 'Layout',
        options: [
          { id: 'a', label: 'A', description: 'Sidebar', preview: '+----+----+\n|    |    |\n+----+----+' },
          { id: 'b', label: 'B', description: 'Stacked' },
        ],
      }],
    }, makeCtx(events, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }))

    const event = events[0] as { payload: { questions: Array<{ options: Array<{ preview?: string }> }> } }
    expect(event.payload.questions[0].options[0].preview).toContain('+----+')
    expect(event.payload.questions[0].options[1].preview).toBeUndefined()
  })

  it('rejects duplicate option labels (case-insensitive)', async () => {
    const result = await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one',
        header: 'Pick',
        options: [
          { id: 'a', label: 'Same', description: 'First.' },
          { id: 'b', label: 'same', description: 'Second.' },
        ],
      }],
    }, makeCtx())
    expect(result.isError).toBe(true)
    expect(parseError(result.content).error_kind).toBe('invalid_param_format')
  })

  it('rejects missing option descriptions', async () => {
    const result = await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one',
        header: 'Pick',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', description: 'Second.' },
        ],
      }],
    }, makeCtx())
    expect(result.isError).toBe(true)
    expect(String(parseError(result.content).field)).toContain('options[0].description')
  })

  // W4 R2 (P2-6): header required —— LLM 不传 header 时 schema 拒绝。
  it('rejects question without header (W4 R2: header is required)', async () => {
    const result = await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one',
        // header 缺失
        options: [
          { id: 'a', label: 'A', description: 'aa' },
          { id: 'b', label: 'B', description: 'bb' },
        ],
      }],
    }, makeCtx())
    expect(result.isError).toBe(true)
    expect(String(parseError(result.content).field)).toContain('questions[0].header')
  })

  it('rejects > 4 questions ', async () => {
    const result = await getTool('ask_user').execute({
      questions: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i}`,
        prompt: `Question ${i}?`,
        header: `H${i}`,
        options: [
          { id: 'a', label: 'A', description: 'aa' },
          { id: 'b', label: 'B', description: 'bb' },
        ],
      })),
    }, makeCtx())
    expect(result.isError).toBe(true)
    expect(String(parseError(result.content).field)).toContain('questions')
  })

  // W4 R2 review 补盲区：duplicate questions[].id 必须被拒绝
  it('rejects duplicate questions[].id (regression guard)', async () => {
    const result = await getTool('ask_user').execute({
      questions: [
        {
          id: 'shared',
          prompt: 'Q1',
          header: 'H1',
          options: [
            { id: 'a', label: 'A', description: 'aa' },
            { id: 'b', label: 'B', description: 'bb' },
          ],
        },
        {
          id: 'shared',
          prompt: 'Q2',
          header: 'H2',
          options: [
            { id: 'a', label: 'A', description: 'aa' },
            { id: 'b', label: 'B', description: 'bb' },
          ],
        },
      ],
    }, makeCtx())
    expect(result.isError).toBe(true)
    expect(String(parseError(result.content).field)).toContain('questions[*].id')
  })

  // W4 R2 review 补盲区：duplicate questions[].prompt 必须被拒绝
  it('rejects duplicate questions[].prompt (regression guard)', async () => {
    const result = await getTool('ask_user').execute({
      questions: [
        {
          id: 'q1',
          prompt: 'What library?',
          header: 'Lib1',
          options: [
            { id: 'a', label: 'A', description: 'aa' },
            { id: 'b', label: 'B', description: 'bb' },
          ],
        },
        {
          id: 'q2',
          prompt: 'What library?',
          header: 'Lib2',
          options: [
            { id: 'a', label: 'A', description: 'aa' },
            { id: 'b', label: 'B', description: 'bb' },
          ],
        },
      ],
    }, makeCtx())
    expect(result.isError).toBe(true)
    expect(String(parseError(result.content).field)).toContain('questions[*].prompt')
  })

  // W4 R2 review 补盲区：LLM 已显式提供 Other 选项时，不能重复注入
  it('does NOT inject Other when LLM already provides one (id=__other__ or label=Other)', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one',
        header: 'Pick',
        options: [
          { id: 'a', label: 'A', description: 'Use A.' },
          { id: 'b', label: 'B', description: 'Use B.' },
          { id: '__other__', label: 'Other', description: 'Custom answer.' },
        ],
      }],
    }, makeCtx(events, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }))

    const event = events[0] as { payload: { questions: Array<{ options: Array<{ id: string }> }> } }
    const otherCount = event.payload.questions[0].options.filter(o => o.id === '__other__').length
    expect(otherCount).toBe(1)
    expect(event.payload.questions[0].options).toHaveLength(3)
  })

  it('other_option 定制「其他」文案 → 注入选项用定制值，并透传 other_option', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: '要测哪个页面？',
        header: '页面',
        options: [
          { id: 'login', label: '登录页', description: '验登录流程。' },
          { id: 'model', label: '模型配置页', description: '验默认模型。' },
        ],
        other_option: {
          label: '其他页面',
          description: '你告诉我具体页面和要验证的功能',
        },
      }],
    }, makeCtx(events, { answers: [{ question_id: 'q1', selected_options: ['login'] }] }))

    const event = events[0] as {
      payload: {
        questions: Array<{
          other_option?: { id: string; label: string; description: string }
          options: Array<{ id: string; label: string; description: string }>
        }>
      }
    }
    const q = event.payload.questions[0]
    expect(q.other_option).toEqual({
      id: '__other__',
      label: '其他页面',
      description: '你告诉我具体页面和要验证的功能',
    })
    expect(q.options.at(-1)).toEqual({
      id: '__other__',
      label: '其他页面',
      description: '你告诉我具体页面和要验证的功能',
    })
    expect(q.options.filter(o => o.id === '__other__')).toHaveLength(1)
  })

  it('未传 other_option → 注入内置 Other，payload 不含 other_option', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one?',
        header: 'Pick',
        options: [
          { id: 'a', label: 'A', description: 'Use A.' },
          { id: 'b', label: 'B', description: 'Use B.' },
        ],
      }],
    }, makeCtx(events, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }))

    const event = events[0] as {
      payload: {
        questions: Array<{
          other_option?: unknown
          options: Array<{ id: string; label: string; description: string }>
        }>
      }
    }
    expect(event.payload.questions[0].other_option).toBeUndefined()
    expect(event.payload.questions[0].options.at(-1)).toEqual({
      id: '__other__',
      label: 'Other',
      description: 'Use a custom answer not covered by the listed options.',
    })
  })

  it('多问题 + multi_select + free text → OUTPUT 包含所有问答 + 正向收尾', async () => {
    const result = await getTool('ask_user').execute({
      title: 'Project setup',
      questions: [
        {
          id: 'lib',
          prompt: 'Which library?',
          header: 'Library',
          options: [
            { id: 'a', label: 'date-fns', description: 'Functional.' },
            { id: 'b', label: 'dayjs', description: 'Lightweight.' },
          ],
        },
        {
          id: 'features',
          prompt: 'Which features to enable?',
          header: 'Features',
          allow_multiple: true,
          options: [
            { id: 'i18n', label: 'i18n', description: 'Internationalization.' },
            { id: 'a11y', label: 'a11y', description: 'Accessibility.' },
          ],
        },
      ],
    }, makeCtx([], {
      answers: [
        { question_id: 'lib', selected_options: ['a'] },
        { question_id: 'features', selected_options: ['i18n', 'a11y'], free_text: 'rtl support pls' },
      ],
    }))

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('User has answered your questions')
    expect(result.content).toContain('Which library?')
    expect(result.content).toContain('date-fns')
    expect(result.content).toContain('Which features to enable?')
    expect(result.content).toContain('i18n')
    expect(result.content).toContain('a11y')
    expect(result.content).toContain('rtl support pls')
    expect(result.content).toContain('You can now continue with the user\'s answers in mind')
    expect(result.content).not.toMatch(/Do NOT/i)
    // W4 R2 (P2-5): 删 Metadata 行
    expect(result.content).not.toMatch(/Metadata:/i)
  })

  it('scheduled 无人值守时不 emit 卡片，自动选择每题第一个选项', async () => {
    const events: unknown[] = []
    const ctx = makeCtx(events, { answers: [{ question_id: 'lib', selected_options: ['b'] }] }, 'scheduled-thread', 'scheduled')
    ctx.waitForUserInput = async () => {
      throw new Error('scheduled ask_user should not wait for HITL response')
    }

    const result = await getTool('ask_user').execute({
      title: 'Scheduled defaults',
      questions: [
        {
          id: 'lib',
          prompt: 'Which library?',
          header: 'Library',
          options: [
            { id: 'a', label: 'date-fns', description: 'Functional.' },
            { id: 'b', label: 'dayjs', description: 'Lightweight.' },
          ],
        },
        {
          id: 'features',
          prompt: 'Which feature?',
          header: 'Feature',
          allow_multiple: true,
          options: [
            { id: 'i18n', label: 'i18n', description: 'Internationalization.' },
            { id: 'a11y', label: 'a11y', description: 'Accessibility.' },
          ],
        },
      ],
    }, ctx)

    expect(result.isError).toBeUndefined()
    expect(events).toHaveLength(0)
    expect(result.content).toContain('Which library?')
    expect(result.content).toContain('date-fns')
    expect(result.content).not.toContain('dayjs')
    expect(result.content).toContain('Which feature?')
    expect(result.content).toContain('i18n')
    expect(result.content).not.toContain('a11y')
  })

  it('user skipped → OUTPUT 是正向单句（无 Do NOT proceed）', async () => {
    const result = await getTool('ask_user').execute({
      title: 'Optional clarification',
      questions: [{
        id: 'q1',
        prompt: 'Optional setting?',
        header: 'Optional',
        options: [
          { id: 'a', label: 'A', description: 'aa' },
          { id: 'b', label: 'B', description: 'bb' },
        ],
      }],
    }, makeCtx([], { skipped: true }))

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('User skipped your ask_user request')
    expect(result.content).toContain('continue with the best available information')
    // 严禁反向指引（dogfood 实测根因）
    expect(result.content).not.toMatch(/Do NOT/i)
    // W4 R2 (P2-5): 删 Metadata 行
    expect(result.content).not.toMatch(/Metadata:/i)
  })

  it('user 用纯文本作答 → 走 free text 路径，OUTPUT 仍然正向', async () => {
    const result = await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'What do you want?',
        header: 'Want',
        options: [
          { id: 'a', label: 'A', description: 'aa' },
          { id: 'b', label: 'B', description: 'bb' },
        ],
      }],
    }, makeCtx([], { text: '用 mongoose 就行' }))

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('User has answered your ask_user request with free text')
    expect(result.content).toContain('用 mongoose 就行')
    expect(result.content).toContain('You can now continue with the user\'s answer in mind')
    expect(result.content).not.toMatch(/Do NOT/i)
    // W4 R2 (P2-5): 删 Metadata 行
    expect(result.content).not.toMatch(/Metadata:/i)
  })

  it('host 不支持（无 emitter / waiter）→ 错误结构化 + hint 正向（无 Do NOT proceed）', async () => {
    const result = await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one',
        header: 'Pick',
        options: [
          { id: 'a', label: 'A', description: 'aa' },
          { id: 'b', label: 'B', description: 'bb' },
        ],
      }],
    }, {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
    })

    expect(result.isError).toBe(true)
    const error = parseError(result.content)
    expect(error.error_kind).toBe('host_unsupported')
    // hint 应该是正向 / 中性，不能含 Do NOT proceed
    const hint = String(error.hint ?? '')
    expect(hint).not.toMatch(/Do NOT proceed/i)
    expect(hint).toContain('Continue with the best available information')
  })

  it('preserves unexpected response shape via free-text fallback (无 Do NOT)', async () => {
    const result = await getTool('ask_user').execute({
      questions: [{
        id: 'q1',
        prompt: 'Pick one',
        header: 'Pick',
        options: [
          { id: 'a', label: 'A', description: 'aa' },
          { id: 'b', label: 'B', description: 'bb' },
        ],
      }],
    }, makeCtx([], { answer: 'legacy answer shape' }))

    // 兜底：响应不带 answers 数组 → OUTPUT 透传响应文本
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('User has answered your ask_user request')
    expect(result.content).toContain('legacy answer shape')
    expect(result.content).not.toMatch(/Do NOT/i)
  })
})

describe('ask_form (W4 R3: 多字段表单)', () => {
  beforeEach(() => {
    __resetAskUserDedupForTest()
  })

  it('合法 fields → emit ASK_FORM_REQUIRED 并把 field_values 写入正向 OUTPUT', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_form').execute({
      title: '三个小问题的记录',
      fields: [
        {
          key: 'small_task',
          label: '今天最想完成的一件小事',
          type: 'textarea',
          description: '可以是很小的事情，比如喝水、散步或完成某个任务。',
        },
        {
          key: 'mood_keywords',
          label: '此刻心情的三个关键词',
          type: 'input',
          placeholder: '例如：平静、期待、专注',
        },
      ],
    }, makeCtx(events, {
      field_values: {
        small_task: '散步',
        mood_keywords: '平静、期待、专注',
      },
    }))

    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(1)
    const event = events[0] as { type: string; payload: Record<string, any> }
    expect(event.type).toBe(StreamEvents.ASK_FORM_REQUIRED)
    expect(event.payload.tool_name).toBe('ask_form')
    expect(event.payload.form_mode).toBe('fields')
    expect(event.payload.fields[0].key).toBe('small_task')
    expect(result.content).toContain('User has answered your ask_form request')
    expect(result.content).toContain('今天最想完成的一件小事')
    expect(result.content).toContain('散步')
  })

  it('支持 name/title 轻量别名归一化为 key/label', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_form').execute({
      title: '别名表单',
      fields: [
        {
          name: 'domain',
          title: '目标域名',
          type: 'input',
          placeholder: 'example.com',
        },
      ],
    }, makeCtx(events, { field_values: { domain: 'tabtin.ai' } }))

    expect(result.isError).toBeUndefined()
    const event = events[0] as { payload: { fields: Array<Record<string, unknown>> } }
    expect(event.payload.fields[0].key).toBe('domain')
    expect(event.payload.fields[0].label).toBe('目标域名')
  })

  it('支持 prompt/id 形态归一化，避免 Tracker 收参卡在 ask_form schema', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_form').execute({
      title: '创建自动化任务',
      fields: [
        {
          id: 'task_name',
          prompt: '自动化任务名称',
          type: 'input',
        },
        {
          id: 'repeat_interval',
          question: '多久执行一次',
          type: 'input',
          placeholder: '例如：每天 09:00',
        },
      ],
    }, makeCtx(events, {
      field_values: {
        task_name: '每日天气提醒',
        repeat_interval: '每天 08:00',
      },
    }))

    expect(result.isError).toBeUndefined()
    const event = events[0] as { payload: { fields: Array<Record<string, unknown>> } }
    expect(event.payload.fields[0]).toMatchObject({
      key: 'task_name',
      label: '自动化任务名称',
      placeholder: '自动化任务名称',
    })
    expect(event.payload.fields[1]).toMatchObject({
      key: 'repeat_interval',
      label: '多久执行一次',
      placeholder: '例如：每天 09:00',
    })
    expect(result.content).toContain('每日天气提醒')
  })

  it('空字段对象先报 fields[0] 为空，不再误报 duplicate value ""', async () => {
    const result = await getTool('ask_form').execute({
      title: '三个小问题的记录',
      fields: [{}, {}, {}],
    }, makeCtx())

    expect(result.isError).toBe(true)
    const error = parseError(result.content)
    expect(error.error_kind).toBe('invalid_param_format')
    expect(error.field).toBe('fields[0]')
    expect(String(error.error)).toContain('field is empty')
    expect(String(error.error)).not.toContain('duplicate value ""')
  })

  it('空 option 子项先报具体缺 id/label，不再误报 duplicate value ""', async () => {
    const result = await getTool('ask_form').execute({
      title: '选择环境',
      fields: [{
        key: 'environment',
        label: '目标环境',
        type: 'select',
        options: [{}, {}],
      }],
    }, makeCtx())

    expect(result.isError).toBe(true)
    const error = parseError(result.content)
    expect(error.error_kind).toBe('invalid_param_format')
    expect(error.field).toBe('fields[0].options[0].id')
    expect(String(error.error)).toContain('option id must be non-empty')
    expect(String(error.error)).not.toContain('duplicate value ""')
  })

  it('label-only fields 由 execute 补 key 与 placeholder（ 瘦 schema）', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_form').execute({
      title: '三个问题',
      fields: [
        { label: '第一个问题' },
        { label: '第二个问题' },
        { label: '第三个问题' },
      ],
    }, makeCtx(events, {
      field_values: {
        第一个问题: 'A',
        第二个问题: 'B',
        第三个问题: 'C',
      },
    }))

    expect(result.isError).toBeUndefined()
    const event = events[0] as { payload: { fields: Array<Record<string, unknown>> } }
    expect(event.payload.fields).toHaveLength(3)
    expect(event.payload.fields[0]?.key).toBe('第一个问题')
    expect(event.payload.fields[0]?.placeholder).toBe('第一个问题')
    expect(event.payload.fields[1]?.key).toBe('第二个问题')
  })

  it('select 选项仅需 label，execute 补 option id', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_form').execute({
      title: '选择环境',
      fields: [{
        label: '目标环境',
        type: 'select',
        options: [{ label: '开发' }, { label: '生产' }],
      }],
    }, makeCtx(events, { field_values: { 目标环境: '开发' } }))

    expect(result.isError).toBeUndefined()
    const field = (events[0] as { payload: { fields: Array<Record<string, unknown>> } }).payload.fields[0]
    expect(field?.options).toEqual([
      { label: '开发', id: '开发' },
      { label: '生产', id: '生产' },
    ])
  })

  it('ask_form LLM schema 只暴露语义字段，不含 i18n / layout 程序键', () => {
    const schema = getTool('ask_form').inputSchema as unknown as {
      properties: {
        fields: {
          items: { properties?: Record<string, unknown> }
        }
      }
    }
    const props = Object.keys(schema.properties.fields.items?.properties ?? {})
    expect(props).toEqual(expect.arrayContaining(['label', 'key', 'type', 'placeholder', 'description', 'options']))
    expect(props).toEqual(expect.arrayContaining(['prompt', 'question', 'text', 'title', 'name', 'id']))
    expect(props).not.toContain('label_key')
    expect(props).not.toContain('visible_when')
    expect(props).not.toContain('addons')
  })

  //  / ：瘦 schema + fields description 示例引导弱模型；禁止空对象。
  it('ask_form fields description 带可照抄示例和 alias 说明（ /  根因引导）', () => {
    const schema = getTool('ask_form').inputSchema as unknown as {
      properties: { fields: { description?: string; items?: { required?: string[] } } }
    }
    const desc = schema.properties.fields.description ?? ''
    expect(desc).toContain('禁止空对象')
    expect(desc).toContain('"label"')
    expect(desc).toContain('prompt')
    expect(desc).toContain('question')
    expect(schema.properties.fields.items?.required).toBeUndefined()
  })
})

// ─── W4 R2 必修 1：session-scoped 重复检测 ──────────────────────────
//
// dogfood Kimi session 22773860 实测：5 次完全 hash 一致的 ask_choice 重复发问。
// 即使 W4 schema 简化 + 文案正向后，极端 case（LLM 卡循环 / 用户切模型 /
// 长会话漂移）仍可能出现。本组测试覆盖 3 个核心场景：
//   (a) 5 分钟窗口内同 hash → 第二次返回合成 OUTPUT，不 emit 卡片
//   (b) 跨 5 分钟窗口 → 允许重新发问
//   (c) questions 内容微调（option label 改一个字符）→ hash 不一致允许

describe('ask_user (W4 R2 必修 1: session-scoped 重复检测)', () => {
  beforeEach(() => {
    __resetAskUserDedupForTest()
  })

  const buildPayload = () => ({
    questions: [{
      id: 'q1',
      prompt: '你想要哪种黑白风格？',
      header: '风格',
      options: [
        { id: 'pure-bw', label: '纯黑白', description: 'Pure black and white only.' },
        { id: 'modern-gray', label: '现代灰', description: 'Modern with gray accents.' },
        { id: 'high-contrast', label: '高对比', description: 'High contrast WCAG AAA.' },
      ],
    }],
  })

  it('(a) 同 session 同 hash 5 分钟内 → 第二次直接返回合成 OUTPUT，不 emit 事件', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []
    const sessionId = 'dogfood-session-22773860'

    // 第 1 次：正常 emit + 用户答 "纯黑白"
    const result1 = await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events1, { answers: [{ question_id: 'q1', selected_options: ['pure-bw'] }] }, sessionId),
    )
    expect(result1.isError).toBeUndefined()
    expect(requiredEvents(events1)).toHaveLength(1)
    expect(result1.content).toContain('纯黑白')

    // 第 2 次：完全相同 input → 命中 dedup，**不** emit 卡片
    const result2 = await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events2, { answers: [{ question_id: 'q1', selected_options: ['anything-else'] }] }, sessionId),
    )
    expect(result2.isError).toBeUndefined()
    expect(events2).toHaveLength(0) // 关键：不再弹卡片
    expect(result2.content).toContain('User has already answered the same questions recently')
    expect(result2.content).toContain('Continue with the prior answer in mind')
    // 复用上次答案（含"纯黑白"）
    expect(result2.content).toContain('纯黑白')
  })

  it('同一用户可见问题仅关联 id 变化 → 命中 dedup，不再次弹卡片', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []
    const sessionId = 'disk-cleanup-loop'

    const buildDiskQuestion = (questionId: string, devOptionId: string) => ({
      questions: [{
        id: questionId,
        prompt: '主磁盘使用率已达 95%（832GB/926GB），空间非常紧张。以下是大头占用项，你想优先清理哪个方向？',
        header: '清理方向',
        allow_multiple: true,
        options: [
          { id: devOptionId, label: '开发目录 (148GB)', description: '深入分析 ~/dev 目录，找出可以清理或迁移的项目' },
          { id: 'appsupport', label: '应用数据 (103GB)', description: '分析 Application Support 里的 Google 25GB、Cursor 18GB、Claude 12GB 等' },
          { id: 'wechat', label: '微信数据 (92GB)', description: '清理微信聊天记录、文件、缓存等' },
          { id: 'caches', label: '缓存与日志 (34GB+)', description: '清理系统缓存、应用缓存、日志文件等' },
        ],
      }],
    })

    const result1 = await getTool('ask_user').execute(
      buildDiskQuestion('cleanup_focus', 'dev'),
      makeCtx(events1, { answers: [{ question_id: 'cleanup_focus', selected_options: ['dev'] }] }, sessionId),
    )
    expect(result1.isError).toBeUndefined()
    expect(requiredEvents(events1)).toHaveLength(1)
    expect(result1.content).toContain('开发目录 (148GB)')

    const result2 = await getTool('ask_user').execute(
      buildDiskQuestion('cleanup_focus2', 'dev_v2'),
      makeCtx(events2, { answers: [{ question_id: 'cleanup_focus2', selected_options: ['dev_v2'] }] }, sessionId),
    )
    expect(result2.isError).toBeUndefined()
    expect(events2).toHaveLength(0)
    expect(result2.content).toContain('User has already answered the same questions recently')
    expect(result2.content).toContain('开发目录 (148GB)')
  })

  it('用户长时间后才回答 → dedup 缓存按回答时间记录，后续同问题仍命中', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []
    const sessionId = 'slow-human-answer'
    const realDateNow = Date.now
    const startedAt = realDateNow()
    let currentNow = startedAt
    Date.now = () => currentNow
    try {
      const slowAnswerCtx: ToolContext = {
        ...makeCtx(events1, { answers: [{ question_id: 'q1', selected_options: ['pure-bw'] }] }, sessionId),
        waitForUserInput: async () => {
          currentNow = startedAt + 25 * 60 * 1000
          return { answers: [{ question_id: 'q1', selected_options: ['pure-bw'] }] }
        },
      }
      const result1 = await getTool('ask_user').execute(buildPayload(), slowAnswerCtx)
      expect(result1.isError).toBeUndefined()
      expect(requiredEvents(events1)).toHaveLength(1)

      currentNow = startedAt + 25 * 60 * 1000 + 1000
      const result2 = await getTool('ask_user').execute(
        buildPayload(),
        makeCtx(events2, { answers: [{ question_id: 'q1', selected_options: ['modern-gray'] }] }, sessionId),
      )
      expect(result2.isError).toBeUndefined()
      expect(events2).toHaveLength(0)
      expect(result2.content).toContain('User has already answered the same questions recently')
      expect(result2.content).toContain('纯黑白')
    } finally {
      Date.now = realDateNow
    }
  })

  it('(b) 跨 5 分钟窗口 → 允许重新发问（窗口过期后重启）', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []
    const sessionId = 's-window-expire'

    // 第 1 次（基线）
    await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events1, { answers: [{ question_id: 'q1', selected_options: ['pure-bw'] }] }, sessionId),
    )
    expect(requiredEvents(events1)).toHaveLength(1)

    // 用 fake time 推进 5 分 + 1 秒（超窗口）
    const realDateNow = Date.now
    const fakeNow = realDateNow() + 5 * 60 * 1000 + 1000
    Date.now = () => fakeNow
    try {
      const result2 = await getTool('ask_user').execute(
        buildPayload(),
        makeCtx(events2, { answers: [{ question_id: 'q1', selected_options: ['modern-gray'] }] }, sessionId),
      )
      expect(result2.isError).toBeUndefined()
      // 关键：窗口过期 → 应该重新 emit 卡片
      expect(requiredEvents(events2)).toHaveLength(1)
      expect(result2.content).toContain('现代灰')
      expect(result2.content).not.toContain('User has already answered the same')
    } finally {
      Date.now = realDateNow
    }
  })

  it('(c) options 微调（label 改一个字符）→ hash 不一致 → 允许重新发问', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []
    const sessionId = 's-hash-sensitive'

    await getTool('ask_user').execute(
      {
        questions: [{
          id: 'q1',
          prompt: 'Pick a color',
          header: 'Color',
          options: [
            { id: 'a', label: 'Red', description: 'Red.' },
            { id: 'b', label: 'Blue', description: 'Blue.' },
          ],
        }],
      },
      makeCtx(events1, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }, sessionId),
    )
    expect(requiredEvents(events1)).toHaveLength(1)

    // 改了 label "Red" → "Crimson"，hash 应不同
    const result2 = await getTool('ask_user').execute(
      {
        questions: [{
          id: 'q1',
          prompt: 'Pick a color',
          header: 'Color',
          options: [
            { id: 'a', label: 'Crimson', description: 'Red.' },
            { id: 'b', label: 'Blue', description: 'Blue.' },
          ],
        }],
      },
      makeCtx(events2, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }, sessionId),
    )
    expect(result2.isError).toBeUndefined()
    expect(requiredEvents(events2)).toHaveLength(1) // 关键：内容不同 → 重新 emit
    expect(result2.content).not.toContain('User has already answered the same')
  })

  it('跨 session 不共享 dedup（避免误命中其它会话）', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []

    await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events1, { answers: [{ question_id: 'q1', selected_options: ['pure-bw'] }] }, 'session-A'),
    )
    expect(requiredEvents(events1)).toHaveLength(1)

    // 不同 session 同 hash → 不命中 dedup
    const result2 = await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events2, { answers: [{ question_id: 'q1', selected_options: ['pure-bw'] }] }, 'session-B'),
    )
    expect(requiredEvents(events2)).toHaveLength(1)
    expect(result2.content).not.toContain('User has already answered the same')
  })
})

// ：single_hitl_resolved 终态回流——runtime 在 waiter 结束后对称补发终态事件，
// 供 Django relay 落 PG 终态 + reliable 重广播，全端收敛关面板。这里锁定 runtime
// 发射契约：answered / skipped / timeout 三态都发、携带 request_id + thread_id。
describe('ask_user (: single_hitl_resolved 终态回流)', () => {
  beforeEach(() => {
    __resetAskUserDedupForTest()
  })

  const buildPayload = () => ({
    questions: [{
      id: 'q1',
      prompt: '选一个',
      header: '选择',
      options: [
        { id: 'a', label: 'A', description: 'option A' },
        { id: 'b', label: 'B', description: 'option B' },
      ],
    }],
  })

  it('用户回答后补发 single_hitl_resolved(outcome=answered) 且与 *_required 同 request_id', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }, 'sess-answered'),
    )
    const required = requiredEvents(events)[0] as { payload: { request_id?: string } }
    const resolved = resolvedEvents(events)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].payload.outcome).toBe('answered')
    expect(resolved[0].payload.thread_id).toBe('sess-answered')
    // 终态按 request_id 定位，必须与发起时一致
    expect(resolved[0].payload.request_id).toBe(required.payload.request_id)
    expect(resolved[0].payload.request_id).toBeTruthy()
  })

  it('用户跳过后补发 single_hitl_resolved(outcome=skipped)', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events, { skipped: true }, 'sess-skipped'),
    )
    const resolved = resolvedEvents(events)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].payload.outcome).toBe('skipped')
  })

  it('waiter 失败/超时后补发 single_hitl_resolved(outcome=expired)', async () => {
    const events: unknown[] = []
    const ctx = makeCtx(events, undefined, 'sess-expired')
    // 模拟 waiter reject（等价超时 / 通道异常）——终态仍应发出让面板收敛
    ctx.waitForUserInput = async () => { throw new Error('channel closed') }
    const result = await getTool('ask_user').execute(buildPayload(), ctx)
    expect(result.isError).toBe(true)
    const resolved = resolvedEvents(events)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].payload.outcome).toBe('expired')
  })

  it('命中 session dedup（未真正发起）时不补发终态事件', async () => {
    const events1: unknown[] = []
    const events2: unknown[] = []
    await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events1, { answers: [{ question_id: 'q1', selected_options: ['a'] }] }, 'sess-dedup'),
    )
    expect(resolvedEvents(events1)).toHaveLength(1)

    // 第二次同 input 命中 dedup：既不 emit required，也不应 emit resolved
    await getTool('ask_user').execute(
      buildPayload(),
      makeCtx(events2, { answers: [{ question_id: 'q1', selected_options: ['b'] }] }, 'sess-dedup'),
    )
    expect(requiredEvents(events2)).toHaveLength(0)
    expect(resolvedEvents(events2)).toHaveLength(0)
  })
})

// ─── ：连续 ask 熔断（措辞漂移绕过 content-hash 去重的确认循环）─────────
//
// dedup 只拦「一字不差的重复」；模型把问法轻微改写就能绕过。本组测试锁定「尾部
// 连续只调 ask 工具、无实质进展」达阈值（4）时不再 emit 卡片、返回纠偏 OUTPUT，
// 且任意非 ask 工具调用会打断连续计数。
describe('ask 工具 (: 连续 ask 熔断)', () => {
  beforeEach(() => {
    __resetAskUserDedupForTest()
  })

  const buildPayload = () => ({
    questions: [{
      id: 'q1',
      prompt: '是否继续?',
      header: '确认',
      options: [
        { id: 'yes', label: '是', description: '继续执行。' },
        { id: 'no', label: '否', description: '停止执行。' },
      ],
    }],
  })

  // 措辞每次不同，模拟绕过 content-hash dedup 的确认循环。
  const buildRewordedPayload = (prompt: string) => ({
    questions: [{
      id: 'q1',
      prompt,
      header: '确认',
      options: [
        { id: 'yes', label: '是', description: '继续执行。' },
        { id: 'no', label: '否', description: '停止执行。' },
      ],
    }],
  })

  const askAssistantMessage = (name: string): Message => ({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '继续' },
      { type: 'tool_use', id: `tu-${Math.random()}`, name, input: {} },
    ],
  })

  const toolResultMessage = (): Message => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu', content: '是' }],
  })

  const workAssistantMessage = (): Message => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-work', name: 'read_file', input: { path: '/tmp/x' } }],
  })

  const ctxWith = (messages: Message[], events: unknown[]): ToolContext => ({
    threadId: 'loop-thread',
    runtimeId: 'rt',
    agentRunId: 'ar-test',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages,
    emitStreamEvent: (event) => events.push(event),
    waitForUserInput: async () => ({ answers: [{ question_id: 'q1', selected_options: ['yes'] }] }),
  })

  it('连续第 4 次 ask（含本次）→ 不 emit 卡片，返回纠偏 OUTPUT', async () => {
    const events: unknown[] = []
    // 尾部 4 个 assistant ask 回合（含"本次"），中间穿插 tool_result（不打断）
    const messages: Message[] = [
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'),
    ]
    const result = await getTool('ask_user').execute(buildPayload(), ctxWith(messages, events))

    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(0) // 关键：不再弹卡片
    expect(resolvedEvents(events)).toHaveLength(0) // 未真正发起 → 不补终态
    expect(String(result.content)).toContain('confirmation loop')
    expect(String(result.content)).toContain('was not shown to the user')
  })

  it('措辞漂移绕过 dedup，但连续 4 次仍被熔断', async () => {
    const events: unknown[] = []
    const messages: Message[] = [
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'),
    ]
    // 换措辞，dedup 因 hash 不同不命中；但连续计数命中熔断。
    const result = await getTool('ask_user').execute(
      buildRewordedPayload('是否继续读取并分析文件？'),
      ctxWith(messages, events),
    )
    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(0)
    expect(String(result.content)).toContain('confirmation loop')
  })

  it('连续 3 次（未达阈值）→ 正常 emit 卡片', async () => {
    const events: unknown[] = []
    const messages: Message[] = [
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'),
    ]
    const result = await getTool('ask_user').execute(buildPayload(), ctxWith(messages, events))
    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(1) // 正常弹卡片
    expect(String(result.content)).not.toContain('confirmation loop')
  })

  it('中间有实质工具调用（read_file）→ 连续计数被打断，正常 emit', async () => {
    const events: unknown[] = []
    // 尾部虽有多次 ask，但 read_file 打断了连续性，只算它之后的 1 次（本次）
    const messages: Message[] = [
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_user'), toolResultMessage(),
      workAssistantMessage(), toolResultMessage(),
      askAssistantMessage('ask_user'),
    ]
    const result = await getTool('ask_user').execute(buildPayload(), ctxWith(messages, events))
    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(1)
  })

  it('跨 ask 工具计入同一连续计数（含历史 request_approval 回合）', async () => {
    const events: unknown[] = []
    const messages: Message[] = [
      askAssistantMessage('ask_user'), toolResultMessage(),
      askAssistantMessage('ask_form'), toolResultMessage(),
      // request_approval 已下架，但 resume 的历史消息里可能存在——仍计入连续 ask 计数
      askAssistantMessage('request_approval'), toolResultMessage(),
      askAssistantMessage('ask_user'),
    ]
    const result = await getTool('ask_user').execute(buildPayload(), ctxWith(messages, events))
    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(0) // 4 次跨工具连续 → 熔断
    expect(String(result.content)).toContain('confirmation loop')
  })

  it('空 messages（测试/旧宿主）→ 计数为 0，不误熔断', async () => {
    const events: unknown[] = []
    const result = await getTool('ask_user').execute(buildPayload(), ctxWith([], events))
    expect(result.isError).toBeUndefined()
    expect(requiredEvents(events)).toHaveLength(1)
  })
})

// ───  · P0 修复：挂起前 assistant partial persist ─────────
//
// 契约：ask 工具挂起前必须补一次 assistant partial persist，让 crash mid-await
// 后 `restoreMessages` 能带出 tool_use，restorer inject 的 tool_result 走真实
// pairing。缺 assistantMessageId（旧宿主）时 no-op、不破坏原路径。
describe('ask 工具（ P0：挂起前 partial persist）', () => {
  beforeEach(() => {
    __resetAskUserDedupForTest()
  })

  const buildAskPayload = () => ({
    questions: [{
      id: 'q1',
      prompt: 'Pick one?',
      header: 'Pick',
      options: [
        { id: 'a', label: 'A', description: 'opt a' },
        { id: 'b', label: 'B', description: 'opt b' },
      ],
    }],
  })

  const persistMessageEvents = (events: unknown[]) => events.filter(
    (e) => (e as { type?: string }).type === StreamEvents.PERSIST_MESSAGE,
  ) as Array<{ payload: Record<string, unknown> }>

  it('context 带 assistantMessageId + assistant 有 tool_use → emit 一条 partial=true 的 PersistMessageEvent', async () => {
    const events: unknown[] = []
    const assistantMsg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking about it' },
        { type: 'tool_use', id: 'tuid-real-llm', name: 'ask_user', input: { questions: [] } },
      ],
    }

    await getTool('ask_user').execute(buildAskPayload(), {
      threadId: 't-partial',
      runtimeId: 'rt',
      agentRunId: 'ar-test',
      toolUseId: 'tuid-real-llm',
      abortSignal: new AbortController().signal,
      messages: [assistantMsg],
      assistantMessageId: 'msg-assist-42',
      assistantSubagentRunId: undefined,
      emitStreamEvent: (event) => events.push(event),
      waitForUserInput: async () => ({ answers: [{ question_id: 'q1', selected_options: ['a'] }] }),
    } as unknown as ToolContext)

    // 找到 partial 的 PersistMessageEvent（非 HITL transcript：message_kind='llm' + partial=true）
    const partial = persistMessageEvents(events).find(
      (e) => e.payload.message_kind === 'llm' && e.payload.partial === true,
    )
    expect(partial).toBeTruthy()
    expect(partial!.payload.message_id).toBe('msg-assist-42')
    expect(partial!.payload.role).toBe('assistant')
    expect(partial!.payload.stop_reason).toBe('tool_use')
    const blocks = partial!.payload.blocks_json as Array<{ type: string; id?: string }>
    expect(blocks.some((b) => b.type === 'tool_use' && b.id === 'tuid-real-llm')).toBe(true)
  })

  it('partial persist 在 *_required 卡片事件之前 emit（crash mid-await 时才能被 Django 落库）', async () => {
    // 关键顺序契约：partial persist（同步 emit）→ interrupt.interrupt 里 emit *_required
    // → 挂起 await；若顺序倒转、crash 发生在 partial persist 前，assistant tool_use
    // 仍会丢，本 P0 修复失效。
    const events: unknown[] = []
    const assistantMsg: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tuid-order-check', name: 'ask_user', input: {} },
      ],
    }

    await getTool('ask_user').execute(buildAskPayload(), {
      threadId: 't-order',
      runtimeId: 'rt',
      agentRunId: 'ar-test',
      toolUseId: 'tuid-order-check',
      abortSignal: new AbortController().signal,
      messages: [assistantMsg],
      assistantMessageId: 'msg-order-1',
      emitStreamEvent: (event) => events.push(event),
      waitForUserInput: async () => ({ answers: [{ question_id: 'q1', selected_options: ['a'] }] }),
    } as unknown as ToolContext)

    const partialIdx = events.findIndex(
      (e) =>
        (e as { type?: string }).type === StreamEvents.PERSIST_MESSAGE
        && ((e as { payload?: Record<string, unknown> }).payload?.partial === true)
        && ((e as { payload?: Record<string, unknown> }).payload?.message_kind === 'llm'),
    )
    const requiredIdx = events.findIndex(
      (e) => (e as { type?: string }).type === StreamEvents.ASK_USER_REQUIRED,
    )
    expect(partialIdx).toBeGreaterThan(-1)
    expect(requiredIdx).toBeGreaterThan(-1)
    expect(partialIdx).toBeLessThan(requiredIdx)
  })

  it('*_required 卡片 payload 带上 LLM tool_use.id（Django PendingInteraction.payload 存 → resume wire 带出 → restorer 配对）', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute(buildAskPayload(), {
      threadId: 't-tuid',
      runtimeId: 'rt',
      agentRunId: 'ar-test',
      toolUseId: 'tuid-transport-check',
      abortSignal: new AbortController().signal,
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tuid-transport-check', name: 'ask_user', input: {} }],
      }],
      assistantMessageId: 'msg-transport',
      emitStreamEvent: (event) => events.push(event),
      waitForUserInput: async () => ({ answers: [{ question_id: 'q1', selected_options: ['a'] }] }),
    } as unknown as ToolContext)

    const askRequired = events.find(
      (e) => (e as { type?: string }).type === StreamEvents.ASK_USER_REQUIRED,
    ) as { payload: Record<string, unknown> } | undefined
    expect(askRequired).toBeTruthy()
    expect(askRequired!.payload.tool_use_id).toBe('tuid-transport-check')
  })

  it('缺 assistantMessageId（旧宿主 / 测试 stub）→ 不 emit partial persist（no-op），原路径不回归', async () => {
    const events: unknown[] = []
    await getTool('ask_user').execute(buildAskPayload(), {
      threadId: 't-legacy',
      runtimeId: 'rt',
      agentRunId: 'ar-test',
      toolUseId: 'mock',
      abortSignal: new AbortController().signal,
      // messages 里有 assistant，但没传 assistantMessageId（旧宿主兼容路径）
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-legacy', name: 'ask_user', input: {} }],
      }],
      // assistantMessageId 故意缺席
      emitStreamEvent: (event) => events.push(event),
      waitForUserInput: async () => ({ answers: [{ question_id: 'q1', selected_options: ['a'] }] }),
    } as unknown as ToolContext)

    // 无 partial=true & message_kind=llm 的 PersistMessageEvent
    const partial = persistMessageEvents(events).find(
      (e) => e.payload.message_kind === 'llm' && e.payload.partial === true,
    )
    expect(partial).toBeUndefined()
    // 但 HITL transcript（pending / resolved）仍然发（原路径不回归）
    const hitl = persistMessageEvents(events).filter(
      (e) => e.payload.message_kind === 'hitl_interaction',
    )
    expect(hitl.length).toBeGreaterThan(0)
  })
})
