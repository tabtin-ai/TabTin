import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TeamSpaceCreateTaskDialog } from './TeamSpaceCreateTaskDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, opts?: Record<string, string>) => opts?.defaultValue ?? _key }),
}))

describe('TeamSpaceCreateTaskDialog', () => {
  it('提交时 trim 用户显式补充的上下文', () => {
    const onConfirm = vi.fn()

    render(
      <TeamSpaceCreateTaskDialog
        isOpen
        isSubmitting={false}
        sourcePreview="源消息内容"
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText(/希望 Agent 优先验证/), {
      target: { value: '  请补充检查风险  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送并打开' }))

    expect(onConfirm).toHaveBeenCalledWith('请补充检查风险')
  })

  it('取消时关闭弹窗', () => {
    const onClose = vi.fn()

    render(
      <TeamSpaceCreateTaskDialog
        isOpen
        isSubmitting={false}
        sourcePreview="源消息内容"
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('提交中禁用输入和按钮，避免重复创建', () => {
    render(
      <TeamSpaceCreateTaskDialog
        isOpen
        isSubmitting
        sourcePreview="源消息内容"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect((screen.getByPlaceholderText(/希望 Agent 优先验证/) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /发送并打开/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
