import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerWelcomeMascot } from '../ComposerWelcomeMascot'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ComposerWelcomeMascot', () => {
  it('点击后回弹、显示星光并聚焦输入框，冷却后才重播', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    render(
      <div className="chat-composer-backplate">
        <ComposerWelcomeMascot />
        <textarea aria-label="任务" />
      </div>,
    )

    const button = screen.getByRole('button', { name: 'input.mascotGreetingAction' })
    expect(button.querySelectorAll('img')).toHaveLength(1)

    fireEvent.click(button)
    const firstSparkles = button.querySelector('.composer-mascot-sparkles')
    expect(firstSparkles).not.toBeNull()
    expect(button.querySelector('.composer-mascot--tap-reaction')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '任务' }))

    now.mockReturnValue(1_200)
    fireEvent.click(button)
    expect(button.querySelector('.composer-mascot-sparkles')).toBe(firstSparkles)

    now.mockReturnValue(1_500)
    fireEvent.click(button)
    expect(button.querySelector('.composer-mascot-sparkles')).not.toBe(firstSparkles)
  })
})
