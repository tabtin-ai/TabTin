import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmojiQuickPicker, EmojiReactionBar } from './EmojiReactionBar'

const mocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  onReactionUpdated: vi.fn(),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'current-user' } }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: { getState: () => ({ onReactionUpdated: mocks.onReactionUpdated }) },
}))

vi.mock('@/services/tabchatApi', () => ({
  addReaction: mocks.addReaction,
  removeReaction: mocks.removeReaction,
}))

vi.mock('./EmojiPanel', () => ({
  EmojiPanel: ({ onPick }: { onPick: (emoji: string) => void }) => (
    <button type="button" onClick={() => onPick('✨')}>pick sparkle</button>
  ),
}))

describe('EmojiReactionBar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('显示原生 Reaction 返回的精确总人数', () => {
    render(
      <EmojiReactionBar
        reactions={{ party: ['user-1', 'user-2'] }}
        reactionCounts={{ party: 12 }}
        messageRef="message-ref-1"
        conversationId="conversation-1"
      />,
    )

    expect(screen.getByRole('button').textContent).toContain('12')
  })

  it('快速面板再次选择自己已有的 Reaction 时取消回应', async () => {
    render(
      <EmojiQuickPicker
        reactions={{ '✨': ['current-user'] }}
        messageRef="message-ref-1"
        conversationId="conversation-1"
        anchorRef={{ current: document.createElement('div') }}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'pick sparkle' }))

    await waitFor(() => expect(mocks.removeReaction).toHaveBeenCalledWith(
      'conversation-1',
      'message-ref-1',
      '✨',
      undefined,
    ))
    expect(mocks.addReaction).not.toHaveBeenCalled()
  })
})
