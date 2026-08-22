import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

const { chatState, runtimeState, toastMock, telemetryMock, auditAppendMock } = vi.hoisted(() => ({
  chatState: {
    sendMessage: vi.fn(),
    streamingBySessionId: {} as Record<string, boolean>,
    messagesBySessionId: {} as Record<string, ChatMessage[]>,
  },
  runtimeState: {
    richContentBlocksBySessionId: {} as Record<string, unknown[]>,
  },
  toastMock: vi.fn(),
  telemetryMock: vi.fn(),
  auditAppendMock: vi.fn(),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => chatState,
  },
}))

vi.mock('@stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => runtimeState,
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: toastMock,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}))

vi.mock('@stores/chat/execution/chatTelemetry', () => ({
  trackChatTelemetry: telemetryMock,
}))

import {
  __resetWidgetSendPromptForTests,
  getWidgetSendPromptDevEvents,
  registerWidgetSendPromptIframe,
  unregisterWidgetSendPromptIframe,
} from './widgetSendPromptHandler'

function makeIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  return iframe
}

function dispatchSendPrompt(source: Window | null, data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    source,
  }))
}

function installWidget(sessionId: string, widgetId: string): void {
  chatState.messagesBySessionId[sessionId] = [{
    id: `msg-${widgetId}`,
    role: 'assistant',
    content: '',
    created_at: '2026-04-30T00:00:00.000Z',
    content_blocks_json: [{
      type: 'rich_content',
      kind: 'widget',
      summary: 'widget',
      widget_id: widgetId,
      code: '<svg/>',
    }],
  }]
}

describe('widgetSendPromptHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetWidgetSendPromptForTests()
    document.body.innerHTML = ''
    chatState.sendMessage.mockResolvedValue(undefined)
    chatState.streamingBySessionId = {}
    chatState.messagesBySessionId = {}
    runtimeState.richContentBlocksBySessionId = {}
    // Widget Wave 7 补丁：mock preload audit API 让成功路径的 fire-and-forget
    // 写盘被断言到。默认 resolve，测试里需要"失败不阻塞"分支时临时改 reject。
    auditAppendMock.mockResolvedValue({ ok: true })
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      widgetAudit: { append: auditAppendMock },
    }
  })

  it('trusted iframe source 会调用统一 sendMessage 路径并记录 widget_send_prompt（新协议：无 widget_id 字段）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    // P0-1 修复后：新 wrapper 协议 postMessage 不带 widget_id / session_id / timestamp
    // 父页从 trustedFrames 反推这些字段
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '  详细解释 ingress 控制器  ',
      meta: { node: 'ingress' },
    })

    await Promise.resolve()

    expect(chatState.sendMessage).toHaveBeenCalledWith(
      '详细解释 ingress 控制器',
      true,
      undefined,
      undefined,
      'session-a',
      expect.objectContaining({
        source: 'widget',
        widgetId: 'wgt_a', // 来自 registry 反推，不是来自 data
        widgetMeta: { node: 'ingress' },
      }),
    )
    expect(getWidgetSendPromptDevEvents()[0]).toMatchObject({
      type: 'widget_send_prompt',
      widget_id: 'wgt_a',
      session_id: 'session-a',
      text: '详细解释 ingress 控制器',
      meta: { node: 'ingress' },
    })
  })

  it('untrusted source 被忽略，不触发 sendMessage', async () => {
    const iframe = makeIframe()
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'wgt_a',
      text: '恶意触发',
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
    expect(telemetryMock).toHaveBeenCalledWith(
      'widget_send_prompt.ignored_untrusted_source',
      {},
      expect.objectContaining({ level: 'warn' }),
    )
  })

  it('同 widget 1 分钟最多 5 次，第 6 次限流', async () => {
    installWidget('session-a', 'wgt_rate')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_rate',
      sessionId: 'session-a',
    })

    for (let i = 0; i < 6; i++) {
      dispatchSendPrompt(iframe.contentWindow, {
        type: 'tabtin:sendPrompt',
        text: `第 ${i} 次`,
      })
    }

    await Promise.resolve()

    expect(chatState.sendMessage).toHaveBeenCalledTimes(5)
    expect(toastMock).toHaveBeenCalledWith({ title: 'Widget 触发过于频繁，已限流' })
  })

  it('限流按 sessionId + widgetId 隔离，同名 widget 跨 session 不互相消耗额度', async () => {
    installWidget('session-a', 'wgt_same')
    installWidget('session-b', 'wgt_same')
    const iframeA = makeIframe()
    const iframeB = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframeA.contentWindow!,
      widgetId: 'wgt_same',
      sessionId: 'session-a',
    })
    registerWidgetSendPromptIframe({
      source: iframeB.contentWindow!,
      widgetId: 'wgt_same',
      sessionId: 'session-b',
    })

    for (let i = 0; i < 5; i++) {
      dispatchSendPrompt(iframeA.contentWindow, {
        type: 'tabtin:sendPrompt',
        text: `A ${i}`,
      })
    }
    dispatchSendPrompt(iframeB.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: 'B 仍应可发送',
    })

    await Promise.resolve()

    expect(chatState.sendMessage).toHaveBeenCalledTimes(6)
    expect(chatState.sendMessage).toHaveBeenLastCalledWith(
      'B 仍应可发送',
      true,
      undefined,
      undefined,
      'session-b',
      expect.objectContaining({ widgetId: 'wgt_same' }),
    )
  })

  it('父页面重新拒绝超大 meta，防止绕过 wrapper 直接 postMessage', async () => {
    installWidget('session-a', 'wgt_meta')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_meta',
      sessionId: 'session-a',
    })

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '合法文本',
      meta: { payload: 'x'.repeat(5000) },
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({ title: 'Widget 附加信息过大，已拒绝发送' })
  })

  it('多 widget / 多 session 不串台', async () => {
    installWidget('session-a', 'wgt_a')
    installWidget('session-b', 'wgt_b')
    const iframeA = makeIframe()
    const iframeB = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframeA.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })
    registerWidgetSendPromptIframe({
      source: iframeB.contentWindow!,
      widgetId: 'wgt_b',
      sessionId: 'session-b',
    })

    dispatchSendPrompt(iframeA.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: 'A 节点',
    })
    dispatchSendPrompt(iframeB.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: 'B 节点',
    })

    await Promise.resolve()

    expect(chatState.sendMessage).toHaveBeenNthCalledWith(
      1,
      'A 节点',
      true,
      undefined,
      undefined,
      'session-a',
      expect.objectContaining({ widgetId: 'wgt_a' }),
    )
    expect(chatState.sendMessage).toHaveBeenNthCalledWith(
      2,
      'B 节点',
      true,
      undefined,
      undefined,
      'session-b',
      expect.objectContaining({ widgetId: 'wgt_b' }),
    )
  })

  it('unregister 后同一 iframe 再 postMessage 会被拒绝', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })
    unregisterWidgetSendPromptIframe(iframe.contentWindow)

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '不应该发送',
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
  })
})

// ─── P0-1 安全修复验证（2026-04-30）────────────────────────────────────
//
// 独立验证 Agent 提出的三层纵深防御攻击链：
//   1. unclosed <script> 绕过 scrub → scrub 已在 sanitizer.test.ts 守住（第一层）
//   2. widget 明文 widget_id → wrapper.ts 已在 widget-tokens.test.ts 守住（第二层）
//   3. 即使 widget 内恶意 script 直接 parent.postMessage 伪造字段 →
//      父页 trustedFrames 反推 + hard check 兜底（第三层，本测试覆盖）
describe('widgetSendPromptHandler — P0-1 第三层：data 字段不可信，只从 registry 反推', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetWidgetSendPromptForTests()
    document.body.innerHTML = ''
    chatState.sendMessage.mockResolvedValue(undefined)
    chatState.streamingBySessionId = {}
    chatState.messagesBySessionId = {}
    runtimeState.richContentBlocksBySessionId = {}
    auditAppendMock.mockResolvedValue({ ok: true })
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      widgetAudit: { append: auditAppendMock },
    }
  })

  it('widget 伪造 widget_id → 父页仍用 registry 反推的真实 widgetId（忽略伪造值）', async () => {
    // 场景：恶意 widget_A 内 script 绕过 sanitizer，直接伪造 postMessage 说自己是 widget_B
    // 期望：父页从 registry 查 event.source → 得到 widget_A，忽略 data.widget_id='widget_B'
    chatState.messagesBySessionId['session-attack'] = [
      {
        id: 'msg-A',
        role: 'assistant',
        content: '',
        created_at: '2026-04-30T00:00:00.000Z',
        content_blocks_json: [{
          type: 'rich_content',
          kind: 'widget',
          summary: 'A',
          widget_id: 'widget_A',
          code: '<svg/>',
        }],
      },
      {
        id: 'msg-B',
        role: 'assistant',
        content: '',
        created_at: '2026-04-30T00:00:00.000Z',
        content_blocks_json: [{
          type: 'rich_content',
          kind: 'widget',
          summary: 'B',
          widget_id: 'widget_B',
          code: '<svg/>',
        }],
      },
    ]
    const iframeA = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframeA.contentWindow!,
      widgetId: 'widget_A',
      sessionId: 'session-attack',
    })

    // 伪造 widget_id 和 session_id（attack: 尝试 impersonate widget_B）
    dispatchSendPrompt(iframeA.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'widget_B', // 伪造
      session_id: 'other-session', // 伪造
      timestamp: 999999999, // 伪造
      text: '应该用 widget_A + session-attack',
    })

    await Promise.resolve()

    // 父页只用 registry 反推的 widgetId，不用 data 里的
    expect(chatState.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatState.sendMessage).toHaveBeenCalledWith(
      '应该用 widget_A + session-attack',
      true,
      undefined,
      undefined,
      'session-attack', // registry 反推，不是 data.session_id
      expect.objectContaining({ widgetId: 'widget_A' }), // registry 反推，不是 data.widget_id
    )
    // 记录伪造 telemetry（claimed_id_mismatch）——给安全团队用
    expect(telemetryMock).toHaveBeenCalledWith(
      'widget_send_prompt.claimed_id_mismatch',
      expect.objectContaining({
        claimed_widget_id: 'widget_B',
        actual_widget_id: 'widget_A',
      }),
      expect.objectContaining({ level: 'warn' }),
    )
  })

  it('widget 伪造 widget_id 完全匹配其他 session 的真实 widget → 仍按 registry 路由（不跨 session 泄漏）', async () => {
    // 极端 attack：widget_A 在 session-A 里，尝试伪造说自己是 widget_X@session-B
    installWidget('session-A', 'widget_A')
    installWidget('session-B', 'widget_X')
    const iframeA = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframeA.contentWindow!,
      widgetId: 'widget_A',
      sessionId: 'session-A',
    })

    dispatchSendPrompt(iframeA.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'widget_X', // 真实存在于 session-B
      session_id: 'session-B', // 真实 session
      text: '跨 session 伪造',
    })

    await Promise.resolve()

    // 仍然发到 session-A（不受 data 字段欺骗）
    expect(chatState.sendMessage).toHaveBeenCalledWith(
      '跨 session 伪造',
      true,
      undefined,
      undefined,
      'session-A',
      expect.objectContaining({ widgetId: 'widget_A' }),
    )
  })

  it('text > 1000 字符被拒（hard check）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: 'x'.repeat(1001),
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({ title: 'Widget 触发内容无效' })
  })

  it('text 非 string 被拒（hard check）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    for (const badText of [null, undefined, 123, {}, [], true]) {
      dispatchSendPrompt(iframe.contentWindow, {
        type: 'tabtin:sendPrompt',
        text: badText,
      })
      await Promise.resolve()
    }

    expect(chatState.sendMessage).not.toHaveBeenCalled()
  })

  it('text 含 NUL / C0 控制字符被剥除（不污染下游）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '合法内容\u0000\u0001\u001f\u007f',
    })

    await Promise.resolve()

    expect(chatState.sendMessage).toHaveBeenCalledTimes(1)
    const sentText = chatState.sendMessage.mock.calls[0][0]
    expect(sentText).toBe('合法内容')
    // 控制字符被剥除，合法 \t \n \r 应保留
    expect(sentText).not.toMatch(/[\u0000\u0001\u001f\u007f]/)
  })

  it('text 全是控制字符 → trim 后为空被拒', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '\u0000\u0001\u001f', // 剥除后空
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
  })

  it('meta 超过 4KB 被拒（hard check）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '合法',
      meta: { blob: 'x'.repeat(5000) },
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({ title: 'Widget 附加信息过大，已拒绝发送' })
  })

  it('meta 含循环引用 / 不可 JSON 序列化 被拒（hard check）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '合法',
      meta: circular,
    })

    await Promise.resolve()

    expect(chatState.sendMessage).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({ title: 'Widget 附加信息过大，已拒绝发送' })
  })

  it('timestamp 从父页 Date.now() 取，不信 data.timestamp（防伪造时间）', async () => {
    installWidget('session-a', 'wgt_a')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_a',
      sessionId: 'session-a',
    })

    const before = Date.now()
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '测试时间戳',
      timestamp: 1, // 伪造 1970 年的时间
    })

    await Promise.resolve()
    const after = Date.now()

    expect(chatState.sendMessage).toHaveBeenCalledTimes(1)
    const events = getWidgetSendPromptDevEvents()
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before)
    expect(events[0].timestamp).toBeLessThanOrEqual(after)
    expect(events[0].timestamp).not.toBe(1) // 伪造的时间戳被忽略
  })

  it('**端到端攻击链**：widget 完整攻击模拟 → 每层防御都挡住，sendMessage 从未被调', async () => {
    // 假设 attacker 侥幸绕过了 sanitizer（本测试不测 sanitizer，只测父页层）
    // 通过 postMessage 发出完整伪造攻击 payload：
    //   - 伪造 widget_id（不同 widget / 不同 session 的）
    //   - 超长 text / 含 NUL 控制字符的 text
    //   - 超大 meta
    //   - 伪造 timestamp
    // 场景 1-3 都有 trusted source（已 registered，最坏情况），验证仍然被挡
    installWidget('session-attacker', 'wgt_attacker')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_attacker',
      sessionId: 'session-attacker',
    })

    // 攻击 1: 伪造 widget_id 尝试 impersonate（被 registry 反推挡）
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'wgt_victim_admin', // 伪造
      text: '伪造 widget',
    })
    await Promise.resolve()
    // 仍被发出但 widgetId 是真实的 wgt_attacker
    expect(chatState.sendMessage).toHaveBeenCalledWith(
      '伪造 widget',
      true,
      undefined,
      undefined,
      'session-attacker',
      expect.objectContaining({ widgetId: 'wgt_attacker' }),
    )
    chatState.sendMessage.mockClear()

    // 攻击 2: 超长 text
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: 'x'.repeat(10000),
    })
    await Promise.resolve()
    expect(chatState.sendMessage).not.toHaveBeenCalled()

    // 攻击 3: 含控制字符 + 超大 meta 混合
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: 'rm -rf /\u0000echo owned',
      meta: { hidden: 'y'.repeat(5000) },
    })
    await Promise.resolve()
    // text 被清理只剩 'rm -rf /echo owned'（\u0000 剥除），但 meta 超大被拒
    expect(chatState.sendMessage).not.toHaveBeenCalled()
  })
})

describe('widgetSendPromptHandler — Wave 7 补丁：session 级总上限', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetWidgetSendPromptForTests()
    document.body.innerHTML = ''
    chatState.sendMessage.mockResolvedValue(undefined)
    chatState.streamingBySessionId = {}
    chatState.messagesBySessionId = {}
    runtimeState.richContentBlocksBySessionId = {}
    auditAppendMock.mockResolvedValue({ ok: true })
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      widgetAudit: { append: auditAppendMock },
    }
  })

  it('5 个 widget 各 3 次 = 15 次通过，第 16 次（任意 widget）触发 session 级拒', async () => {
    // 安装 5 个 widget，都在 session-a
    const widgetIds = ['wgt1', 'wgt2', 'wgt3', 'wgt4', 'wgt5']
    chatState.messagesBySessionId['session-a'] = widgetIds.map((id) => ({
      id: `msg-${id}`,
      role: 'assistant',
      content: '',
      created_at: '2026-04-30T00:00:00.000Z',
      content_blocks_json: [{
        type: 'rich_content',
        kind: 'widget',
        summary: `widget ${id}`,
        widget_id: id,
        code: '<svg/>',
      }],
    }))
    const iframes = widgetIds.map((id) => {
      const frame = makeIframe()
      registerWidgetSendPromptIframe({
        source: frame.contentWindow!,
        widgetId: id,
        sessionId: 'session-a',
      })
      return { id, frame }
    })

    // 每个 widget 点 3 次：3 * 5 = 15 次都通过
    for (const { id, frame } of iframes) {
      for (let i = 0; i < 3; i++) {
        dispatchSendPrompt(frame.contentWindow, {
          type: 'tabtin:sendPrompt',
          widget_id: id,
          text: `${id} #${i}`,
        })
      }
    }
    await Promise.resolve()
    expect(chatState.sendMessage).toHaveBeenCalledTimes(15)

    // 第 16 次，任何 widget（不会 hit widget 级上限因为每个只点了 3 次）
    dispatchSendPrompt(iframes[0].frame.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: iframes[0].id,
      text: '第 16 次应触发 session 级',
    })
    await Promise.resolve()

    expect(chatState.sendMessage).toHaveBeenCalledTimes(15) // 没增加
    expect(toastMock).toHaveBeenCalledWith({ title: '本轮 widget 操作过于频繁，请稍后再试' })
    expect(telemetryMock).toHaveBeenCalledWith(
      'widget_send_prompt.session_rate_limited',
      expect.objectContaining({ widget_id: iframes[0].id, sessionId: 'session-a' }),
      expect.objectContaining({ level: 'warn', counterKey: 'widget_send_prompt.session_rate_limited' }),
    )
  })

  it('1 widget 5 次 + 另一 widget 5 次 + 第三 widget 5 次 = 15 通过，第 16 次拒且 session 级文案区分于 widget 级', async () => {
    const widgetIds = ['wgA', 'wgB', 'wgC']
    chatState.messagesBySessionId['session-b'] = widgetIds.map((id) => ({
      id: `msg-${id}`,
      role: 'assistant',
      content: '',
      created_at: '2026-04-30T00:00:00.000Z',
      content_blocks_json: [{
        type: 'rich_content',
        kind: 'widget',
        summary: `widget ${id}`,
        widget_id: id,
        code: '<svg/>',
      }],
    }))
    const iframes = widgetIds.map((id) => {
      const frame = makeIframe()
      registerWidgetSendPromptIframe({
        source: frame.contentWindow!,
        widgetId: id,
        sessionId: 'session-b',
      })
      return { id, frame }
    })

    // 每个 widget 5 次（刚好碰 widget 级的 max 但不超）
    for (const { id, frame } of iframes) {
      for (let i = 0; i < 5; i++) {
        dispatchSendPrompt(frame.contentWindow, {
          type: 'tabtin:sendPrompt',
          widget_id: id,
          text: `${id} #${i}`,
        })
      }
    }
    await Promise.resolve()
    expect(chatState.sendMessage).toHaveBeenCalledTimes(15)

    // 任何已有 widget 第 6 次 → 先命中 widget 级限流（它那个 widget 已 5 次），
    // 不是 session 级。文案应是 widget 级。
    dispatchSendPrompt(iframes[0].frame.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: iframes[0].id,
      text: 'wgA 第 6 次',
    })
    await Promise.resolve()
    expect(toastMock).toHaveBeenLastCalledWith({ title: 'Widget 触发过于频繁，已限流' })

    // 再开新 widget（没贴过 widget 级限流）——此时 session 级已满，应 session 级文案
    const wgD = makeIframe()
    chatState.messagesBySessionId['session-b'].push({
      id: 'msg-wgD',
      role: 'assistant',
      content: '',
      created_at: '2026-04-30T00:00:00.000Z',
      content_blocks_json: [{
        type: 'rich_content',
        kind: 'widget',
        summary: 'widget D',
        widget_id: 'wgD',
        code: '<svg/>',
      }],
    })
    registerWidgetSendPromptIframe({
      source: wgD.contentWindow!,
      widgetId: 'wgD',
      sessionId: 'session-b',
    })
    dispatchSendPrompt(wgD.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'wgD',
      text: 'wgD 首次',
    })
    await Promise.resolve()
    expect(toastMock).toHaveBeenLastCalledWith({ title: '本轮 widget 操作过于频繁，请稍后再试' })
    expect(chatState.sendMessage).toHaveBeenCalledTimes(15) // 仍然是 15
  })
})

describe('widgetSendPromptHandler — Wave 7 补丁：audit log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetWidgetSendPromptForTests()
    document.body.innerHTML = ''
    chatState.sendMessage.mockResolvedValue(undefined)
    chatState.streamingBySessionId = {}
    chatState.messagesBySessionId = {}
    runtimeState.richContentBlocksBySessionId = {}
    auditAppendMock.mockResolvedValue({ ok: true })
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      widgetAudit: { append: auditAppendMock },
    }
  })

  it('每次成功触发 sendPrompt 都调 preload audit API（widget_id / text / session_id 完整；timestamp 由父页生成）', async () => {
    installWidget('session-audit', 'wgt_audit')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_audit',
      sessionId: 'session-audit',
    })

    const before = Date.now()
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      text: '详细解释这个节点',
      meta: { node: 'ingress' },
    })

    await Promise.resolve()
    await Promise.resolve()
    const after = Date.now()

    expect(auditAppendMock).toHaveBeenCalledTimes(1)
    // P0-1 修复：timestamp 由父页 Date.now() 生成，不信 data.timestamp（防伪造）
    const call = auditAppendMock.mock.calls[0][0] as {
      timestamp: number
      session_id: string
      widget_id: string
      text: string
      meta: unknown
      trigger_source: string
    }
    expect(call.session_id).toBe('session-audit')
    expect(call.widget_id).toBe('wgt_audit')
    expect(call.text).toBe('详细解释这个节点')
    expect(call.meta).toEqual({ node: 'ingress' })
    expect(call.trigger_source).toBe('widget')
    expect(call.timestamp).toBeGreaterThanOrEqual(before)
    expect(call.timestamp).toBeLessThanOrEqual(after)
    // 而且 sendMessage 也被调——audit 不阻塞业务链路
    expect(chatState.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('audit 写入失败 / preload API 不存在 不阻塞 sendMessage 调用（fire-and-forget）', async () => {
    // 模拟 audit 写盘抛异常
    auditAppendMock.mockRejectedValue(new Error('disk full'))
    installWidget('session-audit', 'wgt_fail')
    const iframe = makeIframe()
    registerWidgetSendPromptIframe({
      source: iframe.contentWindow!,
      widgetId: 'wgt_fail',
      sessionId: 'session-audit',
    })

    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'wgt_fail',
      text: '即便 audit 挂了也要能发',
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(auditAppendMock).toHaveBeenCalledTimes(1)
    expect(chatState.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatState.sendMessage).toHaveBeenCalledWith(
      '即便 audit 挂了也要能发',
      true,
      undefined,
      undefined,
      'session-audit',
      expect.objectContaining({ source: 'widget', widgetId: 'wgt_fail' }),
    )

    // 没 preload（清 window.tabtin）也应该 noop 不抛
    ;(window as unknown as { tabtin?: unknown }).tabtin = undefined
    auditAppendMock.mockClear()
    chatState.sendMessage.mockClear()
    dispatchSendPrompt(iframe.contentWindow, {
      type: 'tabtin:sendPrompt',
      widget_id: 'wgt_fail',
      text: 'preload 缺席分支',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(auditAppendMock).not.toHaveBeenCalled()
    expect(chatState.sendMessage).toHaveBeenCalledTimes(1)
  })
})
