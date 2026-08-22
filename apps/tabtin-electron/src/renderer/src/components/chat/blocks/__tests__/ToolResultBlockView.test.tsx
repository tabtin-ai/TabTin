import React from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ToolResultBlockView } from '../ToolResultBlockView'
import type { ContentBlockEntry } from '../types'

function makeResult(content: string | unknown[], isError = false, overrides: Partial<ContentBlockEntry> = {}): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'result-1',
    block: { type: 'tool_result', tool_use_id: 'toolu_001', content, is_error: isError },
    finalized: true,
    partial: false,
    ...overrides,
  }
}

// ：tool_result 是上游 tool_use 卡片的数据输入，不再独立渲染折叠面板。
describe('ToolResultBlockView', () => {
  it('success: 不渲染（合并到 tool_use 卡片，避免重复）', () => {
    const { container } = render(
      <ToolResultBlockView entry={makeResult('file content here\nline 2')} sessionId="s1" messageId="m1" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('success: 即使长 content / 数组 content 也不渲染', () => {
    const long = render(<ToolResultBlockView entry={makeResult('x'.repeat(5000))} sessionId="s1" messageId="m1" />)
    expect(long.container.firstChild).toBeNull()
    long.unmount()
    const arr = render(<ToolResultBlockView
      entry={makeResult([{ type: 'text', text: 'line A' }, { type: 'image' }, { type: 'text', text: 'line B' }])}
      sessionId="s1"
      messageId="m1"
    />)
    expect(arr.container.firstChild).toBeNull()
  })

  it('error: is_error=true 也不渲染独立卡片，避免和工具调用卡重复', () => {
    const { container } = render(
      <ToolResultBlockView entry={makeResult('Error: file not found', true)} sessionId="s1" messageId="m1" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('error: 空 content 也不渲染且不崩', () => {
    const { container } = render(<ToolResultBlockView entry={makeResult('', true)} sessionId="s1" messageId="m1" />)
    expect(container.firstChild).toBeNull()
  })
})
