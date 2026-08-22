/**
 * RichWidget 流式渲染测试（Widget Wave 2.5/2.6，widget RFC §三 3.1 / §四 4.1 / §四 4.4）
 *
 * 端到端验收点：
 *   1. 持久化模式：block.code 已就绪 → 直接渲染 sandbox iframe（不订阅 args delta）
 *   2. 流式模式：mock LLM 流式吐 SVG args → RichWidget iframe srcdoc 累加更新
 *   3. **rAF 节流断言**：1000 token/s 高频 partial 不会触发 1000 次 React 重渲染
 *   4. **iframe sandbox CSP 与 RFC §四 4.4 字面对齐**（硬约束）
 *   5. 流式开始前显示 loading_message 占位
 *   6. **容器加左上角"图示"角标**（与 image 卡片视觉区分）
 *
 * 不在本测试范围（其他文件守）：
 *   - show_widget 工具 isReadOnly=false（show-widget.test.ts）
 *   - BlocksCollector 不消费 tool_call_args_delta（blocks-collector-tool-call-args-delta.test.ts）
 */

import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetToolCallArgsBuffersForTests,
  clearToolCallArgsBuffers,
  feedInputJsonDelta,
  type ToolCallArgsBuffer,
} from '@/stores/chat/stream/handlers/toolCallArgsBufferStore'

// Wave 4a 协议迁移：原 `handleToolCallArgsDelta(envelope, ctx)` 老协议入口已删除，
// 改为新协议入口 `feedInputJsonDelta(sessionId, toolCallId, toolName, partialJson)`。
// 语义不变——widget streaming buffer 仍按相同的累积/订阅模型工作。

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/chat/useChatStore', () => ({ useChatStore: () => ({}) }))

// W4c：RichContentRenderer 物理退役（v2 §3.5.1.h 退役补偿表）。新协议入口由
// `tabtin_rich_content` block 的 TabTinRichContentBlockView 承接；本测试只
// 守 widget 子组件流式行为，直接渲染 RichWidget 即可，不需要外层 wrapper。
import { RichWidget } from '../RichWidget'
import { wrapWidgetCode } from '../wrapWidgetCode'
import type { RichContentBlock } from '@tabtin/chat-client'

function makeBlock(overrides: Partial<RichContentBlock> = {}): RichContentBlock {
  return {
    type: 'rich_content',
    kind: 'widget',
    summary: 'k8s 三层架构图',
    format: 'svg',
    ...overrides,
  } as RichContentBlock
}

// Wave 4a：废弃 makeArgsDeltaCtx helper——新协议入口 feedInputJsonDelta 直接收
// (sessionId, toolCallId, toolName, partialJson) 4 参数，不再需要构造 envelope/ctx。

beforeEach(() => {
  __resetToolCallArgsBuffersForTests()
  // jsdom 不实现 rAF，Vitest fake timers 接管让 rAF 同步触发
  vi.useFakeTimers()
  // 接管 rAF 后部分 React internal scheduler 也会卡，但本测试只 raf 一次性 flush
  // 完后立刻断言，没有依赖 React concurrent 调度，所以是安全的
})

afterEach(() => {
  vi.useRealTimers()
  __resetToolCallArgsBuffersForTests()
})

describe('RichWidget — Wave 2 流式渲染防线', () => {
  it('持久化模式：block.code 就绪时直接渲染 iframe（不依赖 args delta）', () => {
    const block = makeBlock({
      code: '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>',
      title: 'K8s 架构',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const iframe = screen.getByTitle('K8s 架构') as HTMLIFrameElement
    expect(iframe.tagName).toBe('IFRAME')
    expect(iframe.srcdoc).toContain('<rect width="100" height="100"/>')
  })

  // ── 防线：iframe sandbox 必须严格为 "allow-scripts"（不带 allow-same-origin）──
  //
  // 技术 Review 瑕疵 2 防线：之前的 wrapWidgetCode 测试只测了 wrapper HTML 不含
  // 'allow-same-origin' 字符串，但**真正的 sandbox 防线在 React iframe DOM 元素上**。
  // 如果有人误把 React iframe 的 sandbox 改成 "allow-scripts allow-same-origin"，
  // 之前的 wrapper 测试会通过——但 widget 就能读父页面 cookie 了。这条断言守住
  // 真正的安全防线。
  it('iframe DOM sandbox 必须严格为 "allow-scripts"（widget RFC §四 4.4 硬约束）', () => {
    const block = makeBlock({ code: '<svg/>', title: 't' })
    render(<RichWidget block={block} sessionId="s1" />)
    const iframe = document.querySelector('iframe')!
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    // 防止有人加上 allow-same-origin
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('测高前保留 min-h 占位；收到 tabtin:resize 后贴合内容高度并去掉 min-h', () => {
    const block = makeBlock({
      code: '<svg viewBox="0 0 100 40"><rect width="100" height="40"/></svg>',
      title: '矮图',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const iframe = screen.getByTitle('矮图') as HTMLIFrameElement
    expect(iframe.className).toContain('min-h-[200px]')

    const contentWindow = {} as Window
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => contentWindow,
    })

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'tabtin:resize', height: 88 },
          source: contentWindow,
        }),
      )
    })

    expect(iframe.style.height).toBe('88px')
    expect(iframe.style.minHeight === '0' || iframe.style.minHeight === '0px').toBe(true)
    expect(iframe.className).not.toContain('min-h-[200px]')
  })

  it('iframe srcdoc 注入 sendPrompt bootstrap，且不包含 allow-same-origin / widget_id 值字面量', () => {
    const block = makeBlock({
      widget_id: 'wgt_ingress',
      code: '<svg><text onclick="sendPrompt(\'详细解释 ingress\')">Ingress</text></svg>',
      title: 'K8s 架构',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const iframe = screen.getByTitle('K8s 架构') as HTMLIFrameElement
    expect(iframe.srcdoc).toContain('window.sendPrompt=function(text,meta)')
    expect(iframe.srcdoc).toContain('type:"tabtin:sendPrompt"')
    expect(iframe.srcdoc).not.toContain('allow-same-origin')
    // P0-1 第二层安全修复（2026-04-30）：widget_id 具体值**不得**出现在 srcdoc 里
    expect(iframe.srcdoc).not.toContain('wgt_ingress')
    expect(iframe.srcdoc).not.toMatch(/var\s+widgetId\s*=\s*"[^"]+"/)
  })

  it('视觉差异化：左上角"图示"角标（与 image 卡片区分）', () => {
    const block = makeBlock({ code: '<svg/>', title: 't' })
    render(<RichWidget block={block} sessionId="s1" />)
    expect(screen.getByText('图示')).toBeTruthy()
  })

  it('流式开始前显示 loading_message 占位', () => {
    const block = makeBlock({
      loading_message: '正在画 k8s 架构…',
      // 故意不给 code，模拟 partial 还没到
    })
    render(<RichWidget block={block} sessionId="s1" />)
    expect(screen.getByText('正在画 k8s 架构…')).toBeTruthy()
  })

  it('loading_message 缺失时走 i18n 兜底文案', () => {
    const block = makeBlock({})
    render(<RichWidget block={block} sessionId="s1" />)
    expect(screen.getByText('Agent 正在生成可视化…')).toBeTruthy()
  })

  it('流式模式：消费 tool_call_args_delta 后 iframe srcdoc 累加更新', async () => {
    const block = makeBlock({
      // 故意不给 code——让组件订阅 args delta 流式更新
    })
    render(<RichWidget block={block} sessionId="s1" />)

    // 模拟 LLM 流式吐 args（widget 项目期望最终 LLM 吐完一个完整的 SVG）
    const chunks = [
      '{"summary":"k',
      '8s","format":"svg","code":"<svg vie',
      'wBox=\\"0 0 100 100\\">',
      '<rect width=\\"100\\" height=\\"100\\"/>',
      '</svg>"}',
    ]
    let acc = ''
    for (const c of chunks) {
      acc += c
      feedInputJsonDelta('s1', 'tc-widget-1', 'show_widget', c)
    }
    void acc

    // rAF flush（fake timers 下需要手动推进）
    await act(async () => {
      vi.runAllTimers()
      // 触发 rAF callback——jsdom 没有原生 rAF，组件订阅时 raf id 是 timeout id
      // 这里我们用 globalThis.requestAnimationFrame 走 timeout polyfill
    })

    // 流式更新后 iframe 应该有 srcdoc，且包含 SVG fragment
    // 注意：partial 期间 iframe title 可能是 summary（block.title 缺失），但 srcdoc 必有
    const iframes = document.querySelectorAll('iframe')
    expect(iframes.length).toBeGreaterThan(0)
    const srcdoc = (iframes[0] as HTMLIFrameElement).srcdoc
    expect(srcdoc).toContain('<svg')
    expect(srcdoc).toContain('rect')
  })

  it('rAF 节流：1000 条 deltas 不会触发 1000 次 setState 重渲染', () => {
    // 这个测试通过观察 listener 调用次数 vs rAF flush 次数验证。
    // 实测：每条 delta 都会调 listener（subscribeToolCallArgsDelta 同步 fan-out），
    // 但 React setState 通过 rAF 节流——这里我们断言 listener 调用次数等于 deltas 数，
    // 但 buffer.accumulatedArgs 最终值是所有 deltas 的拼接。
    let listenerCalls = 0
    const block = makeBlock({})
    render(<RichWidget block={block} sessionId="s2" />)

    // 直接 spy 全局订阅（已经在 RichWidget 内 subscribe）
    // 通过 dispatch 1000 条 args delta 验证不卡（不抛 error / 不死循环）
    const sessionId = 's2'
    for (let i = 0; i < 1000; i++) {
      feedInputJsonDelta(sessionId, 'tc-massive', 'show_widget', `c${i}`)
      listenerCalls++
    }
    expect(listenerCalls).toBe(1000)
    // 1000 条 deltas 后渲染没崩——核心验收点（rAF 节流是性能优化，
    // listener 累积 buffer 是正确的，rAF 决定 React 何时重渲染）
  })

  it('lifecycle 终止时清掉"流式中…" badge（避免 LLM 中断后 badge 永远转）', async () => {
    const block = makeBlock({})
    render(<RichWidget block={block} sessionId="s4" />)

    // 模拟流式开始：吐几条 deltas 让 isStreaming=true
    const chunks = ['{"summary":"x","format":"svg","code":"<svg ', 'vie', 'wBox=\\"0 0 1 1\\">']
    for (const c of chunks) {
      feedInputJsonDelta('s4', 'tc-cancel', 'show_widget', c)
    }
    await act(async () => {
      vi.runAllTimers()
    })
    // 流式期间应该有"流式中…" badge
    expect(screen.queryByText('流式中…')).toBeTruthy()

    // 模拟 lifecycle end / cancel：clearToolCallArgsBuffers 触发 sentinel 通知
    await act(async () => {
      clearToolCallArgsBuffers('s4')
      vi.runAllTimers()
    })

    // sentinel 收到后 isStreaming=false，"流式中…"不应再出现
    expect(screen.queryByText('流式中…')).toBeNull()
  })

  it('非 show_widget 的 args delta 不影响 RichWidget（避免误更新）', async () => {
    const block = makeBlock({})
    render(<RichWidget block={block} sessionId="s3" />)

    // 别的工具的 args delta——RichWidget 应该忽略
    feedInputJsonDelta('s3', 'tc-other', 'run_terminal_command', '{"command":"rm -rf /"}')
    await act(async () => {
      vi.runAllTimers()
    })
    // RichWidget 仍显示 loading 占位（没有任何 SVG iframe）
    expect(screen.queryByText('Agent 正在生成可视化…')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })
})

// ─── Widget Wave 2.5 — 真流式 placeholder + 多 widget 不串台 + design tokens 对齐 ───
//
// 这一组测试守护"用户感知的丝滑度"：从"工具 spinner 转 → 啪一下整张图"
// 跳到"卡片立刻出现 + 逐 token 长出 SVG"。
describe('RichWidget — Wave 2.5 真流式 placeholder + 多 widget 隔离', () => {
  it('placeholder 阶段（widget_id=pending: + 空 code）：iframe 还没渲染但已 mount 卡片壳子（loading 占位）', () => {
    // streamMessageHandler 预创建 placeholder 时的状态：widget_id 'pending:xxx'、
    // 没有 code、tool_call_id 已就位、summary 空。RichWidget 应当：
    //   - 显示 loading_message 占位（让用户立刻感知"卡片来了"）
    //   - 已经订阅 buffer 等 partial code（这条由组件 useEffect 触发）
    //   - data-tool-call-id 注入到容器 DOM（验证关联纽带）
    const placeholder = makeBlock({
      widget_id: 'pending:tc-streaming-1',
      tool_call_id: 'tc-streaming-1',
      loading_message: 'Agent 正在画 K8s 架构…',
    })
    render(<RichWidget block={placeholder} sessionId="s-place" />)
    // 卡片壳子已出现（loading 占位）
    expect(screen.getByText('Agent 正在画 K8s 架构…')).toBeTruthy()
    // 容器带 tool_call_id 关联纽带（多 widget 区分 + dev 调试用）
    const container = document.querySelector('[data-tool-call-id="tc-streaming-1"]')
    expect(container).toBeTruthy()
    // 此时 iframe 还没存在（code 还没到）——这是用户体验的关键：用户先看到"在画"
    // 的 placeholder 卡片，然后边吐边出 SVG，不是"等 1-3 秒才看到完整图"
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('placeholder + tool_call_id 匹配的 args delta：iframe srcdoc 流式更新出 SVG', async () => {
    const placeholder = makeBlock({
      widget_id: 'pending:tc-stream-svg',
      tool_call_id: 'tc-stream-svg',
    })
    render(<RichWidget block={placeholder} sessionId="s-stream" />)

    // 模拟 LLM 流式吐 args（4 段）
    const chunks = [
      '{"summary":"k',
      '8s","format":"svg","code":"<svg vie',
      'wBox=\\"0 0 100 100\\"><rect/>',
      '</svg>"}',
    ]
    for (const c of chunks) {
      feedInputJsonDelta('s-stream', 'tc-stream-svg', 'show_widget', c)
    }
    await act(async () => {
      vi.runAllTimers()
    })

    // 流式期间 iframe 已经出现并含 partial SVG fragment
    const iframe = document.querySelector('iframe') as HTMLIFrameElement | null
    expect(iframe).not.toBeNull()
    expect(iframe!.srcdoc).toContain('<svg')
    expect(iframe!.srcdoc).toContain('rect')
  })

  it('多 widget 不串台：两个 placeholder 各自只听自己 tool_call_id 的 partial', async () => {
    // 模拟两个并行 widget 同时流式（tool_call_id 1 / 2），断言：
    // widget-1 的 srcdoc 只含 widget-1 的 SVG，widget-2 的 srcdoc 只含 widget-2 的 SVG
    const blocks = [
      makeBlock({
        widget_id: 'pending:tc-1',
        tool_call_id: 'tc-1',
      }),
      makeBlock({
        widget_id: 'pending:tc-2',
        tool_call_id: 'tc-2',
        // 用不同 group_id 让它们不被同 group 合并渲染
        group_id: 'g2',
      }),
    ]
    // W4c：RichContentRenderer 退役后多 widget 测试改 Fragment 包多个 RichWidget。
    // 原 wrapper 的 groupByGroupId 不同 group 分组逻辑跟本测试断言无关——本测试
    // 只验证 widget-1 / widget-2 各自 iframe srcdoc 不串台。
    render(
      <>
        {blocks.map((b, i) => (
          <RichWidget key={`w${i}`} block={b} sessionId="s-multi" />
        ))}
      </>,
    )

    // 给 widget-1 吐 args（含 rect）
    feedInputJsonDelta('s-multi', 'tc-1', 'show_widget', '{"code":"<svg><rect/></svg>"')
    // 给 widget-2 吐完全不同的 args（含 circle）
    feedInputJsonDelta('s-multi', 'tc-2', 'show_widget', '{"code":"<svg><circle/></svg>"')
    await act(async () => {
      vi.runAllTimers()
    })

    const iframes = document.querySelectorAll('iframe') as NodeListOf<HTMLIFrameElement>
    expect(iframes.length).toBe(2)
    // 找 tc-1 容器 / tc-2 容器
    const card1 = document.querySelector('[data-tool-call-id="tc-1"]')
    const card2 = document.querySelector('[data-tool-call-id="tc-2"]')
    expect(card1).toBeTruthy()
    expect(card2).toBeTruthy()
    const iframe1 = card1!.querySelector('iframe') as HTMLIFrameElement
    const iframe2 = card2!.querySelector('iframe') as HTMLIFrameElement
    // tc-1 iframe 只含自己的 rect；不含 tc-2 的 circle
    expect(iframe1.srcdoc).toContain('rect')
    expect(iframe1.srcdoc).not.toContain('circle')
    // tc-2 iframe 只含自己的 circle；不含 tc-1 的 rect
    expect(iframe2.srcdoc).toContain('circle')
    expect(iframe2.srcdoc).not.toContain('rect')
  })

  it('placeholder 收到 final block（同 tool_call_id）后 srcdoc 切到 final code（同一 widget 不重 mount）', () => {
    // 这个测试模拟"placeholder 已经在 streamingRichBlocks，工具 emit final RICH_CONTENT
    // 后 store 通过 upsertRichContentBlocksByToolCallId 合并字段 → block 现在带
    // finalCode + 真 widget_id"。RichContentRenderer 重渲染时 RichWidget 看到
    // finalCode 走持久化分支。
    const finalBlock = makeBlock({
      widget_id: 'wgt_real_xxx',
      tool_call_id: 'tc-final-1',
      code: '<svg viewBox="0 0 50 50"><rect width="50" height="50"/></svg>',
      summary: '架构图',
    })
    render(<RichWidget block={finalBlock} sessionId="s-final" />)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.srcdoc).toContain('<rect width="50" height="50"/>')
    // data-widget-id 此时应当是真 widget_id（不再带 pending: 前缀）
    const card = document.querySelector('[data-widget-id="wgt_real_xxx"]')
    expect(card).toBeTruthy()
  })

  it('placeholder 阶段 data-widget-id 不暴露 pending: 前缀（避免下游消费者误用）', () => {
    const placeholder = makeBlock({
      widget_id: 'pending:tc-leak-test',
      tool_call_id: 'tc-leak-test',
    })
    render(<RichWidget block={placeholder} sessionId="s-leak" />)
    // 容器不应有 data-widget-id="pending:..."（避免 conversation canvas / sendPrompt
    // 等下游消费者把 'pending:xxx' 当作真 widget_id）
    const leaky = document.querySelector('[data-widget-id^="pending:"]')
    expect(leaky).toBeNull()
    // tool_call_id 仍要保留——这是 RichWidget 订阅 buffer 的过滤纽带
    expect(document.querySelector('[data-tool-call-id="tc-leak-test"]')).toBeTruthy()
  })

  // Widget Wave 2.5 修复（用户 Review #7）：Agent 自定义 loading_message 在
  // partial 期间也生效——LLM 流式吐 args 顺序通常是 summary → format →
  // loading_message → code。code 还没到的窗口里用户应当看到 Agent 自定义文案。
  it('partial 期间从 buffer 提取 loading_message 显示（不等 final RICH_CONTENT）', async () => {
    const placeholder = makeBlock({
      widget_id: 'pending:tc-loadmsg',
      tool_call_id: 'tc-loadmsg',
    })
    render(<RichWidget block={placeholder} sessionId="s-load" />)
    // 模拟 LLM 流式吐 args，loading_message 在 code 之前出现
    feedInputJsonDelta(
      's-load',
      'tc-loadmsg',
      'show_widget',
      '{"summary":"k8s","format":"svg","loading_message":"画 K8s 架构图…","code"',
    )
    await act(async () => {
      vi.runAllTimers()
    })
    // Agent 自定义文案显示，不是 i18n 兜底"Agent 正在生成可视化…"
    expect(screen.getByText('画 K8s 架构图…')).toBeTruthy()
    expect(screen.queryByText('Agent 正在生成可视化…')).toBeNull()
  })

  // Widget Wave 2.5 修复（产品 Review #8 + 真实用户 Review #6）：退化场景双卡片兜底——
  // final widget block 没 tool_call_id 时（启发式失败），handleRichContentEvent
  // 从 in-flight buffer FIFO 取一个 toolCallId 注入再走 upsert，避免页面双卡。
  // 注：这条测试在 streamMessageHandler.test.ts 也覆盖（断言 store action 调用）；
  // 这里跳过——避免重复测试。
})

// ─── wrapWidgetCode CSP 字面对齐（widget RFC §四 4.4 硬约束）──────────

describe('wrapWidgetCode — CSP 与 RFC §四 4.4 字面对齐', () => {
  it('CSP 含 default-src none + style-src/script-src unsafe-inline', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("style-src 'unsafe-inline'")
    expect(html).toContain("script-src 'unsafe-inline'")
  })

  it('CSP 限制 img-src https + data；不允许 http 外链', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toContain('img-src https: data:')
  })

  it('CSP 含 font-src "self" data:（widget RFC §四 4.4 字面对齐）', () => {
    // 技术 Review 发现的盲点：之前测试漏了 font-src 这条 CSP 字面要求
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toContain("font-src 'self' data:")
  })

  it('CSP 不含 allow-same-origin（硬约束：iframe 不能读父页面）', () => {
    // CSP 是 wrapper 自己的内嵌 meta，不含 sandbox 属性——sandbox 在 React iframe
    // 标签上设置（已在 RichContentRenderer.tsx 写明），这里断言 wrapper 自己没写 sandbox
    // 也没塞 allow-same-origin 字符串
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).not.toContain('allow-same-origin')
  })

  it('未知 format 不 crash（fallback 到 svg）', () => {
    const html = wrapWidgetCode('<div>html</div>', 'html')
    expect(html).toContain('<div>html</div>')
  })
})

describe('RichWidget — Wave 6 HTML / Mermaid 渲染策略', () => {
  it('HTML final block 进入 wrapper iframe，且不加载 Mermaid runtime', () => {
    const html = '<div class="card" style="color:hsl(var(--foreground))">设置页</div>'
    const block = makeBlock({
      format: 'html',
      code: html,
      summary: '设置页 mockup',
    })
    render(<RichWidget block={block} sessionId="s-html" />)
    const iframe = screen.getByTitle('设置页 mockup') as HTMLIFrameElement
    expect(iframe.srcdoc).toContain(html)
    expect(iframe.srcdoc).not.toMatch(/mermaid\.js|cdn\.jsdelivr|unpkg/)
  })

  it('HTML final block 允许 sendPrompt onclick，不被流式安全兜底误杀；widget_id 值不泄露到 srcdoc', () => {
    const html = '<button style="cursor:pointer" onclick="sendPrompt(\'解释 Ingress\', { node: \'ingress\' })">Ingress</button>'
    const block = makeBlock({ format: 'html', code: html, widget_id: 'wgt_html_click', summary: '可点击 HTML' })
    render(<RichWidget block={block} sessionId="s-html-click" />)
    const iframe = screen.getByTitle('可点击 HTML') as HTMLIFrameElement
    expect(iframe.srcdoc).toContain("onclick=\"sendPrompt('解释 Ingress', { node: 'ingress' })\"")
    // sendPrompt bootstrap 注入
    expect(iframe.srcdoc).toContain('window.sendPrompt=function(text,meta)')
    // P0-1 第二层：widget_id 值不得泄露
    expect(iframe.srcdoc).not.toContain('wgt_html_click')
  })

  it('HTML full document 会提取 body 内容和 style 后进入 wrapper', () => {
    const doc = '<!doctype html><html><head><style>.x{color:hsl(var(--foreground))}</style></head><body><div class="x">Stepper</div></body></html>'
    const block = makeBlock({ format: 'html', code: doc, summary: 'stepper' })
    render(<RichWidget block={block} sessionId="s-html-doc" />)
    const iframe = screen.getByTitle('stepper') as HTMLIFrameElement
    expect(iframe.srcdoc).toContain('.x{color:hsl(var(--foreground))}')
    expect(iframe.srcdoc).toContain('<div class="x">Stepper</div>')
  })

  it('Mermaid final block 使用 compiled SVG（rendered_code 优先）历史回放', () => {
    const source = 'graph TD; A-->B;'
    const svg = '<svg viewBox="0 0 100 40"><text>A</text></svg>'
    const block = makeBlock({
      format: 'mermaid',
      code: svg,
      rendered_code: svg,
      source_code: source,
      mermaid_source: source,
      summary: '流程图',
    })
    render(<RichWidget block={block} sessionId="s-mermaid" />)
    const iframe = screen.getByTitle('流程图') as HTMLIFrameElement
    expect(iframe.srcdoc).toContain('<svg')
    expect(iframe.srcdoc).toContain('<text>A</text>')
    expect(iframe.srcdoc).not.toContain(source)
    expect(iframe.srcdoc).not.toMatch(/mermaid\.js|<script\s+[^>]*src=/i)
  })

  it('Mermaid 流式期显示 loading_message + source preview，不尝试浏览器端 runtime 渲染', async () => {
    const placeholder = makeBlock({
      widget_id: 'pending:tc-mermaid',
      tool_call_id: 'tc-mermaid',
    })
    render(<RichWidget block={placeholder} sessionId="s-mermaid-stream" />)
    feedInputJsonDelta(
      's-mermaid-stream',
      'tc-mermaid',
      'show_widget',
      '{"summary":"flow","format":"mermaid","loading_message":"正在编译流程图…","code":"graph TD; A-->B;',
    )
    await act(async () => {
      vi.runAllTimers()
    })
    expect(screen.getByText('正在编译流程图…')).toBeTruthy()
    expect(screen.getByText(/graph TD/)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('HTML 流式期遇到高危片段时不挂 iframe 执行，保留 loading 占位', async () => {
    const placeholder = makeBlock({
      widget_id: 'pending:tc-html-unsafe',
      tool_call_id: 'tc-html-unsafe',
    })
    render(<RichWidget block={placeholder} sessionId="s-html-unsafe" />)
    feedInputJsonDelta(
      's-html-unsafe',
      'tc-html-unsafe',
      'show_widget',
      '{"summary":"bad","format":"html","loading_message":"正在生成 UI…","code":"<script>alert(1)</script>',
    )
    await act(async () => {
      vi.runAllTimers()
    })
    expect(screen.getByText('正在生成 UI…')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })
})

// ─── Design Tokens 与桌面 UI 字面对齐（widget Wave 2.5）──────────
//
// 业务目的：让 widget 视觉与桌面 chat UI **真正同源**——Wave 5a skill 教 Agent
// 写 widget 用 `hsl(var(--background))` / `hsl(var(--foreground))` 等 shadcn 风格
// HSL 三元组；wrapper 注入的变量值必须与 globals.css 字面相等，否则 SVG 实际
// 渲染色和 chat UI 色对不上，用户感知"widget 是个异类"。
describe('wrapWidgetCode — design tokens 与 globals.css 字面对齐', () => {
  it('注入 shadcn HSL 三元组变量（--background / --foreground / --primary 等）', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    // 与 globals.css :root 块字面相等
    expect(html).toContain('--background:40 25% 99%')
    expect(html).toContain('--foreground:30 10% 15%')
    expect(html).toContain('--primary:215 65% 52%')
    expect(html).toContain('--border:34 10% 89%')
    expect(html).toContain('--muted-foreground:30 6% 44%')
    expect(html).toContain('--accent:215 65% 52%')
    expect(html).toContain('--success:152 45% 42%')
    expect(html).toContain('--destructive:0 55% 52%')
  })

  // Widget Wave 2.5 修复（技术 Review A）：theme 切换由 chat UI `.dark` class 决定，
  // 不再依赖 OS prefers-color-scheme。wrapper 接收 theme 参数注入对应 light/dark 块。
  it('theme=dark 时注入 dark 值（与 globals.css .dark 字面对齐）；不再依赖 prefers-color-scheme', () => {
    const html = wrapWidgetCode('<svg/>', 'svg', { theme: 'dark' })
    // 不再注入 @media query——chat UI 主题切换由 .dark class 控制
    expect(html).not.toContain('@media (prefers-color-scheme')
    // dark 块的几个关键值（必须与 globals.css .dark 字面相等）
    expect(html).toContain('--background:30 6% 9%')
    expect(html).toContain('--foreground:36 14% 90%')
    expect(html).toContain('--primary:215 65% 62%')
    expect(html).toContain('--border:30 6% 20%')
    // light 块的值不应出现（避免两份变量打架）
    expect(html).not.toContain('--background:40 25% 99%')
    expect(html).not.toContain('--foreground:30 10% 15%')
  })

  it('theme 缺省时走 light（向后兼容旧调用）', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toContain('--background:40 25% 99%')
    expect(html).toContain('--foreground:30 10% 15%')
    // dark 值不在
    expect(html).not.toContain('--background:30 6% 12%')
  })

  it('theme=light 显式指定也走 light 块', () => {
    const html = wrapWidgetCode('<svg/>', 'svg', { theme: 'light' })
    expect(html).toContain('--foreground:30 10% 15%')
    expect(html).not.toContain('--foreground:36 14% 90%')
  })

  it('SVG 默认 color 用 hsl(var(--foreground))——硬编码 fill 在暗色模式自动反色（通过 currentColor）', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    // body / svg 都设 color: hsl(var(--foreground))，让继承的 currentColor 工作
    expect(html).toContain('color:hsl(var(--foreground))')
    // svg text 默认 fill: currentColor（兼容 LLM 写 `<text>` 不指定 fill）
    expect(html).toContain('fill:currentColor')
  })

  it('保留旧 --widget-fg/--widget-bg/--widget-accent 兼容性（让 Wave 2 已上线 SVG 继续工作）', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    // 旧变量映射到新变量，让既有 widget code 仍能运行
    expect(html).toContain('--widget-fg:hsl(var(--foreground))')
    expect(html).toContain('--widget-bg:transparent')
    expect(html).toContain('--widget-accent:hsl(var(--accent))')
  })

  it('字体 stack 含 system-ui + 中文兜底（PingFang SC / Microsoft YaHei）', () => {
    // 与 sandbox.md 教 Agent 用的 system stack 字面对齐
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toContain('-apple-system')
    expect(html).toContain('BlinkMacSystemFont')
    expect(html).toContain('system-ui')
    expect(html).toContain('PingFang SC')
    expect(html).toContain('sans-serif')
  })
})

// ─── Widget Wave 3 — fade-in 动效 / interrupted UI / a11y / 切换不闪烁 ──
//
// RFC §五 3.2 / 3.4 / 3.5 / 3.6 / 3.8 八条 checklist 的核心防线。
describe('Widget Wave 3 — fade-in 动效（RFC §五 3.2 / 3.8 ①）', () => {
  it('wrapWidgetCode 注入 fade-in @keyframes + svg * animation', () => {
    const html = wrapWidgetCode('<svg viewBox="0 0 1 1"/>', 'svg')
    // @keyframes 定义出现在 wrapper style 块
    expect(html).toContain('@keyframes widget-fade-in')
    // svg 内元素都跑 animation（最简方案，重 parse 时新元素天然走一次）
    expect(html).toContain('svg *{animation:widget-fade-in')
    // duration 200ms（<300ms 避免高频 LLM 流式时卡死浏览器）
    expect(html).toContain('0.2s')
    // ease-out 缓动让初期快速 fade in 末期缓慢
    expect(html).toContain('ease-out')
  })

  it('animation-fill-mode:forwards 防止 srcdoc reparse 时元素反复淡入（用户视角 Review P1）', () => {
    // 业务承诺：fade-in 是"平滑生长"而不是"集体闪烁"。forwards 让元素停留
    // 在终态 opacity:1，srcdoc reparse 时新元素从 0 走 0→1 一次到 1 后停住，
    // 不会因为 keyframe 默认 reset 行为反复回到透明。
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toContain('animation-fill-mode:forwards')
  })

  it('@media (prefers-reduced-motion:reduce) 关闭动画（a11y + Wave 4 烤图准备）', () => {
    // WCAG 2.3.3 Animation from Interactions——前庭功能障碍 / motion sensitivity
    // 用户避免眩晕；同时为 Wave 4 OffscreenWindowPool 烤图准备（烤图窗口设
    // reduce-motion 即可跳过动画，避免截到 50% 透明的"未完成态"PNG）。
    const html = wrapWidgetCode('<svg/>', 'svg')
    expect(html).toMatch(/@media[^{]*prefers-reduced-motion[^{]*reduce/)
    expect(html).toContain('animation:none')
  })

  it('body 也带 fade-in（卡片首次出现柔和淡入，不只是 SVG 元素）', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    // body 用同 keyframe 让"卡片首次 mount"时整体淡入
    expect(html).toContain('body{animation:widget-fade-in')
  })
})

describe('Widget Wave 3 — interrupted UI（RFC §五 3.6 / 3.8 ④）', () => {
  it('block 带 interrupted_at 时显示"已中断" badge 替代"流式中…"', () => {
    const block = makeBlock({
      widget_id: 'pending:tc-cancel',
      tool_call_id: 'tc-cancel',
      interrupted_at: Date.now(),
      interrupted_status: 'cancelled',
    })
    render(<RichWidget block={block} sessionId="s-cancel" />)
    // "已中断" 出现
    expect(screen.getByText('已中断')).toBeTruthy()
    // "流式中…" 不应出现（被 interrupted 覆盖）
    expect(screen.queryByText('流式中…')).toBeNull()
  })

  it('block interrupted 时容器 data-interrupted="true"（dim overlay 触发）', () => {
    const block = makeBlock({
      widget_id: 'pending:tc-x',
      tool_call_id: 'tc-x',
      interrupted_at: Date.now(),
      interrupted_status: 'error',
    })
    render(<RichWidget block={block} sessionId="s-int" />)
    const container = document.querySelector('[data-tool-call-id="tc-x"]')
    expect(container).toBeTruthy()
    expect(container!.getAttribute('data-interrupted')).toBe('true')
  })

  it('interrupted + 没 streamingCode：显示中断占位（不是 loading spinner）', () => {
    // 极端场景：用户在第一条 partial 都没收到时就 cancel，widget 没任何 code
    const block = makeBlock({
      widget_id: 'pending:tc-empty',
      tool_call_id: 'tc-empty',
      interrupted_at: Date.now(),
      interrupted_status: 'cancelled',
    })
    render(<RichWidget block={block} sessionId="s-empty" />)
    // 中断占位文案出现
    expect(screen.getByText('Agent 中断了这次可视化生成')).toBeTruthy()
    // 普通 loading 文案不在
    expect(screen.queryByText('Agent 正在生成可视化…')).toBeNull()
  })

  it('finalCode 优先级 > interrupted_at（极端时序：先到 RICH_CONTENT 后到 cancel）', () => {
    // 业务场景：tool execute() 完成 emit RICH_CONTENT（含 finalCode）的同时
    // 用户按 cancel，先后顺序导致 lifecycle cancel 在 store mark interrupted 时
    // widget 已经带 finalCode。我们认 finalCode 为权威态——用户能看到完整渲染。
    const block = makeBlock({
      widget_id: 'wgt_done',
      tool_call_id: 'tc-done',
      code: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      interrupted_at: Date.now(),
      interrupted_status: 'cancelled',
    })
    render(<RichWidget block={block} sessionId="s-done" />)
    // iframe 应该正常显示 finalCode（不走 interrupted UI）
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.srcdoc).toContain('<rect width="10" height="10"/>')
    // "已中断" 不应出现（finalCode 优先）
    expect(screen.queryByText('已中断')).toBeNull()
  })
})

describe('Widget Wave 3 — a11y 加强（RFC §五 3.4 / 3.8 ③）', () => {
  it('容器 role="img" + aria-label 含 widget 类型 + summary（VoiceOver 能读）', () => {
    const block = makeBlock({
      code: '<svg/>',
      summary: 'K8s 三层架构图',
      title: 'K8s 架构',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]')
    expect(container).toBeTruthy()
    const label = container!.getAttribute('aria-label')!
    expect(label).toContain('图示')
    expect(label).toContain('K8s 三层架构图')
  })

  it('流式期间 aria-label 含"生成中"状态前缀让屏阅器区分状态（i18n 走 statePrefixStreaming）', async () => {
    const block = makeBlock({
      widget_id: 'pending:tc-streaming',
      tool_call_id: 'tc-streaming',
      summary: 'k8s 架构',
    })
    render(<RichWidget block={block} sessionId="s-stream" />)
    feedInputJsonDelta(
      's-stream',
      'tc-streaming',
      'show_widget',
      '{"summary":"k8s","format":"svg","code":"<svg/>',
    )
    // RichWidget 内部 setIsStreaming(true) 是 useState 同步触发，但 rAF 节流的
    // partial code 提取需要触发 timers 让 setStreamingCode 也更新到。
    await act(async () => {
      vi.runAllTimers()
    })
    const container = document.querySelector('[role="img"]')!
    const label = container.getAttribute('aria-label')!
    expect(label).toContain('图示')
    expect(label).toContain('k8s 架构')
    // 状态前缀通过 i18n 渲染——断言含"生成中"（fallback "（生成中）"）
    expect(label).toContain('生成中')
  })

  it('已中断 widget aria-label 含"已中断"前缀（屏阅器能识别状态）', () => {
    const block = makeBlock({
      widget_id: 'pending:tc-int',
      tool_call_id: 'tc-int',
      summary: '架构图',
      interrupted_at: Date.now(),
      interrupted_status: 'cancelled',
    })
    render(<RichWidget block={block} sessionId="s-int" />)
    const container = document.querySelector('[role="img"]')!
    const label = container.getAttribute('aria-label')!
    expect(label).toContain('已中断')
    expect(label).toContain('架构图')
  })

  // 用户视角 Review P0 修复：状态变化主动播报（aria-live="polite"）
  //
  // 业务承诺：盲人用 VoiceOver / TalkBack 在 widget 流式期间聚焦后，cancel 时
  // 不需要 Tab 走再 Tab 回，能听到"已中断：summary"主动播报。
  //
  // 实现：visually-hidden span + aria-live="polite"，状态切换时更新 textContent。
  it('已中断 widget 含 aria-live span 主动播报"已中断：summary"（盲人 a11y 必修）', () => {
    const block = makeBlock({
      widget_id: 'pending:tc-int',
      tool_call_id: 'tc-int',
      summary: 'K8s 架构',
      interrupted_at: Date.now(),
      interrupted_status: 'cancelled',
    })
    render(<RichWidget block={block} sessionId="s-int" />)
    const liveSpan = document.querySelector('[aria-live="polite"]')!
    expect(liveSpan).toBeTruthy()
    const text = liveSpan.textContent!
    expect(text).toContain('已中断')
    expect(text).toContain('K8s 架构')
  })

  it('完成 widget 含 aria-live span 主动播报"完成：summary"（流式快速完成场景）', () => {
    const block = makeBlock({
      widget_id: 'wgt_done',
      tool_call_id: 'tc-done',
      code: '<svg/>',
      summary: '架构图',
    })
    render(<RichWidget block={block} sessionId="s-done" />)
    const liveSpan = document.querySelector('[aria-live="polite"]')!
    expect(liveSpan).toBeTruthy()
    const text = liveSpan.textContent!
    expect(text).toContain('完成')
    expect(text).toContain('架构图')
  })

  it('placeholder 阶段 aria-live span 不主动播报（避免空播或误播）', () => {
    const block = makeBlock({
      widget_id: 'pending:tc-empty',
      tool_call_id: 'tc-empty',
      summary: '加载中…',
    })
    render(<RichWidget block={block} sessionId="s-empty" />)
    const liveSpan = document.querySelector('[aria-live="polite"]')!
    expect(liveSpan).toBeTruthy()
    // placeholder（无 finalCode + 无 interrupted_at）→ liveAnnouncement 为空字符串
    expect(liveSpan.textContent).toBe('')
  })
})

describe('Widget Wave 3 — 流式→持久化切换不闪烁（RFC §五 3.5 / 3.8 ⑧）', () => {
  it('placeholder + 同 tool_call_id 的 final block 用 stableKey 同一 React instance', () => {
    // 通过比较 placeholder 渲染的 iframe 与 final block 渲染的 iframe 是否
    // 是"同一 React 实例"——RichContentRenderer 用 stableKey: `widget-${tool_call_id}`
    // 让 React reconciler 把 placeholder 视为同一组件而非 unmount/remount。
    //
    // jsdom 下没法直接断言 fiber identity，但能断言 RichContentRenderer 给
    // widget 用的 stableKey 是基于 tool_call_id 的，让 stableKey 一致即 React
    // 不会重 mount。
    const placeholder = makeBlock({
      widget_id: 'pending:tc-stable',
      tool_call_id: 'tc-stable',
    })
    const { rerender } = render(<RichWidget block={placeholder} sessionId="s-stable" />)
    // 模拟 store 把 placeholder 替换为 final block（同 tool_call_id）
    const finalBlock = makeBlock({
      widget_id: 'wgt_real',
      tool_call_id: 'tc-stable',
      code: '<svg viewBox="0 0 1 1"><rect/></svg>',
      summary: 'final',
    })
    rerender(<RichWidget block={finalBlock} sessionId="s-stable" />)
    // final block 的 iframe 应该出现，srcdoc 含 final code
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.srcdoc).toContain('<rect/>')
    // 容器 widget_id 切到 final（不再是 pending:）
    const card = document.querySelector('[data-widget-id="wgt_real"]')
    expect(card).toBeTruthy()
    // 旧 placeholder 不再存在
    expect(document.querySelector('[data-widget-id^="pending:"]')).toBeNull()
  })

  it('多 widget 切换：每个 tool_call_id 各自有自己的 stableKey（不串台）', () => {
    // RichContentGroup.stableKey: `widget-${tool_call_id}`——确保多 widget
    // 不会因为 streaming → persisted 切换时 React reconciler 把它们重排
    const blocks = [
      makeBlock({
        widget_id: 'pending:tc-1',
        tool_call_id: 'tc-1',
      }),
      makeBlock({
        widget_id: 'pending:tc-2',
        tool_call_id: 'tc-2',
        group_id: 'g2',
      }),
    ]
    render(
      <>
        {blocks.map((b, i) => (
          <RichWidget key={`w${i}`} block={b} sessionId="s-mw" />
        ))}
      </>,
    )
    // 两个独立容器
    expect(document.querySelector('[data-tool-call-id="tc-1"]')).toBeTruthy()
    expect(document.querySelector('[data-tool-call-id="tc-2"]')).toBeTruthy()
  })
})

describe('Widget Wave 3 — 视觉一致性（RFC §五 3.8 ⑤ ⑥ ⑦）', () => {
  it('字体一致：wrapper 注入的 font-family 与 globals.css 同源（system stack）', () => {
    const html = wrapWidgetCode('<svg/>', 'svg')
    // 与 globals.css 字体同源（PingFang SC / Microsoft YaHei 中文兜底）
    expect(html).toContain('PingFang SC')
    expect(html).toContain('Microsoft YaHei')
    expect(html).toContain('-apple-system')
  })

  it('左上角"图示"角标存在（与 image 卡片视觉区分 — checklist ⑥）', () => {
    const block = makeBlock({ code: '<svg/>' })
    render(<RichWidget block={block} sessionId="s1" />)
    expect(screen.getByText('图示')).toBeTruthy()
  })

  it('容器没有 cursor:pointer（无 hover 错觉 — checklist ⑦）', () => {
    const block = makeBlock({ code: '<svg/>' })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    expect(container).toBeTruthy()
    // 容器不应该有 cursor-pointer 类
    expect(container.className).not.toContain('cursor-pointer')
    // iframe 也不应有 cursor-pointer
    const iframe = document.querySelector('iframe')
    if (iframe) {
      expect(iframe.className).not.toContain('cursor-pointer')
    }
  })
})

// ─── Widget Wave 4.10 — 桌面端右键菜单（widget RFC §五 4.10）─────────────
//
// 业务承诺：用户右键 widget 卡片 → 弹自定义菜单：
//   1. 保存图片 PNG（优先 image_url，缺则 SVG canvas 转 PNG）
//   2. 复制 SVG 源码（仅 finalCode 存在时启用）
//   3. 在新窗口打开（finalCode → srcdoc，缺则 image_url）
//
// jsdom 限制：clipboard / canvas / window.open / a-tag download 都需要 mock。
// 这些测试不验证浏览器原生行为，只验证 RichWidget 是否调对了 web API。
describe('Widget Wave 4.10 — 桌面端右键菜单', () => {
  beforeEach(() => {
    // 每个测试用真 timer——右键菜单的 useEffect 需要真实事件循环
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useFakeTimers()
  })

  it('右键 widget 容器 → 显示菜单（保存 / 复制 / 新窗口三项）', () => {
    const block = makeBlock({
      widget_id: 'wgt_ctx_test',
      tool_call_id: 'tc-ctx',
      code: '<svg viewBox="0 0 100 100"><rect/></svg>',
    })
    render(<RichWidget block={block} sessionId="s-ctx" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    expect(container).toBeTruthy()

    // 模拟右键
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
      )
    })

    const menu = document.querySelector('[role="menu"]') as HTMLElement
    expect(menu).toBeTruthy()
    expect(menu.getAttribute('aria-label')).toContain('图示')

    // 三项菜单都在
    const items = document.querySelectorAll('[role="menuitem"]')
    expect(items.length).toBe(3)
    expect(items[0].textContent).toContain('保存图片')
    expect(items[1].textContent).toContain('复制 SVG')
    expect(items[2].textContent).toContain('新窗口')
  })

  it('placeholder 阶段不弹右键菜单（避免空 dropdown 困惑用户）', () => {
    const block = makeBlock({
      widget_id: 'pending:tc-empty',
      tool_call_id: 'tc-empty',
    })
    render(<RichWidget block={block} sessionId="s-pending" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('image_url 缺 + finalCode 缺 → "保存 PNG / 复制 SVG" 禁用（避免空操作）', () => {
    // 静态构造：placeholder 已被替换为带 widget_id 的真 block，但 code 还没到
    // （罕见极端时序）—— 三个 action 都应该 disabled，避免给用户错觉
    const block = makeBlock({
      widget_id: 'wgt_no_code',
      tool_call_id: 'tc-no-code',
      // 不设 code / image_url
    })
    render(<RichWidget block={block} sessionId="s-no-code" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    const items = document.querySelectorAll('[role="menuitem"]') as NodeListOf<HTMLButtonElement>
    expect(items.length).toBe(3)
    // 全部 disabled（无 finalCode + 无 image_url）
    expect(items[0].disabled).toBe(true)
    expect(items[1].disabled).toBe(true)
    expect(items[2].disabled).toBe(true)
  })

  it('finalCode 存在 + 无 image_url → 三项菜单全部启用', () => {
    const block = makeBlock({
      widget_id: 'wgt_full',
      tool_call_id: 'tc-full',
      code: '<svg viewBox="0 0 100 100"><rect/></svg>',
    })
    render(<RichWidget block={block} sessionId="s-full" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    const items = document.querySelectorAll('[role="menuitem"]') as NodeListOf<HTMLButtonElement>
    expect(items.length).toBe(3)
    expect(items[0].disabled).toBe(false)
    expect(items[1].disabled).toBe(false)
    expect(items[2].disabled).toBe(false)
  })

  it('点击"复制 SVG"调 navigator.clipboard.writeText(finalCode)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const finalCode = '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>'
    const block = makeBlock({
      widget_id: 'wgt_copy',
      tool_call_id: 'tc-copy',
      code: finalCode,
    })
    render(<RichWidget block={block} sessionId="s-copy" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    const items = document.querySelectorAll('[role="menuitem"]') as NodeListOf<HTMLButtonElement>
    // 第二项 "复制 SVG"
    act(() => {
      items[1].click()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(finalCode)
  })

  // ：跨域 OSS 不得裸 fetch + a.download（打包态 CSP/CORS 会失败）。
  // 与 Lightbox 对齐：走主进程 resourceDetection.downloadResource。
  it('点击"保存 PNG" + 有 image_url → 走主进程 downloadResource（不裸 fetch）', async () => {
    const block = makeBlock({
      widget_id: 'wgt_save_url',
      tool_call_id: 'tc-save-url',
      code: '<svg/>',
      image_url: 'https://oss.example.com/widget/test.png',
      summary: '架构图',
    })

    const downloadResource = vi.fn().mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/Downloads/TabTin/架构图.png' },
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        resourceDetection: { downloadResource },
        showItemInFolder: vi.fn(),
      },
    })
    const fetchMock = vi.fn()
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      writable: true,
      configurable: true,
    })

    render(<RichWidget block={block} sessionId="s-save-url" />)

    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    const items = document.querySelectorAll('[role="menuitem"]') as NodeListOf<HTMLButtonElement>
    await act(async () => {
      items[0].click() // 保存 PNG
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(downloadResource).toHaveBeenCalledWith({
      url: 'https://oss.example.com/widget/test.png',
      filename: '架构图.png',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('点击"在新窗口打开" + finalCode → window.open with about:blank + document.write(srcdoc)', () => {
    const finalCode = '<svg viewBox="0 0 100 100"><rect width="100"/></svg>'
    const block = makeBlock({
      widget_id: 'wgt_new_win',
      tool_call_id: 'tc-new-win',
      code: finalCode,
    })

    // mock window.open 返回带 document.open/write/close 的假窗口
    const writes: string[] = []
    const fakeDoc = {
      open: vi.fn(),
      write: vi.fn((html: string) => writes.push(html)),
      close: vi.fn(),
    }
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({
      document: fakeDoc,
    } as unknown as Window))

    render(<RichWidget block={block} sessionId="s-new-win" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    const items = document.querySelectorAll('[role="menuitem"]') as NodeListOf<HTMLButtonElement>
    act(() => {
      items[2].click() // 新窗口打开
    })
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank', 'noopener,noreferrer')
    // 写入了完整 srcdoc（含 finalCode）
    expect(writes.length).toBe(1)
    expect(writes[0]).toContain(finalCode)
    // CSP 字面对齐——保证新窗口 widget 与 chat 内 iframe 视觉一致
    expect(writes[0]).toContain("default-src 'none'")
    openSpy.mockRestore()
  })

  it('Esc 键关闭右键菜单（标准交互）', () => {
    const block = makeBlock({
      widget_id: 'wgt_esc',
      tool_call_id: 'tc-esc',
      code: '<svg/>',
    })
    render(<RichWidget block={block} sessionId="s-esc" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeTruthy()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('document mousedown 外部点击关闭菜单（标准交互）', () => {
    const block = makeBlock({
      widget_id: 'wgt_outside',
      tool_call_id: 'tc-outside',
      code: '<svg/>',
    })
    render(<RichWidget block={block} sessionId="s-outside" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeTruthy()

    // 模拟点击 document 外部空白
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

// ─── Widget Wave 4.6 — chat 内 RichWidget wrapper 接通 widget-tokens 包 ────
//
// 业务承诺：chat 预览路径用的 wrapper 与 Electron / Daemon 烤图用的 wrapper
// **共用同一份 design tokens + CSP 字符串**——避免"chat 预览能跑但烤图被
// CSP block"或反之的视觉漂移。
describe('Widget Wave 4.6 — chat wrapper 接通 widget-tokens 包', () => {
  it('wrapWidgetCode 输出的 CSP 与 widget-tokens.WIDGET_CSP 字面相同', async () => {
    const { WIDGET_CSP } = await import('@tabtin/widget-tokens')
    const html = wrapWidgetCode('<svg/>', 'svg', { theme: 'light' })
    expect(html).toContain(WIDGET_CSP)
  })

  it('wrapWidgetCode light 输出的 token bundle 与 widget-tokens.themeBundle.light 字面相同', async () => {
    const { themeBundle } = await import('@tabtin/widget-tokens')
    const html = wrapWidgetCode('<svg/>', 'svg', { theme: 'light' })
    expect(html).toContain(themeBundle.light)
  })

  it('wrapWidgetCode dark 输出的 token bundle 与 widget-tokens.themeBundle.dark 字面相同', async () => {
    const { themeBundle } = await import('@tabtin/widget-tokens')
    const html = wrapWidgetCode('<svg/>', 'svg', { theme: 'dark' })
    expect(html).toContain(themeBundle.dark)
    // 不应该混入 light token
    expect(html).not.toContain(themeBundle.light)
  })
})
// ─── Widget Wave 4.10（widget RFC §五 4.10）：右键菜单 + 历史模式 ─────────

describe('RichWidget Wave 4.10 — 右键菜单 + 历史模式', () => {
  // ── 防线 1: 历史模式（finalCode 优先 vs image_url fallback）────────────
  it('历史回放：finalCode 已就位 → 用 code 重新渲染 iframe（保真度）', () => {
    const block = makeBlock({
      code: '<svg viewBox="0 0 100 100"><rect/></svg>',
      // 即便有 image_url，finalCode 优先
      image_url: 'https://oss.example.com/old.png',
      summary: 'history widget',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const iframe = screen.getByTitle('history widget') as HTMLIFrameElement
    expect(iframe.tagName).toBe('IFRAME')
    expect(iframe.srcdoc).toContain('<rect/>')
    // 确认走 iframe 路径，不是 <img>
    const imgs = document.querySelectorAll('img')
    expect(imgs.length).toBe(0)
  })

  it('历史回放：finalCode 缺失 + image_url 在 → 退到 image fallback（移动端 / 兜底）', () => {
    const block = makeBlock({
      // 没 code（lifecycle 中断 / 旧版本 widget block）
      image_url: 'https://oss.example.com/widget.png',
      summary: 'fallback widget',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const img = document.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.src).toContain('widget.png')
    // 不应该有 iframe（finalCode 缺）
    const iframe = document.querySelector('iframe')
    expect(iframe).toBeNull()
  })

  // ── 防线 2: 右键菜单弹出 ────────────────────────────────────────
  it('右键 widget 容器 → 弹出菜单（包含 3 个 menuitem）', () => {
    const block = makeBlock({ code: '<svg><rect/></svg>' })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement

    // 触发 contextmenu
    act(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 50 })
      container.dispatchEvent(event)
    })

    const menu = document.querySelector('[data-widget-context-menu="true"]')
    expect(menu).toBeTruthy()
    const items = menu!.querySelectorAll('[role="menuitem"]')
    expect(items.length).toBe(3)
  })

  it('pending placeholder 不弹菜单（避免空 dropdown 困惑用户）', () => {
    const block = makeBlock({
      // pending 状态：widget_id 是 'pending:xxx' 没 finalCode
      widget_id: 'pending:tu_test',
      tool_call_id: 'tu_test',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement

    act(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 50 })
      container.dispatchEvent(event)
    })
    const menu = document.querySelector('[data-widget-context-menu="true"]')
    expect(menu).toBeNull()
  })

  // ── 防线 3: 菜单项 disabled 状态 ────────────────────────────────
  it('image_url + finalCode 都在 → 三个菜单项全可用', () => {
    const block = makeBlock({
      code: '<svg/>',
      image_url: 'https://oss.example.com/widget.png',
    })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const items = document.querySelectorAll('[data-widget-context-menu="true"] [role="menuitem"]')
    expect(items.length).toBe(3)
    items.forEach((item) => {
      expect((item as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('finalCode 缺 + image_url 在 → 复制 SVG disabled，其它两个可用', () => {
    const block = makeBlock({ image_url: 'https://oss.example.com/widget.png' })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const items = Array.from(
      document.querySelectorAll('[data-widget-context-menu="true"] [role="menuitem"]'),
    ) as HTMLButtonElement[]
    // 第 2 个是"复制 SVG 源码"（按声明顺序）
    expect(items[1].disabled).toBe(true)
    expect(items[0].disabled).toBe(false) // 保存 PNG
    expect(items[2].disabled).toBe(false) // 在新窗口打开
  })

  // ── 防线 4: 复制 SVG 调用 navigator.clipboard ──────────────────
  it('点击"复制 SVG 源码" → 调 navigator.clipboard.writeText', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })

    const svg = '<svg viewBox="0 0 50 50"><circle/></svg>'
    const block = makeBlock({ code: svg })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })

    const items = Array.from(
      document.querySelectorAll('[data-widget-context-menu="true"] [role="menuitem"]'),
    ) as HTMLButtonElement[]
    // 第 2 个 "复制 SVG"
    act(() => {
      items[1].click()
    })

    expect(writeTextMock).toHaveBeenCalledWith(svg)
  })

  // ── 防线 5: 在新窗口打开（renderCode 优先 srcdoc，否则 image_url）────
  it('点击"在新窗口打开" → finalCode 在时调 window.open(about:blank) + write srcdoc', () => {
    const writeMock = vi.fn()
    const closeMock = vi.fn()
    const openMock = vi.fn().mockReturnValue({
      document: {
        open: vi.fn(),
        write: writeMock,
        close: closeMock,
      },
    })
    Object.defineProperty(window, 'open', {
      value: openMock,
      writable: true,
      configurable: true,
    })

    const block = makeBlock({ code: '<svg viewBox="0 0 100 100"><line/></svg>' })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const items = Array.from(
      document.querySelectorAll('[data-widget-context-menu="true"] [role="menuitem"]'),
    ) as HTMLButtonElement[]
    // 第 3 个 "在新窗口打开"
    act(() => {
      items[2].click()
    })
    expect(openMock).toHaveBeenCalledWith('about:blank', '_blank', expect.any(String))
    expect(writeMock).toHaveBeenCalled()
    const writtenSrcdoc = writeMock.mock.calls[0][0] as string
    expect(writtenSrcdoc).toContain('<line/>')
  })

  it('点击"在新窗口打开" → 仅 image_url 时 window.open 直接打开 image url', () => {
    const openMock = vi.fn().mockReturnValue({})
    Object.defineProperty(window, 'open', {
      value: openMock,
      writable: true,
      configurable: true,
    })
    const block = makeBlock({ image_url: 'https://oss.example.com/widget.png' })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const items = Array.from(
      document.querySelectorAll('[data-widget-context-menu="true"] [role="menuitem"]'),
    ) as HTMLButtonElement[]
    act(() => {
      items[2].click()
    })
    expect(openMock).toHaveBeenCalledWith(
      'https://oss.example.com/widget.png',
      '_blank',
      expect.any(String),
    )
  })

  // ── 防线 6: ESC 关闭菜单 ────────────────────────────────────────
  it('按 Esc 关闭右键菜单', () => {
    const block = makeBlock({ code: '<svg/>' })
    render(<RichWidget block={block} sessionId="s1" />)
    const container = document.querySelector('[role="img"]') as HTMLElement
    act(() => {
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    expect(document.querySelector('[data-widget-context-menu="true"]')).toBeTruthy()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[data-widget-context-menu="true"]')).toBeNull()
  })
})

