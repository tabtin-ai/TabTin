import { describe, it, expect } from 'vitest'
import { deserializeContentBlocks } from '../deserializeContentBlocks'

const MID = 'msg-test-1'

describe('deserializeContentBlocks', () => {
  it('returns empty for empty/null input', () => {
    expect(deserializeContentBlocks([], MID)).toEqual([])
    expect(deserializeContentBlocks([null as any, undefined as any], MID)).toEqual([])
  })

  it('passes through Anthropic native blocks (lite-collector inject)', () => {
    const blocks = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'toolu_001', name: 'read_file', input: { path: '/a.py' } },
      { type: 'thinking', thinking: 'Let me think...', signature: 'sig' },
    ]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(3)
    expect(result[0].block.type).toBe('text')
    expect(result[1].block.type).toBe('tool_use')
    expect(result[2].block.type).toBe('thinking')
    expect(result[0].index).toBe(0)
    expect(result[1].index).toBe(1)
    expect(result[2].index).toBe(2)
    result.forEach(e => {
      expect(e.finalized).toBe(true)
      expect(e.partial).toBe(false)
    })
  })

  it('converts old "thinking" block (content field)', () => {
    const blocks = [{ type: 'thinking', content: 'Deep analysis here' }]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(1)
    expect(result[0].block.type).toBe('thinking')
    expect((result[0].block as any).thinking).toBe('Deep analysis here')
    expect((result[0].block as any).signature).toBe('')
  })

  it('converts old "tool_call" block into tool_use + tool_result pair', () => {
    const blocks = [{
      type: 'tool_call',
      tool_name: 'read_file',
      tool_call_id: 'tc_001',
      input: { path: '/foo.py' },
      output: 'file content here',
    }]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(2)
    expect(result[0].block.type).toBe('tool_use')
    expect((result[0].block as any).name).toBe('read_file')
    expect((result[0].block as any).id).toBe('tc_001')
    expect(result[1].block.type).toBe('tool_result')
    expect((result[1].block as any).content).toBe('file content here')
    expect(result[0].index).toBe(0)
    expect(result[1].index).toBe(1)
  })

  it('converts old "tool_call" with error', () => {
    const blocks = [{
      type: 'tool_call',
      tool_name: 'bash',
      tool_call_id: 'tc_002',
      input: { command: 'ls' },
      error: true,
      output: 'permission denied',
    }]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(2)
    expect((result[1].block as any).is_error).toBe(true)
  })

  it('converts old "rich_content" block', () => {
    const blocks = [{
      type: 'rich_content',
      kind: 'widget',
      summary: 'Chart preview',
      tool_call_id: 'tc_003',
      code: '<svg>...</svg>',
    }]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(1)
    expect(result[0].block.type).toBe('tabtin_rich_content')
    expect((result[0].block as any).kind).toBe('widget')
    expect((result[0].block as any).summary).toBe('Chart preview')
  })

  it('skips user echo blocks (composer_preset, ask_user_fields, context_ref, etc.)', () => {
    const blocks = [
      { type: 'composer_preset', preset_id: 'p1' },
      { type: 'ask_user_fields', field_values: {} },
      { type: 'context_ref', ref_id: 'r1' },
      { type: 'document_ref', doc_id: 'd1' },
      { type: 'source_ref', source_id: 's1' },
      { type: 'metadata', usage: {} },
    ]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(0)
  })

  it('pushes unknown block types to FallbackBlockView (forward compat)', () => {
    const blocks = [
      { type: 'code_artifact_v3', code: 'print("hello")' },
      { type: 'text', text: 'After unknown' },
    ]
    const result = deserializeContentBlocks(blocks, MID)
    expect(result).toHaveLength(2)
    expect(result[0].block.type).toBe('code_artifact_v3')
    expect(result[0].block_id).toContain('legacy-unknown')
    expect(result[1].block.type).toBe('text')
  })

  it('block_id aligns with index (no off-by-one)', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]
    const result = deserializeContentBlocks(blocks, MID)
    for (const entry of result) {
      if (entry.block_id.startsWith('legacy-native-')) {
        const idSuffix = parseInt(entry.block_id.split('-').pop()!, 10)
        expect(idSuffix).toBe(entry.index)
      }
    }
  })

  it('handles mixed old + native blocks in correct order', () => {
    const blocks = [
      { type: 'thinking', content: 'hmm' },
      { type: 'text', text: 'I will help' },
      { type: 'tool_call', tool_name: 'read_file', tool_call_id: 'tc1', input: { path: '/a' }, output: 'content' },
      { type: 'rich_content', kind: 'image', summary: 'Screenshot' },
      { type: 'text', text: 'Done!' },
    ]
    const result = deserializeContentBlocks(blocks, MID)
    const types = result.map(e => e.block.type)
    expect(types).toEqual([
      'thinking',
      'text',
      'tool_use',
      'tool_result',
      'tabtin_rich_content',
      'text',
    ])
    for (let i = 0; i < result.length; i++) {
      expect(result[i].index).toBe(i)
    }
  })

  // W4c · R6-P0-1 关键修复：从 stop_reason / error_info_json / metadata 三源
  // 推断 partialReason，让历史回放显示与直播一致的"已中断 / 等待响应超时"
  describe('W4c · R6-P0-1 historical partialReason inference', () => {
    const TEXT_BLOCKS = [{ type: 'text', text: 'partial response' }]

    it('stop_reason="aborted" → 末尾 entry partialReason="aborted"', () => {
      const result = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        stopReason: 'aborted',
      })
      expect(result).toHaveLength(1)
      expect(result[0].partial).toBe(true)
      expect(result[0].partialReason).toBe('aborted')
    })

    it('stop_reason="error" → partialReason="stream_interrupted"', () => {
      const result = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        stopReason: 'error',
      })
      expect(result).toHaveLength(1)
      expect(result[0].partial).toBe(true)
      expect(result[0].partialReason).toBe('stream_interrupted')
    })

    it('stop_reason="timeout" / "refusal" → partialReason="stream_interrupted"', () => {
      for (const stopReason of ['timeout', 'refusal']) {
        const result = deserializeContentBlocks(TEXT_BLOCKS, MID, { stopReason })
        expect(result[0].partialReason).toBe('stream_interrupted')
      }
    })

    it('stop_reason="end_turn" / "tool_use" / "stop_sequence" → 不打 partial（正常完成）', () => {
      for (const stopReason of ['end_turn', 'tool_use', 'stop_sequence', 'max_tokens']) {
        const result = deserializeContentBlocks(TEXT_BLOCKS, MID, { stopReason })
        expect(result[0].partial).toBe(false)
        expect(result[0].partialReason).toBeUndefined()
      }
    })

    it('error_info_json.aborted=true → partialReason="aborted"（即使 stop_reason 缺失）', () => {
      const result = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        errorInfo: { aborted: true, category: 'aborted', error_message: '用户中止' },
      })
      expect(result[0].partialReason).toBe('aborted')
    })

    it('error_info_json.category="aborted" → partialReason="aborted"', () => {
      const result = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        errorInfo: { category: 'aborted' },
      })
      expect(result[0].partialReason).toBe('aborted')
    })

    it('error_info_json.category 非 aborted → partialReason="stream_interrupted"', () => {
      const result = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        errorInfo: { category: 'tool_exec', error_message: '工具失败' },
      })
      expect(result[0].partialReason).toBe('stream_interrupted')
    })

    it('优先级：stop_reason > error_info_json > metadata', () => {
      // stop_reason="aborted" 优先于 error_info_json.category="error"
      const r1 = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        stopReason: 'aborted',
        errorInfo: { category: 'tool_exec' },
      })
      expect(r1[0].partialReason).toBe('aborted')

      // 缺 stop_reason 时 error_info_json 优先于 metadata.aborted
      const r2 = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        errorInfo: { category: 'tool_exec' },
        metadata: { aborted: true },
      })
      // error_info 是 'tool_exec' 非 aborted → stream_interrupted
      expect(r2[0].partialReason).toBe('stream_interrupted')
    })

    it('metadata fallback：仅老 metadata.aborted → partialReason="aborted"', () => {
      const result = deserializeContentBlocks(TEXT_BLOCKS, MID, {
        metadata: { aborted: true },
      })
      expect(result[0].partialReason).toBe('aborted')
    })

    it('老调用（仅传 metadata 对象，不带 signals 包装）兼容', () => {
      const result = deserializeContentBlocks(
        TEXT_BLOCKS,
        MID,
        // 直接传普通 metadata 对象（无 stopReason / errorInfo 字段）
        { aborted: true, errorClass: 'USER_CANCELLED' },
      )
      expect(result[0].partialReason).toBe('aborted')
    })

    it('多 block 时 partialReason 仅打到末尾 entry', () => {
      const blocks = [
        { type: 'text', text: 'first' },
        { type: 'tool_use', id: 'tu1', name: 'read', input: {} },
        { type: 'text', text: 'last' },
      ]
      const result = deserializeContentBlocks(blocks, MID, {
        stopReason: 'aborted',
      })
      expect(result).toHaveLength(3)
      expect(result[0].partial).toBe(false)
      expect(result[1].partial).toBe(false)
      expect(result[2].partial).toBe(true)
      expect(result[2].partialReason).toBe('aborted')
    })

    it('正常完成：所有 entry partial=false', () => {
      const blocks = [{ type: 'text', text: 'normal response' }]
      const result = deserializeContentBlocks(blocks, MID, {
        stopReason: 'end_turn',
      })
      expect(result[0].partial).toBe(false)
      expect(result[0].partialReason).toBeUndefined()
    })

    it('signals=null / undefined：保持兼容（partial=false）', () => {
      const r1 = deserializeContentBlocks(TEXT_BLOCKS, MID, null)
      expect(r1[0].partial).toBe(false)
      const r2 = deserializeContentBlocks(TEXT_BLOCKS, MID)
      expect(r2[0].partial).toBe(false)
    })
  })
})
