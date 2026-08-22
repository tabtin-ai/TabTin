import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageActions } from '../messages/common/MessageActions'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: vi.fn(),
}))

vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('MessageActions', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  it('#1218 复制按钮优先写入 copyContent，而不是展示用摘要 content', async () => {
    render(
      <MessageActions
        content={'a'.repeat(200)}
        copyContent={`第一部分\n${'b'.repeat(500)}\n整体结论`}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`第一部分\n${'b'.repeat(500)}\n整体结论`)
    })
  })

  it('#2522 助手消息工具栏展示重新生成按钮并触发回调', () => {
    const onRegenerate = vi.fn()

    render(
      <MessageActions
        content="[工具调用]"
        isUser={false}
        onRegenerate={onRegenerate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))

    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('回退与撤销 AI 操作按钮使用差异化 tooltip', () => {
    render(
      <MessageActions
        content="assistant reply"
        isUser={false}
        showRollback
        onRollback={vi.fn()}
        showAgentRunRollback
        onAgentRunRollback={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', {
        name: '回退对话到此处：移除之后的消息，并恢复工作区文件与资源',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: '撤销本轮 AI 对文档、表格等资源的改动（对话消息不受影响）',
      }),
    ).toBeTruthy()
  })

  it('无复制能力时不渲染复制按钮', () => {
    render(<MessageActions content="shared reply" showCopy={false} />)

    expect(screen.queryByRole('button', { name: 'common.copy' })).toBeNull()
  })

  it('共享整会话 fork 使用复制到我的任务语义', () => {
    render(
      <MessageActions
        content="shared reply"
        onFork={vi.fn()}
        forkWholeSession
      />,
    )

    expect(screen.getByRole('button', { name: '复制到我的任务' })).toBeTruthy()
  })
})
