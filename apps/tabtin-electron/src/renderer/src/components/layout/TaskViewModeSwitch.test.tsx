import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setTaskViewModeForScope = vi.fn()

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: object) => unknown) => selector({
    getTaskViewMode: () => 'app-focus',
    setTaskViewModeForScope,
  }),
}))

import { TaskViewModeSwitch } from './TaskViewModeSwitch'

describe('TaskViewModeSwitch', () => {
  beforeEach(() => {
    setTaskViewModeForScope.mockClear()
  })

  it('无画布标签时三个模式按钮仍可点击', async () => {
    render(<TaskViewModeSwitch scopeKey="conversation:s1" activeMode="chat-focus" />)
    const appFocusBtn = screen.getByRole('button', { name: '应用聚焦' })
    expect((appFocusBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(appFocusBtn)
    expect(setTaskViewModeForScope).toHaveBeenCalledWith('conversation:s1', 'app-focus')
  })

  it('两端模式图标与实际布局位置一致', () => {
    render(<TaskViewModeSwitch scopeKey="conversation:s1" activeMode="chat-focus" />)

    const chatFocusIcon = screen.getByRole('button', { name: '对话聚焦' }).querySelector('svg')
    const appFocusIcon = screen.getByRole('button', { name: '应用聚焦' }).querySelector('svg')

    expect(chatFocusIcon?.classList.contains('lucide-panel-right')).toBe(true)
    expect(appFocusIcon?.classList.contains('lucide-panel-left')).toBe(true)
  })
})
