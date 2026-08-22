/**
 * AgentAvatar — 生成要素确定性 + 组件展示（logo / 自定义图）。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { getAgentIdentityAvatar, AgentAvatar } from '../messages/common/AgentAvatar'
import { AGENT_IDENTITY_PALETTE, AGENT_AVATAR_20 } from '../../registry/chatDesignTokens'
import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'

describe('getAgentIdentityAvatar', () => {
  it('同 id 多次调用颜色稳定（哈希确定性，与 name 无关）', () => {
    const a = getAgentIdentityAvatar('agent-uuid-1', '小钛')
    const b = getAgentIdentityAvatar('agent-uuid-1', '改名后的小钛')
    const c = getAgentIdentityAvatar('agent-uuid-1', '小钛')
    expect(a.palette).toBe(b.palette)
    expect(a.palette).toBe(c.palette)
  })

  it('不同 id 可以命中不同色板项（哈希分布）', () => {
    const hits = new Set<string>()
    for (let i = 0; i < 64; i++) {
      hits.add(getAgentIdentityAvatar(`agent-${i}`).palette.name)
    }
    expect(hits.size).toBeGreaterThan(1)
  })

  it('中文名取首字', () => {
    expect(getAgentIdentityAvatar('id-1', '查令').initial).toBe('查')
    expect(getAgentIdentityAvatar('id-2', '小钛').initial).toBe('小')
  })

  it('拉丁名取首字母并大写', () => {
    expect(getAgentIdentityAvatar('id-3', 'ada').initial).toBe('A')
    expect(getAgentIdentityAvatar('id-4', 'Merlin').initial).toBe('M')
  })

  it('id 缺失时退化用 name 做哈希，仍然稳定', () => {
    const a = getAgentIdentityAvatar(null, '表哥')
    const b = getAgentIdentityAvatar(undefined, '表哥')
    expect(a.palette).toBe(b.palette)
    expect(a.initial).toBe('表')
  })

  it('name 缺失时首字符退化用 id', () => {
    expect(getAgentIdentityAvatar('f4a2b8', null).initial).toBe('F')
  })

  it('id 与 name 都缺失时输出占位符且不抛错', () => {
    const result = getAgentIdentityAvatar(null, null)
    expect(result.initial).toBe('?')
    expect(AGENT_IDENTITY_PALETTE).toContain(result.palette)
  })

  it('8 色全覆盖：色板可被不同输入全部命中', () => {
    const hits = new Set<string>()
    for (let i = 0; i < 512 && hits.size < AGENT_IDENTITY_PALETTE.length; i++) {
      hits.add(getAgentIdentityAvatar(`probe-agent-${i}`).palette.name)
    }
    expect(hits.size).toBe(AGENT_IDENTITY_PALETTE.length)
  })

  it('色板恰好 8 色且每项含浅色 + 暗色 class', () => {
    expect(AGENT_IDENTITY_PALETTE).toHaveLength(8)
    for (const entry of AGENT_IDENTITY_PALETTE) {
      expect(entry.avatarClass).toMatch(/\bbg-\[#/)
      expect(entry.avatarClass).toMatch(/\bdark:bg-\[#/)
      expect(entry.avatarClass).toMatch(/\bdark:text-\[#/)
    }
  })
})

describe('AgentAvatar 组件', () => {
  it('无自定义头像时渲染 TabTin logo 图，并用 aria-label 暴露名字', () => {
    render(<AgentAvatar agentId="agent-1" name="查令" />)
    const avatar = screen.getByTestId('agent-avatar')
    expect(avatar.tagName).toBe('IMG')
    expect(avatar.getAttribute('src')).toBe(TABTIN_APP_ICON_URL)
    expect(avatar.getAttribute('aria-label')).toBe('查令')
    expect(avatar.getAttribute('role')).toBe('img')
    expect(avatar.className).toContain('h-5')
    expect(avatar.className).toContain('w-5')
    for (const token of AGENT_AVATAR_20.split(/\s+/)) {
      expect(avatar.className).toContain(token)
    }
  })

  it('关闭原生拖图，避免悬浮球等父级拖拽被 img 截胡', () => {
    render(<AgentAvatar agentId="agent-1" name="查令" />)
    const avatar = screen.getByTestId('agent-avatar') as HTMLImageElement
    expect(avatar.draggable).toBe(false)
    expect(avatar.className).toContain('[-webkit-user-drag:none]')
  })

  it('有自定义头像时优先展示自定义 URL', () => {
    render(
      <AgentAvatar
        agentId="agent-2"
        name="表哥"
        avatarUrl="https://cdn.example.com/agent.png"
      />,
    )
    const avatar = screen.getByTestId('agent-avatar')
    expect(avatar.getAttribute('src')).toBe('https://cdn.example.com/agent.png')
  })

  it('头像中性：class 里不携带状态色 token（不随运行状态变色）', () => {
    render(<AgentAvatar agentId="agent-2" name="表哥" />)
    const cls = screen.getByTestId('agent-avatar').className
    expect(cls).not.toMatch(/destructive|warning|success|animate/)
  })
})
