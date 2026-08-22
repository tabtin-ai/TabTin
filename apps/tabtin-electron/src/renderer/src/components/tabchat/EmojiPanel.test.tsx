import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

describe('EmojiPanel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps the reaction picker compact by default', async () => {
    const { EmojiPanel } = await import('./EmojiPanel')
    render(<EmojiPanel onPick={vi.fn()} />)

    expect(screen.queryByText('最近使用')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(32)
  })

  it('shows full sections and remembers the latest picked emoji', async () => {
    const onPick = vi.fn()
    const { EmojiPanel } = await import('./EmojiPanel')
    render(<EmojiPanel variant="full" onPick={onPick} onPickSticker={vi.fn()} />)

    expect(screen.getByText('最近使用')).toBeTruthy()
    expect(screen.getByText('默认表情')).toBeTruthy()
    expect(screen.queryByLabelText('TabTin')).toBeNull()
    expect(screen.queryByTestId('emoji-tab-tabtin')).toBeNull()
    expect(screen.queryByTestId('emoji-tabtin-section')).toBeNull()

    fireEvent.click(screen.getAllByLabelText('👍')[0])

    expect(onPick).toHaveBeenCalledWith('👍')
    expect(JSON.parse(localStorage.getItem('tabtin.im.recent-emojis') ?? '[]')[0]).toBe('👍')
  })

})
