import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  applyPromptToNewTask: vi.fn(() => ({ ok: true, spaceId: 'workspace-b' })),
}))

vi.mock('@/services/promptApply', () => ({
  applyPromptToNewTask: mocks.applyPromptToNewTask,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('./IMMessageBubble', () => ({
  markdownComponents: {},
}))

vi.mock('@components/sidebar/SpaceSwitcherPopover', () => ({
  SpaceSwitcherPopover: ({
    children,
    onSelectSpace,
  }: {
    children: React.ReactNode
    onSelectSpace: (space: { source_id: string }) => void
  }) => (
    <div>
      {children}
      <button
        type="button"
        onClick={() => onSelectSpace({ source_id: 'workspace-b' })}
      >
        选择 Workspace B
      </button>
    </div>
  ),
}))

describe('PromptCard', () => {
  beforeEach(() => {
    mocks.applyPromptToNewTask.mockClear()
  })

  it('点击使用时先选择 Workspace，选择后才应用指令', async () => {
    const { PromptCard } = await import('./PromptCard')
    render(<PromptCard promptText="检查发布回归" />)

    fireEvent.click(screen.getByRole('button', { name: '使用此指令' }))
    expect(mocks.applyPromptToNewTask).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '选择 Workspace B' }))
    expect(mocks.applyPromptToNewTask).toHaveBeenCalledWith(
      '检查发布回归',
      'workspace-b',
    )
  })
})
