import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewDraftActions } from './ViewDraftActions'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, children),
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', { role: 'tooltip' }, children),
  TooltipProvider: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
}), { virtual: true })

const translate = (key: string) => ({
  'view:actions.clear': '清除',
  'view:actions.cancel': '取消',
  'view:actions.save': '保存',
  'view:actions.saveAs': '另存为视图',
}[key] ?? key)

const renderActions = (
  overrides: Partial<React.ComponentProps<typeof ViewDraftActions>> = {},
) => {
  const props: React.ComponentProps<typeof ViewDraftActions> = {
    onClear: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    canClear: true,
    canCancel: true,
    canSave: false,
    canSaveAs: true,
    saveDisabledReason: '当前处于个人视图，无法保存到共享视图。',
    translate,
    ...overrides,
  }
  render(React.createElement(ViewDraftActions, props))
  return props
}

describe('ViewDraftActions', () => {
  it('为禁用的保存按钮提供悬停和键盘可达的原因', () => {
    renderActions()

    const saveButton = screen.getByRole('button', { name: '保存' })
    expect(saveButton).toHaveProperty('disabled', true)

    const reasonTrigger = saveButton.parentElement
    expect(reasonTrigger?.getAttribute('tabindex')).toBe('0')
    expect(reasonTrigger?.getAttribute('title')).toBeNull()
    expect(reasonTrigger?.getAttribute('aria-label')).toBe(
      '保存: 当前处于个人视图，无法保存到共享视图。',
    )
    expect(screen.getByRole('tooltip').textContent).toBe(
      '当前处于个人视图，无法保存到共享视图。',
    )
  })

  it('保存可用时不包裹禁用原因，并正常触发保存', () => {
    const props = renderActions({ canSave: true, saveDisabledReason: null })
    const saveButton = screen.getByRole('button', { name: '保存' })

    expect(saveButton).toHaveProperty('disabled', false)
    expect(saveButton.parentElement?.getAttribute('title')).toBeNull()
    fireEvent.click(saveButton)
    expect(props.onSave).toHaveBeenCalledTimes(1)
  })
})
