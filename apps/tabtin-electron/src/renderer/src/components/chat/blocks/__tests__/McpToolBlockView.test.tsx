import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, it, expect } from 'vitest'
import { McpToolBlockView } from '../McpToolBlockView'
import type { ContentBlockEntry } from '../types'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useChatStore } from '@stores/chat/useChatStore'
import type { ChatMessage } from '@tabtin/chat-client'
import { commitBlocks, __resetMessageBlocks } from '@stores/chat/messages/messageBlocks'

/** 单一 store = message.blocks：commit 前须有消息壳（镜像生产 message_start 建壳）。 */
function seedShell(sessionId: string, messageId: string): void {
  const cur = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  useChatStore.getState().setSessionMessages(sessionId, [
    ...cur,
    { id: messageId, role: 'assistant', content: '', created_at: '2025-01-01T00:00:00Z' } as ChatMessage,
  ])
}

function makeMcpUse(name = 'mcp_tool', serverName = 'my-server'): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'mcp-use-1',
    block: {
      type: 'mcp_tool_use',
      id: 'mcp_001',
      name,
      server_name: serverName,
      input: { key: 'val' },
    } as ContentBlockEntry['block'],
    finalized: true,
    partial: false,
  }
}

function makeMcpResult(content: string | unknown[] = 'result text', isError = false): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'mcp-res-1',
    block: {
      type: 'mcp_tool_result',
      tool_use_id: 'mcp_001',
      content,
      is_error: isError,
    } as ContentBlockEntry['block'],
    finalized: true,
    partial: false,
  }
}

describe('McpToolBlockView', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({
      toolEventsBySessionId: {},
    })
    useChatStore.setState({ messagesBySessionId: {} })
    __resetMessageBlocks()
  })

  it('happy: mcp_tool_use renders with MCP server badge', () => {
    render(<McpToolBlockView entry={makeMcpUse('search', 'google-mcp')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-mcp-tool-use')).toBeTruthy()
    expect(screen.getByText('blockTimeline.mcp.toolUse')).toBeTruthy()
    expect(screen.queryByText('search')).toBeNull()
    expect(screen.getByText('google-mcp')).toBeTruthy()
  })

  it('happy: click expands to show input JSON', () => {
    render(<McpToolBlockView entry={makeMcpUse()} sessionId="s1" messageId="m1" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/"key"/)).toBeTruthy()
  })

  it('mcp_tool_result success: 不独立渲染，避免和 MCP 调用卡重复', () => {
    const { container } = render(<McpToolBlockView entry={makeMcpResult('search output')} sessionId="s1" messageId="m1" />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('block-mcp-tool-result')).toBeNull()
  })

  it('mcp_tool_result error: 不独立渲染，避免和 MCP 调用卡重复', () => {
    const { container } = render(<McpToolBlockView entry={makeMcpResult('MCP server error', true)} sessionId="s1" messageId="m1" />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('block-mcp-tool-result-error')).toBeNull()
  })

  it('mcp_tool_use: sibling result 显示在同一张 MCP 调用卡内', () => {
    render(
      <McpToolBlockView
        entry={makeMcpUse()}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{ content: 'search output' }}
      />,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('block-mcp-tool-use')).toBeTruthy()
    expect(screen.getByText('blockTimeline.mcp.result')).toBeTruthy()
    expect(screen.getByText('search output')).toBeTruthy()
  })

  it('mcp_tool_use: sibling error result 自动展开并显示在调用卡内', () => {
    render(
      <McpToolBlockView
        entry={makeMcpUse()}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{ content: 'MCP server error', isError: true }}
      />,
    )

    expect(screen.getByTestId('block-mcp-tool-use')).toBeTruthy()
    expect(screen.getByText('blockTimeline.mcp.resultError')).toBeTruthy()
    expect(screen.getByText('MCP server error')).toBeTruthy()
    expect(screen.queryByTestId('block-mcp-tool-result-error')).toBeNull()
  })

  it('mcp_tool_use: 跨 message mcp_tool_result 显示在同一张 MCP 调用卡内', () => {
    seedShell('s1', 'mcp-result-message')
    commitBlocks('s1', 'mcp-result-message', [{
      index: 0,
      block_id: 'mcp-res-1',
      block: {
        type: 'mcp_tool_result',
        tool_use_id: 'mcp_001',
        content: 'MCP store error',
        is_error: true,
      } as ContentBlockEntry['block'],
      finalized: true,
      partial: false,
    }])

    render(<McpToolBlockView entry={makeMcpUse()} sessionId="s1" messageId="mcp-use-message" />)

    expect(screen.getByTestId('block-mcp-tool-use')).toBeTruthy()
    expect(screen.getByText('blockTimeline.mcp.resultError')).toBeTruthy()
    expect(screen.getByText('MCP store error')).toBeTruthy()
  })

  it('fallback: unknown block type returns null gracefully', () => {
    const entry: ContentBlockEntry = {
      index: 0,
      block_id: 'x',
      block: { type: 'mcp_unknown' } as ContentBlockEntry['block'],
      finalized: true,
      partial: false,
    }
    const { container } = render(<McpToolBlockView entry={entry} sessionId="s1" messageId="m1" />)
    expect(container.children.length).toBe(0)
  })
})
