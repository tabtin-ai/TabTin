/**
 * show_widget 工具测试（Widget Wave 2.1，widget RFC §三 3.1 / §七 🔴 高严重度）
 *
 * 守住的关键不变量：
 *
 *   1. **`isReadOnly: false`** — 防 preStartedTools 在 LLM 流式期间提前 execute
 *      烤到半截 SVG。真正判断"流式 tool_use 到达时是否进入 preStartedTools 池"
 *      的路径在 `packages/agent-runtime/src/engine/query.ts:2628`：
 *      `if (preStartCandidate?.isReadOnly && !preStartCandidate.disablePreStart)`。
 *      `isReadOnly=true` 的工具会被预启动，widget 工具天生不是 idempotent read
 *      （emit 状态变更事件 + 持久化），必须显式 `false`。
 *      （`tool-orchestration.ts` 的 `isConcurrencySafe` 也读 `isReadOnly`，但那是
 *      并发批次划分语义，与 preStart 不同路径——避免行号张冠李戴。）
 *
 *   2. **`llmStripKeys` 含 `_block.code`** — 巨型 SVG 不回流 LLM next-turn history。
 *
 *   3. **支持三格式** — Wave 6 上线支持 svg / html / mermaid。
 *
 *   4. **拒绝超长 code** — 8KB cap 防 LLM 失控吐 50KB SVG 让浏览器卡死。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createShowWidgetTool,
  SHOW_WIDGET_TOOL_NAME,
  __resetShowWidgetUsedRefsForTests,
} from '../src/tools/show-widget'
import { createPresentationTools } from '../src/tools/presentation-tools'
import { stripKeysFromResult } from '../src/engine/tooling/tool-system.js'
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';

/**
 * W4.5 第三波 C1（2026-05-13）fixture 重写：show_widget 实际生产路径走
 * `context.emitRichContentBlock({ kind: 'widget', summary, payload })` →
 * `query.ts.makeRichContentBlockEmitter` → envelope 5 件套。
 *
 * 为兼容大量已有断言形态 `(emit.mock.calls[0][0].payload as { blocks: [...] }).blocks[0]`，
 * makeContext 把 emit 同时桥接成 `emitRichContentBlock` callback——调用时合成一条
 * `agent.stream.content_block_start`-like envelope，把 args.payload 子键平铺到
 * `blocks[0]` 顶层（让原断言里 `block.kind / block.code / block.image_url / block.widget_id`
 * 等字段无缝可用），等同于"测试只 mock emit，行为等价"。
 *
 * envelope 真主路径已由 `tests/wave2/envelope-emitter.test.ts::emitDetachedMiniMessage`
 * 覆盖；本 fixture 不再模拟 envelope 5 件套形态。
 */
function makeContext(
  emitStreamEvent?: (e: StreamEvent) => void,
  messages?: Message[],
): ToolContext {
  return {
    threadId: 'tt-test',
    iteration: 1,
    emitStreamEvent,
    emitRichContentBlock: emitStreamEvent
      ? (args) => {
          // 把 emitRichContentBlock 入参合成一条 envelope-like event 喂给 emit，
          // 让"读 blocks[0].xxx"的老断言无缝兼容。block.payload 子键平铺到顶层。
          const flatBlock: Record<string, unknown> = {
            type: 'tabtin_rich_content',
            kind: args.kind,
            summary: args.summary,
            ...(args.groupId ? { group_id: args.groupId } : {}),
            ...(args.payload ?? {}),
          }
          emitStreamEvent({
            type: 'agent.stream.content_block_start',
            payload: { blocks: [flatBlock] },
          } as unknown as StreamEvent)
        }
      : undefined,
    messages: messages ?? [],
  } as unknown as ToolContext
}

beforeEach(() => {
  // Wave 2.5 自修复（技术 Review P0-1）：show-widget.ts 用 module-level WeakSet
  // 跟踪已 used 的 tool_use block，防"两 widget code 完全相同"双卡 bug。
  // 测试间必须重置 used 状态——vitest closure 可能让旧 block ref 残留。
  __resetShowWidgetUsedRefsForTests()
})

describe('show_widget tool — Wave 2.1 关键防线', () => {
  // ── 防线 1: isReadOnly=false（widget RFC §七 🔴 高严重度）─────────────
  it('必须 isReadOnly=false（防 preStartedTools 提前 execute 烤脏图）', () => {
    const tool = createShowWidgetTool({})
    expect(tool.isReadOnly).toBe(false)
  })

  it('createPresentationTools 一并 expose show_widget——ElectronToolProvider 不改也能拿到', () => {
    const tools = createPresentationTools({
      supportedResourceTypes: new Set(['table']),
      autoOpenPolicy: (t) => t !== 'slide',
    })
    const widget = tools.find((t) => t.name === SHOW_WIDGET_TOOL_NAME)
    expect(widget).toBeDefined()
    expect(widget?.isReadOnly).toBe(false)
  })

  // ── 防线 2: llmStripKeys 真生效（端到端，不只检查字段值）──────────────
  //
  // 技术 Review 发现的真 P0 bug：v1 用 dotted path `['_block.code', '_block.image_url']`，
  // `stripKeysFromResult` 只支持顶层 key，dotted path 默默 no-op，整个 5KB SVG
  // 全部回流 LLM history。修法是改用顶层 `['_block']`。本测试**端到端**断言：
  // strip 后的 content 不再含 SVG markup。
  it('llmStripKeys 必须是顶层 ["_block"]——dotted path 不生效', async () => {
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      {
        summary: 'k8s 三层架构',
        format: 'svg',
        code: '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>',
      },
      makeContext(vi.fn()),
    )
    expect(result.isError).toBeFalsy()
    expect(result.llmStripKeys).toEqual(['_block'])
  })

  it('端到端：strip 后的 content 真的不含 SVG markup（防假性通过）', async () => {
    const tool = createShowWidgetTool({})
    const heavySvg = '<svg viewBox="0 0 100 100">' + '<rect/>'.repeat(100) + '</svg>'
    const result = await tool.execute(
      { summary: '架构', format: 'svg', code: heavySvg },
      makeContext(vi.fn()),
    )
    const stripped = stripKeysFromResult(result)
    expect(typeof stripped).toBe('string')
    const strippedStr = stripped as string
    // 关键断言：SVG markup / 巨量 rect 不应该在 LLM 看到的 content 里
    expect(strippedStr).not.toContain('<svg')
    expect(strippedStr).not.toContain('<rect')
    // 但成功语义 / widget_id / summary 必须保留——LLM 需要知道工具调用结果
    expect(strippedStr).toContain('Widget rendered successfully')
    expect(strippedStr).toContain('widget_id')
    expect(strippedStr).toContain('架构')
    expect(strippedStr).not.toContain('"_block"')
  })

  // ── 防线 3: Wave 6 支持 svg/html/mermaid，继续拒绝未知格式 ───────────────
  it.each(['pdf', ''])(
    'format=%s 必须被拒绝',
    async (badFormat) => {
      const tool = createShowWidgetTool({})
      const result = await tool.execute(
        { summary: 'x', format: badFormat, code: '<svg/>' },
        makeContext(vi.fn()),
      )
      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content as string)
      expect(parsed.success).toBe(false)
      expect(parsed.error).toMatch(/format/)
    },
  )

  it('format=html 合法 no-script 片段会 emit HTML widget block', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const html = '<div style="color:hsl(var(--foreground))">设置页</div>'
    const result = await tool.execute(
      { summary: '设置页 mockup', format: 'html', code: html },
      makeContext(emit),
    )
    expect(result.isError).toBeFalsy()
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.format).toBe('html')
    expect(block.code).toBe(html)
  })

  it('format=html 允许受限 onclick="sendPrompt(...)" 交互', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const html = '<button style="cursor:pointer" onclick="sendPrompt(\'详细解释 ingress\', { node: \'ingress\' })">Ingress</button>'
    const result = await tool.execute(
      { summary: 'clickable html', format: 'html', code: html },
      makeContext(emit),
    )
    expect(result.isError).not.toBe(true)
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.code).toBe(html)
  })

  it('format=svg scrub script / unsafe event handler / javascript href，但保留受限 sendPrompt onclick', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const dirtySvg = '<svg onload="alert(1)"><script>alert(1)</script><text onclick="sendPrompt(\'解释 A\', { node: \'A\' })">A</text><a href="javascript:alert(1)"><text>B</text></a></svg>'
    const result = await tool.execute(
      { summary: 'dirty svg', format: 'svg', code: dirtySvg },
      makeContext(emit),
    )
    expect(result.isError).toBeFalsy()
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    const cleaned = String(block.code)
    expect(cleaned).toContain('<svg')
    expect(cleaned).toContain("onclick=\"sendPrompt('解释 A', { node: 'A' })\"")
    expect(cleaned).not.toMatch(/<script|onload=|javascript:/i)
  })

  it.each([
    '<script src="https://evil.test/x.js"></script>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.test"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<form action="/x"></form>',
    '<div onclick="alert(1)">x</div>',
    '<div onmouseover="sendPrompt(\'x\')">x</div>',
    '<div onclick="sendPrompt(\'x\'); alert(1)">x</div>',
  ])('format=html 拒绝高风险内容：%s', async (html) => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { summary: 'bad html', format: 'html', code: html },
      makeContext(emit),
    )
    expect(result.isError).toBe(true)
    expect(emit).not.toHaveBeenCalled()
    const parsed = JSON.parse(result.content as string)
    expect(parsed.success).toBe(false)
  })

  it('format=mermaid 编译成 SVG 后 emit；不依赖 runtime mermaid script', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { summary: '简单流程图', format: 'mermaid', code: 'graph TD; A-->B;' },
      makeContext(emit),
    )
    expect(result.isError).toBeFalsy()
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.format).toBe('mermaid')
    expect(String(block.code)).toContain('<svg')
    expect(String(block.code)).not.toMatch(/mermaid\.js|<script/i)
    expect(block.source_code).toBe('graph TD; A-->B;')
    expect(block.rendered_code).toBe(block.code)
  })

  it('format=mermaid 拒绝 click/javascript，且不 emit widget', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { summary: 'bad mermaid', format: 'mermaid', code: 'graph TD; A-->B; click A "javascript:alert(1)"' },
      makeContext(emit),
    )
    expect(result.isError).toBe(true)
    expect(emit).not.toHaveBeenCalled()
    const parsed = JSON.parse(result.content as string)
    expect(parsed.error).toMatch(/click|javascript/i)
  })

  it('format=mermaid 编译失败时 error 正文带真实异常（供 LLM 自修复）', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { summary: 'broken mermaid', format: 'mermaid', code: 'flowchart LR\n  A{未闭合' },
      makeContext(emit),
    )
    expect(result.isError).toBe(true)
    expect(emit).not.toHaveBeenCalled()
    const parsed = JSON.parse(result.content as string)
    expect(parsed.error_kind).toBe('widget_render_failed')
    expect(parsed.error).not.toBe('Widget source could not be rendered for the selected format.')
    expect(String(parsed.error).length).toBeGreaterThan(20)
  })

  // ── 防线 5: 拒绝超长 code（8KB cap）────────────────────────────────
  it('code 超过 8KB 必须被拒绝（防 LLM 失控吐 50KB SVG 卡死浏览器）', async () => {
    const tool = createShowWidgetTool({})
    const hugeCode = '<svg>' + 'x'.repeat(9 * 1024) + '</svg>'
    const result = await tool.execute(
      { summary: 'x', format: 'svg', code: hugeCode },
      makeContext(vi.fn()),
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toMatch(/too large|8KB/)
  })

  // ── 防线 6: 必填字段守护 ──────────────────────────────────────────
  it('summary 缺失必须被拒绝（移动端 fallback + a11y 用）', async () => {
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { format: 'svg', code: '<svg/>' },
      makeContext(vi.fn()),
    )
    expect(result.isError).toBe(true)
  })

  it('code 缺失必须被拒绝', async () => {
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { summary: 'x', format: 'svg' },
      makeContext(vi.fn()),
    )
    expect(result.isError).toBe(true)
  })

  // ── 防线 7: headless 模式拒绝（与 present_to_user 行为一致）──────
  it('没有 emitStreamEvent 时拒绝 execute（widget 必须有 UI 通道）', async () => {
    const tool = createShowWidgetTool({})
    const result = await tool.execute(
      { summary: 'x', format: 'svg', code: '<svg/>' },
      makeContext(undefined),
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.error).toMatch(/UI session|headless/)
  })

  // ── 防线 8: 工具注册名称稳定 ──────────────────────────────────────
  it('工具 name 必须是 "show_widget"（与 sections.ts / Python 镜像 / 前端路由对齐）', () => {
    const tool = createShowWidgetTool({})
    expect(tool.name).toBe('show_widget')
    expect(tool.name).toBe(SHOW_WIDGET_TOOL_NAME)
  })

  // ── 防线 9: utf-8 字节数计算（中文 SVG 不能假性放过）─────────────
  it('中文 SVG 的字节数限制按 utf-8 字节而非 character count', async () => {
    const tool = createShowWidgetTool({})
    // 9KB 中文（每个字符 3 bytes）但 character count 只有 ~3K
    const cnCode = '<svg>' + '中'.repeat(3 * 1024) + '</svg>'
    const result = await tool.execute(
      { summary: 'x', format: 'svg', code: cnCode },
      makeContext(vi.fn()),
    )
    expect(result.isError).toBe(true) // 9KB > 8KB cap
  })

  // ── 防线 10（Widget Wave 2.5）: emit 时启发式从 context.messages 找
  // tool_call_id 注入到 RICH_CONTENT block，让前端按 tool_call_id 替换 placeholder。
  //
  // 业务目的：tool-orchestration.ts 是禁改文件，工具拿不到自己的 tool_call_id；
  // 这里用 context.messages 的 tool_use blocks 启发式反查——以 input.code 严格
  // 匹配为主，name 匹配为兜底，确保多 widget 并行时也能精确关联。
  describe('防线 10: emit 时注入 tool_call_id（让前端按 tool_call_id 关联 placeholder）', () => {
    it('严格匹配：context.messages 含 show_widget tool_use 且 input.code 相等时注入对应 id', async () => {
      const emit = vi.fn<(e: StreamEvent) => void>()
      const tool = createShowWidgetTool({})
      const targetCode = '<svg viewBox="0 0 100 100"><rect/></svg>'
      const messages: Message[] = [
        {
          role: 'user',
          content: '画一张图',
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_target', name: 'show_widget', input: { summary: 'x', format: 'svg', code: targetCode } },
          ],
        },
      ]
      await tool.execute(
        { summary: 'x', format: 'svg', code: targetCode },
        makeContext(emit, messages),
      )
      const event = emit.mock.calls[0][0]
      const block = (event.payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block.tool_call_id).toBe('tu_target')
    })

    it('多 widget 并行：input.code 严格匹配让两次调用各自拿到正确 tool_call_id', async () => {
      const tool = createShowWidgetTool({})
      const code1 = '<svg><rect/></svg>'
      const code2 = '<svg><circle/></svg>'
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'show_widget', input: { summary: 'a', format: 'svg', code: code1 } },
            { type: 'tool_use', id: 'tu_2', name: 'show_widget', input: { summary: 'b', format: 'svg', code: code2 } },
          ],
        },
      ]
      // 调用 1（code1）—— 应注入 tu_1
      const emit1 = vi.fn<(e: StreamEvent) => void>()
      await tool.execute({ summary: 'a', format: 'svg', code: code1 }, makeContext(emit1, messages))
      const block1 = (emit1.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block1.tool_call_id).toBe('tu_1')

      // 调用 2（code2）—— 应注入 tu_2
      const emit2 = vi.fn<(e: StreamEvent) => void>()
      await tool.execute({ summary: 'b', format: 'svg', code: code2 }, makeContext(emit2, messages))
      const block2 = (emit2.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block2.tool_call_id).toBe('tu_2')
    })

    it('退化路径：messages 没 show_widget tool_use 时不注入 tool_call_id（不抛错）', async () => {
      const emit = vi.fn<(e: StreamEvent) => void>()
      const tool = createShowWidgetTool({})
      const messages: Message[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '我在想' },
      ]
      await tool.execute(
        { summary: 'x', format: 'svg', code: '<svg/>' },
        makeContext(emit, messages),
      )
      const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      // 找不到 → 不带 tool_call_id（前端走 append 退化路径，不阻塞渲染）
      expect(block.tool_call_id).toBeUndefined()
      // 但 widget_id 仍正常生成（渲染功能不退化）
      expect(typeof block.widget_id).toBe('string')
      expect((block.widget_id as string).startsWith('wgt_')).toBe(true)
    })

    it('messages 缺失（空 context）时不抛错（健壮性）', async () => {
      const emit = vi.fn<(e: StreamEvent) => void>()
      const tool = createShowWidgetTool({})
      const result = await tool.execute(
        { summary: 'x', format: 'svg', code: '<svg/>' },
        makeContext(emit), // messages 默认 []
      )
      expect(result.isError).toBeFalsy()
      const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block.tool_call_id).toBeUndefined()
    })

    // Wave 2.5 自修复（技术 Review P0-1 守护）：两个 widget input.code 完全相同时
    // 启发式查找通过 used WeakSet 让两次 execute 各自拿到不同 toolCallId。旧实现
    // 反向遍历总取最后一个匹配 → 两次 execute 重复关联到同一 toolCallId → 第一张
    // placeholder 永远转圈。
    it('两个 widget input.code 完全相同时按 messages 出现顺序对齐 toolCallId（不双卡 bug）', async () => {
      const tool = createShowWidgetTool({})
      const sharedCode = '<svg viewBox="0 0 50 50"><rect/></svg>'
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_first', name: 'show_widget', input: { summary: 'a', format: 'svg', code: sharedCode } },
            { type: 'tool_use', id: 'tu_second', name: 'show_widget', input: { summary: 'b', format: 'svg', code: sharedCode } },
          ],
        },
      ]
      // tool 1 execute（先 execute 的拿 messages 里**正向第一个**未 used 的 tu_first）
      const emit1 = vi.fn<(e: StreamEvent) => void>()
      await tool.execute({ summary: 'a', format: 'svg', code: sharedCode }, makeContext(emit1, messages))
      const block1 = (emit1.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block1.tool_call_id).toBe('tu_first')

      // tool 2 execute（拿 tu_second，因为 tu_first 已被 used WeakSet 标记）
      const emit2 = vi.fn<(e: StreamEvent) => void>()
      await tool.execute({ summary: 'b', format: 'svg', code: sharedCode }, makeContext(emit2, messages))
      const block2 = (emit2.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block2.tool_call_id).toBe('tu_second')

      // 关键不变量：两个 toolCallId **不相同**（守住"双卡 bug 已修"）
      expect(block1.tool_call_id).not.toBe(block2.tool_call_id)
    })

    // 退化路径（input.code 变了 / messages 没 commit 当前轮 tool_use）的 used
    // 跟踪：仍按 messages 出现顺序正向取走未 used 的 tool_use。
    it('退化路径下两次 execute 也按 messages 顺序对齐（input.code 不严格匹配也分两个 id）', async () => {
      const tool = createShowWidgetTool({})
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            // input.code 与 execute 时的 code **不**完全相同 → 走退化路径
            { type: 'tool_use', id: 'tu_a', name: 'show_widget', input: { summary: 'x', format: 'svg', code: 'placeholder1' } },
            { type: 'tool_use', id: 'tu_b', name: 'show_widget', input: { summary: 'y', format: 'svg', code: 'placeholder2' } },
          ],
        },
      ]
      const emit1 = vi.fn<(e: StreamEvent) => void>()
      await tool.execute({ summary: 'x', format: 'svg', code: '<svg><rect/></svg>' }, makeContext(emit1, messages))
      const block1 = (emit1.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block1.tool_call_id).toBe('tu_a')

      const emit2 = vi.fn<(e: StreamEvent) => void>()
      await tool.execute({ summary: 'y', format: 'svg', code: '<svg><circle/></svg>' }, makeContext(emit2, messages))
      const block2 = (emit2.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
      expect(block2.tool_call_id).toBe('tu_b')
    })
  })

  // Wave 2.5 自修复（产品 Review P1-4 守护）：schema properties 字段顺序决定 LLM
  // 流式吐 args 顺序——loading_message 必须在 code 之前，否则 partial 期间用户
  // 看不到 Agent 自定义 loading_message（被 SVG iframe 抢先覆盖）。
  describe('schema 字段顺序：loading_message 在 code 之前（让自定义文案在 partial 期生效）', () => {
    it('inputSchema.properties keys 里 loading_message 在 code 之前', () => {
      const tool = createShowWidgetTool({})
      const props = (tool.inputSchema as unknown as { properties: Record<string, unknown> }).properties
      const keys = Object.keys(props)
      const idxLoading = keys.indexOf('loading_message')
      const idxCode = keys.indexOf('code')
      expect(idxLoading).toBeGreaterThanOrEqual(0)
      expect(idxCode).toBeGreaterThanOrEqual(0)
      // 关键不变量：loading_message **早于** code
      expect(idxLoading).toBeLessThan(idxCode)
    })
  })
})
