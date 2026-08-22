import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPresentationTools } from '../src/tools/presentation-tools.js'
import {
  __resetShowFlowViewUsedRefsForTests,
  createShowFlowViewTool,
  SHOW_FLOW_VIEW_TOOL_NAME,
} from '../src/tools/show-flow-view.js'
import type { ToolContext } from '../src/engine/contracts/tools.js'
import type { Message } from '../src/engine/contracts/conversation.js'

function makeContext(emit = vi.fn(), messages?: Message[]): ToolContext {
  return {
    threadId: 'thread-flow',
    iteration: 1,
    messages: messages ?? [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-flow-1',
        name: SHOW_FLOW_VIEW_TOOL_NAME,
        input: { title: '登录排查' },
      }],
    }],
    emitRichContentBlock: emit,
  } as unknown as ToolContext
}

describe('show_flow_view', () => {
  beforeEach(() => __resetShowFlowViewUsedRefsForTests())

  it('不随默认展示工具注册，只保留显式兼容工厂', () => {
    const tools = createPresentationTools({
      supportedResourceTypes: new Set(['table']),
      autoOpenPolicy: () => false,
    })
    const tool = tools.find((item) => item.name === SHOW_FLOW_VIEW_TOOL_NAME)
    expect(tool).toBeUndefined()

    const compatibilityTool = createShowFlowViewTool()
    expect(compatibilityTool.description).toContain('已弃用')
    expect(compatibilityTool.description).toContain('不得注册到 Agent Chat 默认工具集')
    expect(compatibilityTool.description).toContain('TabDoc')
  })

  it('输出原生流程语义、tool_call_id 与旧客户端可读的安全 HTML', async () => {
    const emit = vi.fn()
    const tool = createShowFlowViewTool()
    const result = await tool.execute({
      title: '登录排查',
      summary: '登录排查流程',
      nodes: [
        { id: 'root', label: '收集 <证据>', status: 'active' },
        { id: 'cause', parent_id: 'root', label: '定位根因', status: 'pending' },
      ],
    }, makeContext(emit))

    expect(result.isError).toBeFalsy()
    expect(result.llmStripKeys).toEqual(['_block'])
    expect(emit).toHaveBeenCalledTimes(1)
    const emitted = emit.mock.calls[0][0]
    expect(emitted.kind).toBe('widget')
    expect(emitted.payload).toMatchObject({
      widget_variant: 'flow_view',
      format: 'html',
      tool_call_id: 'tool-flow-1',
      flow_view: {
        version: 1,
        title: '登录排查',
      },
    })
    expect(emitted.payload.flow_view.nodes[0]).toEqual({
      id: 'root',
      label: '收集 <证据>',
      status: 'active',
    })
    expect(emitted.payload.code).toContain('收集 &lt;证据&gt;')
    expect(emitted.payload.code).not.toContain('<script')
  })

  it('拒绝缺失父节点和循环关系，避免把无效结构交给客户端猜测', async () => {
    const tool = createShowFlowViewTool()
    const result = await tool.execute({
      title: '异常流程',
      summary: '异常流程',
      nodes: [
        { id: 'a', parent_id: 'b', label: 'A' },
        { id: 'b', parent_id: 'a', label: 'B' },
      ],
    }, makeContext())
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('cycle')
  })

  it('同轮多个同标题流程依次关联各自的 tool_call_id', async () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-flow-a', name: SHOW_FLOW_VIEW_TOOL_NAME, input: { title: '流程' } },
        { type: 'tool_use', id: 'tool-flow-b', name: SHOW_FLOW_VIEW_TOOL_NAME, input: { title: '流程' } },
      ],
    }]
    const emit = vi.fn()
    const tool = createShowFlowViewTool()
    const input = { title: '流程', summary: '流程', nodes: [{ id: 'root', label: '开始' }] }

    await tool.execute(input, makeContext(emit, messages))
    await tool.execute(input, makeContext(emit, messages))

    expect(emit.mock.calls.map((call) => call[0].payload.tool_call_id)).toEqual([
      'tool-flow-a',
      'tool-flow-b',
    ])
  })
})
