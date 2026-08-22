import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const spaceState = vi.hoisted(() => ({
  agentCache: {} as Record<string, { id: string; name?: string; display_name?: string }>,
  selectedAgent: null as { id: string; name: string } | null,
  loadAgent: vi.fn(),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (s: typeof spaceState) => unknown) => selector(spaceState),
}))

vi.mock('../messages/common/', () => ({
  AgentAvatar: ({ name, className, avatarUrl }: { name: string; className?: string; avatarUrl?: string }) => (
    <span data-testid="agent-avatar" data-avatar-url={avatarUrl} className={className}>{name}</span>
  ),
}))

import { TurnAgentBadge } from '../messages/assistant/TurnAgentBadge'

describe('TurnAgentBadge · ', () => {
  beforeEach(() => {
    spaceState.agentCache = {}
    spaceState.selectedAgent = null
    spaceState.loadAgent.mockReset()
  })

  it('cache 未命中时用同 id selectedAgent 真名，不渲染 UUID 短码', () => {
    spaceState.selectedAgent = { id: 'agent-test', name: 'test' }
    render(<TurnAgentBadge agentId="agent-test" />)
    expect(screen.getByTestId('turn-agent-badge').textContent).toContain('test')
    expect(screen.getByTestId('turn-agent-badge').textContent).not.toContain('agent-te')
  })

  it('无真名时不渲染占位徽章', () => {
    const { container } = render(<TurnAgentBadge agentId="agent-missing" />)
    expect(container.querySelector('[data-testid="turn-agent-badge"]')).toBeNull()
  })

  it('外部历史可用来源名覆盖展示名', () => {
    spaceState.selectedAgent = { id: 'agent-test', name: '小Tin' }
    render(
      <TurnAgentBadge
        agentId="agent-test"
        displayNameOverride="Codex"
        avatarIdOverride="external:codex"
      />,
    )
    expect(screen.getByTestId('turn-agent-badge').textContent).toContain('Codex')
    expect(screen.getByTestId('turn-agent-badge').textContent).not.toContain('小Tin')
  })

  it('共享消息可用安全身份快照渲染 owner Agent', () => {
    render(
      <TurnAgentBadge
        agentId="private-owner-agent"
        displayNameOverride="Owner Agent"
        avatarUrlOverride="https://cdn.example.com/owner-agent.png"
      />,
    )
    expect(screen.getByTestId('turn-agent-badge').textContent).toContain('Owner Agent')
    expect(screen.getByTestId('agent-avatar').getAttribute('src'))
      .toBe('https://cdn.example.com/owner-agent.png')
  })

  it('消息流身份牌用 32px 头像 + 对话正文字号 15px', () => {
    spaceState.selectedAgent = { id: 'agent-test', name: '小Tin' }
    render(<TurnAgentBadge agentId="agent-test" />)
    const badge = screen.getByTestId('turn-agent-badge')
    const avatar = screen.getByTestId('agent-avatar')
    expect(avatar.className).toMatch(/!h-8|h-8/)
    expect(avatar.className).toMatch(/!w-8|w-8/)
    const nameEl = badge.querySelector('span.truncate')
    // eslint-disable-next-line tabtin/no-chat-design-violations, tabtin/no-design-system-violations -- 断言兼容既有 15px 回归点，字面量不是新增样式。
    expect(nameEl?.className).toContain('text-[15px]')
  })
})
