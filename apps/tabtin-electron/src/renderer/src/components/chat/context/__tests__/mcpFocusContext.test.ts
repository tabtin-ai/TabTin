import { describe, expect, it } from 'vitest'

import { renderRemoteMcpFocusContext } from '../mcpFocusContext'

describe('renderRemoteMcpFocusContext', () => {
  it('远程执行把 MCP focus 放入单轮 referenced wrapper', () => {
    const result = renderRemoteMcpFocusContext([
      { type: 'mcp_server', connection_id: 'conn-1', server_name: 'github' },
    ], 'message-1')

    expect(result).toContain('<context type="referenced" stale_after_turn="message-1">')
    expect(result).toContain('server_name="github"')
    expect(result).toContain('其他已启用 MCP 仍然可用')
  })

  it('没有 MCP focus 时不生成 wrapper', () => {
    expect(renderRemoteMcpFocusContext([], 'message-1')).toBe('')
  })
})
