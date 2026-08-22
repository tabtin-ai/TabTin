import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppOpenDraftWelcome } from '../AppOpenDraftWelcome'

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

describe('AppOpenDraftWelcome', () => {
  it('保留已打开 App 的标题和说明，但不展示预置推荐列表', () => {
    const { container } = render(
      <AppOpenDraftWelcome
        title="应用已经打开"
        hint="可以先查看或编辑右侧内容，然后在输入框说明要做的事。"
      />,
    )

    expect(screen.getByRole('heading', { name: '应用已经打开' })).toBeTruthy()
    expect(screen.getByText('可以先查看或编辑右侧内容，然后在输入框说明要做的事。')).toBeTruthy()
    expect(screen.queryByTestId('welcome-suggestion-bar')).toBeNull()
    expect(container.firstChild).toHaveClass('pointer-events-none')
  })
})
