import { describe, it, expect } from 'vitest'
import {
  pairToolResultsByBlock,
  extractSubagentRunIdFromResult,
  stripApprovalNotePrefix,
  stripSubagentIdMarker,
  toolUseIdOf,
  isToolResultBlock,
  type SemanticBlock,
} from '../contentBlockSemantics'

describe('contentBlockSemantics.stripApprovalNotePrefix', () => {
  it('剥掉审批回执前缀，保留后续 JSON envelope', () => {
    const raw = '<approval_note>\nTool \'run_terminal_command\' was auto-approved by the user\'s standing "always allow" rule.\n</approval_note>\n\n{"exit_code":1,"stdout":"boom"}'
    expect(stripApprovalNotePrefix(raw)).toBe('{"exit_code":1,"stdout":"boom"}')
  })

  it('剥掉前缀后保留纯文本输出（非 JSON）', () => {
    const raw = '<approval_note>\nUser approved tool \'read_file\'.\n</approval_note>\n\nline1\nline2'
    expect(stripApprovalNotePrefix(raw)).toBe('line1\nline2')
  })

  it('无前缀原样返回，不误剥正文中出现的字样', () => {
    expect(stripApprovalNotePrefix('{"ok":true}')).toBe('{"ok":true}')
    expect(stripApprovalNotePrefix('日志里提到 approval_note 但不是前缀')).toBe('日志里提到 approval_note 但不是前缀')
  })

  it('残缺前缀（无闭合标签）原样返回', () => {
    expect(stripApprovalNotePrefix('<approval_note>\nhalf')).toBe('<approval_note>\nhalf')
  })
})

describe('contentBlockSemantics.pairToolResultsByBlock', () => {
  it('按 tool_use.id 配对，键为发起块 block_id', () => {
    const blocks: SemanticBlock[] = [
      { type: 'tool_use', id: 'agent_0', block_id: 'blk-a' },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'ok' },
    ]
    const map = pairToolResultsByBlock(blocks)
    expect(map.get('blk-a')).toEqual({ content: 'ok', isError: false })
  })

  it('同序列内重复 tool_use.id 按 FIFO 配对（第 N use 配第 N result）', () => {
    const blocks: SemanticBlock[] = [
      { type: 'tool_use', id: 'agent_0', block_id: 'blk-1' },
      { type: 'tool_use', id: 'agent_0', block_id: 'blk-2' },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'first' },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'second' },
    ]
    const map = pairToolResultsByBlock(blocks)
    expect(map.get('blk-1')).toEqual({ content: 'first', isError: false })
    expect(map.get('blk-2')).toEqual({ content: 'second', isError: false })
  })

  it('is_error 透传', () => {
    const blocks: SemanticBlock[] = [
      { type: 'tool_use', id: 't1', block_id: 'blk-e' },
      { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true },
    ]
    expect(pairToolResultsByBlock(blocks).get('blk-e')).toEqual({ content: 'boom', isError: true })
  })

  it('无 block_id 时回退 id 作键', () => {
    const blocks: SemanticBlock[] = [
      { type: 'tool_use', id: 'only-id' },
      { type: 'tool_result', tool_use_id: 'only-id', content: 'x' },
    ]
    expect(pairToolResultsByBlock(blocks).get('only-id')).toEqual({ content: 'x', isError: false })
  })

  it('运行中（无 result）不产生条目', () => {
    const blocks: SemanticBlock[] = [{ type: 'tool_use', id: 'running', block_id: 'blk-r' }]
    expect(pairToolResultsByBlock(blocks).size).toBe(0)
  })

  it('把 web_search_tool_result 配给 server_tool_use', () => {
    const content = [
      { type: 'web_search_result', url: 'https://example.com', title: 'Example' },
    ]
    const blocks: SemanticBlock[] = [
      { type: 'server_tool_use', id: 'srvtoolu_1', block_id: 'server-block' },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content,
      },
    ]
    expect(pairToolResultsByBlock(blocks).get('server-block')).toEqual({
      content,
      isError: false,
    })
  })

  it('实时块乱序：生图 tool_result 先于 tool_use 到达仍能恢复展示语义', () => {
    const blocks: SemanticBlock[] = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-image-1',
        content: '{"ok":true}',
        presentation: {
          kind: 'media_image_generation',
          data: { prompt: '一只猫' },
        },
      },
      {
        type: 'tool_use',
        id: 'tool-image-1',
        name: 'run_terminal_command',
        block_id: 'block-image-1',
      },
    ]

    expect(pairToolResultsByBlock(blocks).get('block-image-1')).toEqual({
      content: '{"ok":true}',
      isError: false,
      presentation: {
        kind: 'media_image_generation',
        data: { prompt: '一只猫' },
      },
    })
  })
})

describe('contentBlockSemantics marker', () => {
  it('extractSubagentRunIdFromResult 解析 uuid', () => {
    expect(extractSubagentRunIdFromResult('done\n\n[子 Agent ID: abc-123]')).toBe('abc-123')
  })

  it('从 ContentBlock[] content 解析', () => {
    expect(extractSubagentRunIdFromResult([{ type: 'text', text: 'hi [子 Agent ID: uid-9]' }])).toBe('uid-9')
  })

  it('无 marker 返回 undefined', () => {
    expect(extractSubagentRunIdFromResult('plain')).toBeUndefined()
  })

  it('stripSubagentIdMarker 去掉标记留正文', () => {
    expect(stripSubagentIdMarker('summary text\n\n[子 Agent ID: xxx]')).toBe('summary text')
  })
})

describe('contentBlockSemantics 判定', () => {
  it('toolUseIdOf 识别三类工具块', () => {
    expect(toolUseIdOf({ type: 'tool_use', id: 'a' })).toBe('a')
    expect(toolUseIdOf({ type: 'mcp_tool_use', id: 'b' })).toBe('b')
    expect(toolUseIdOf({ type: 'server_tool_use', id: 'c' })).toBe('c')
    expect(toolUseIdOf({ type: 'text' })).toBeUndefined()
  })

  it('isToolResultBlock 识别结果块', () => {
    expect(isToolResultBlock({ type: 'tool_result' })).toBe(true)
    expect(isToolResultBlock({ type: 'mcp_tool_result' })).toBe(true)
    expect(isToolResultBlock({ type: 'web_search_tool_result' })).toBe(true)
    expect(isToolResultBlock({ type: 'tool_use' })).toBe(false)
  })
})
