import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationCard } from './ConversationCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'conversations.sharedFrom') {
        return `来自 ${opts?.name as string}`
      }
      if (key === 'conversations.untitledSession') {
        return `${opts?.agent as string} 的对话`
      }
      return key
    },
  }),
}))

const baseSession = {
  id: 'session-1',
  title: '新对话',
  status: 'active',
  organization_id: 'organization-1',
  space_id: 'space-1',
  created_at: '2026-03-26T09:00:00.000Z',
  updated_at: '2026-03-27T09:00:00.000Z',
  last_message_at: '2026-03-27T09:00:00.000Z',
  last_message_preview: '这是最后一条消息摘要',
  agent_id: 'agent-1',
  agent_name: '小豆子',
  agent_type: 'bot',
}

describe('ConversationCard', () => {
  it('单 Agent 场景隐藏头像和 Agent 元信息，仅保留标题', () => {
    render(
      <ConversationCard
        session={baseSession}
        isSelected={false}
        onSelect={vi.fn()}
        showAgentMeta={false}
      />,
    )

    expect(screen.getByText('新对话')).toBeTruthy()
    expect(screen.queryByText('这是最后一条消息摘要')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('小豆子')).toBeNull()
    expect(screen.queryByText('bot')).toBeNull()
  })

  it('多 Agent 场景点击 Agent 名称会触发筛选，不会误触发选中', () => {
    const onSelect = vi.fn()
    const onAgentClick = vi.fn()

    render(
      <ConversationCard
        session={baseSession}
        isSelected={false}
        onSelect={onSelect}
        onAgentClick={onAgentClick}
        showAgentMeta
      />,
    )

    fireEvent.click(screen.getByText('小豆子'))

    expect(onAgentClick).toHaveBeenCalledWith('agent-1')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
