import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsNameConfirmDialog } from '../SettingsNameConfirmDialog'

type MockButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
}

vi.mock('@components/ui', () => ({
  Button: ({ children, type = 'button', variant: _variant, ...props }: MockButtonProps) => (
    <button type={type} {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('../settingsUi', () => ({
  SETTINGS_CONTROL: 'settings-control',
  SETTINGS_CONTROL_SM: 'settings-control-sm',
}))

describe('SettingsNameConfirmDialog', () => {
  const onConfirm = vi.fn(async () => {})
  const onInputChange = vi.fn()
  const onOpenChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderDialog(overrides: Partial<React.ComponentProps<typeof SettingsNameConfirmDialog>> = {}) {
    return render(
      <SettingsNameConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="确认删除 Space?"
        subtitle="此操作不可恢复"
        items={['只删除 Space 记录']}
        warning="请谨慎操作"
        inputLabel="请输入 Space 名称"
        inputPlaceholder="2"
        inputValue="2"
        onInputChange={onInputChange}
        expectedValue="2"
        confirmText="确认删除"
        cancelText="取消"
        onConfirm={onConfirm}
        {...overrides}
      />,
    )
  }

  it('名称匹配时即使父级 isLoading 为 true 也允许点击确认', async () => {
    renderDialog({ isLoading: true })

    const confirmButton = screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false)

    fireEvent.click(confirmButton)
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
  })

  it('名称不匹配时禁用确认按钮', () => {
    renderDialog({ inputValue: 'wrong' })

    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('忽略输入首尾空格进行名称匹配', () => {
    renderDialog({ inputValue: ' 2 ' })

    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
