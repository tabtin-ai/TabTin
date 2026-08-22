import { buildUserContextWrapper } from '@tabtin/agent-runtime/engine/user-context-wrapper'

export function isMcpFocusBlock(block: Record<string, unknown>): boolean {
  return block.type === 'mcp_server'
    && typeof block.connection_id === 'string'
    && block.connection_id.trim().length > 0
}

/**
 * MCP focus 是单条消息的软偏好，不是运行时白名单。
 * 文案在本地确定性生成，Electron 本地执行和远程转发复用同一实现。
 */
export function renderMcpFocusContext(blocks: Array<Record<string, unknown>>): string {
  const focused = blocks.filter(isMcpFocusBlock)
  if (focused.length === 0) return ''

  const lines = focused.map((block) => {
    const connectionId = (block.connection_id as string).trim()
    const serverName = typeof block.server_name === 'string' && block.server_name.trim()
      ? block.server_name.trim()
      : connectionId
    return `- server_name=${JSON.stringify(serverName)}, connection_id=${JSON.stringify(connectionId)}`
  })

  return [
    '## 本轮 MCP focus',
    ...lines,
    '用户为本轮明确选择了以上 MCP server 作为重点能力。',
    '优先使用其中与任务相关的 MCP tool；其他已启用 MCP 仍然可用，不要把 focus 当作硬白名单。',
  ].join('\n')
}

export function renderRemoteMcpFocusContext(
  blocks: Array<Record<string, unknown>>,
  staleAfterTurn: string,
): string {
  const context = renderMcpFocusContext(blocks)
  return context
    ? buildUserContextWrapper('referenced', context, { stale_after_turn: staleAfterTurn })
    : ''
}
