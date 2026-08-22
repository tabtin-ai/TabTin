import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatInputModelBar } from '../ChatInputModelBar'
import type { Model } from '@tabtin/chat-client'

vi.mock('../../model/CompactModelSelector', () => ({
  CompactModelSelector: ({ currentModel, disabled }: { currentModel?: Model | null; disabled?: boolean }) => (
    <button type="button" disabled={disabled}>{currentModel?.display_name ?? '模型'}</button>
  ),
}))

vi.mock('../../panel/ChatIconTooltip', async () => {
  const React = await import('react')
  return {
    ChatIconTooltip: ({
      content,
      children,
    }: {
      content: React.ReactNode
      children: React.ReactNode
    }) => {
      const [open, setOpen] = React.useState(false)
      return (
        <span onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
          {children}
          {open ? <span role="tooltip">{content}</span> : null}
        </span>
      )
    },
  }
})

describe('ChatInputModelBar runtime controls', () => {
  it('思考强度迁入模型右栏后，底栏不再显示思考类芯片', () => {
    const model = {
      id: 'doubao-lite',
      model_name: 'doubao-seed-2-0-lite-260428',
      display_name: 'Doubao Seed 2.0 Lite',
      provider: 'volcengine',
      runtime_controls: [
        {
          key: 'reasoning_effort',
          label: '思考强度',
          description: '官方说明：reasoning_effort 用于调节思维链长度。',
          kind: 'select',
          param_path: 'reasoning_effort',
          default_value: null,
          visibility: 'model_menu',
          options: [
            { value: null, label: '默认', description: '使用模型或服务默认设置。' },
            { value: 'low', label: '低', description: '轻量思考，侧重快速响应。' },
          ],
        },
        {
          key: 'verbosity',
          label: '详细程度',
          kind: 'select',
          visibility: 'model_menu',
          options: [{ value: 'fast', label: '简洁' }],
        },
      ],
    } as unknown as Model

    render(
      <ChatInputModelBar
        models={[model]}
        currentModel={model}
        currentModelParamOverrides={null}
        showExecutionSpaceIndicator={false}
      />,
    )

    expect(screen.queryByText('思考强度')).toBeNull()
    expect(screen.getByText('详细程度')).toBeTruthy()
  })

  it('non-thinking runtime controls still use param_path for updates', async () => {
    const onModelChange = vi.fn()
    const model = {
      id: 'nested-reasoner',
      model_name: 'nested-reasoner',
      display_name: 'Nested Reasoner',
      provider: 'test',
      runtime_controls: [
        {
          key: 'verbosity',
          label: '详细程度',
          kind: 'select',
          param_path: 'output.verbosity',
          default_value: 'normal',
          visibility: 'model_menu',
          options: [
            { value: 'normal', label: '标准' },
            { value: 'fast', label: '简洁' },
          ],
        },
      ],
    } as unknown as Model

    render(
      <ChatInputModelBar
        models={[model]}
        currentModel={model}
        currentModelParamOverrides={{ 'output.verbosity': 'normal' }}
        onModelChange={onModelChange}
        showExecutionSpaceIndicator={false}
      />,
    )

    expect(screen.getByText('标准')).toBeTruthy()
    fireEvent.click(screen.getByText('详细程度'))
    fireEvent.click(screen.getByText('简洁'))

    expect(onModelChange).toHaveBeenCalledWith(
      model.id,
      undefined,
      { key: 'output.verbosity', value: 'fast' },
    )
  })

  it('共享会话只读展示当前模型，同时隐藏切换入口及运行参数', () => {
    const model = {
      id: 'shared-model',
      model_name: 'shared-model',
      display_name: 'Shared Model',
      provider: 'test',
      runtime_controls: [{
        key: 'verbosity',
        label: '详细程度',
        kind: 'select',
        visibility: 'model_menu',
        options: [{ value: 'normal', label: '标准' }],
      }],
    } as unknown as Model

    render(
      <ChatInputModelBar
        models={[model]}
        currentModel={model}
        canChangeModel={false}
        readOnlyModelName="Shared Model"
        disabled={false}
        showExecutionSpaceIndicator={false}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Shared Model' })).toBeNull()
    expect(screen.getByText('Shared Model')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /详细程度/ })).toBeNull()
  })

  it('shows non-thinking control descriptions on hover', async () => {
    const model = {
      id: 'verbose-model',
      model_name: 'verbose-model',
      display_name: 'Verbose Model',
      provider: 'test',
      runtime_controls: [
        {
          key: 'verbosity',
          label: '详细程度',
          description: '控制回答详细程度。',
          kind: 'select',
          visibility: 'model_menu',
          options: [
            { value: 'fast', label: '简洁', description: '更短的回答。' },
          ],
        },
      ],
    } as unknown as Model

    render(
      <ChatInputModelBar
        models={[model]}
        currentModel={model}
        currentModelParamOverrides={null}
        showExecutionSpaceIndicator={false}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('详细程度').parentElement!)
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('控制回答详细程度')
    })
  })
})
