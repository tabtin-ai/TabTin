import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ServerToolBlockView } from '../ServerToolBlockView'
import type { ContentBlockEntry } from '../types'

function makeServerTool(type: string, extra: Record<string, unknown> = {}): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'srv-1',
    block: { type, name: 'web_search', input: { query: 'test' }, ...extra } as ContentBlockEntry['block'],
    finalized: true,
    partial: false,
  }
}

describe('ServerToolBlockView', () => {
  it('happy: server_tool_use renders with Anthropic badge', () => {
    render(<ServerToolBlockView entry={makeServerTool('server_tool_use')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-server-tool-use')).toBeTruthy()
    expect(screen.getByText('blockTimeline.serverTool.badge')).toBeTruthy()
  })

  it('happy: click expands to show input JSON', () => {
    render(<ServerToolBlockView entry={makeServerTool('server_tool_use')} sessionId="s1" messageId="m1" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/"query"/)).toBeTruthy()
  })

  it('web_search_tool_result: renders inside the matching server tool call', () => {
    render(
      <ServerToolBlockView
        entry={makeServerTool('server_tool_use')}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: [
            { type: 'web_search_result', url: 'https://example.com', title: 'Example' },
          ],
        }}
      />,
    )
    expect(screen.getByText('card.result_count')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Example')).toBeTruthy()
  })

  it('code_execution_tool_result: renders execution result', () => {
    const entry: ContentBlockEntry = {
      index: 0,
      block_id: 'code-1',
      block: { type: 'code_execution_tool_result', content: 'stdout output' } as ContentBlockEntry['block'],
      finalized: true,
      partial: false,
    }
    render(<ServerToolBlockView entry={entry} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-code-execution-result')).toBeTruthy()
  })

  it('fallback: unknown server tool type renders null (graceful)', () => {
    const { container } = render(<ServerToolBlockView entry={makeServerTool('unknown_server_thing')} sessionId="s1" messageId="m1" />)
    expect(container.children.length).toBe(0)
  })
})
