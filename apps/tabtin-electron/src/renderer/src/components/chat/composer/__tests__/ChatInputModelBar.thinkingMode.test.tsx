import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatInputModelBar } from '../ChatInputModelBar'
import type { Model } from '@tabtin/chat-client'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('../../model/CompactModelSelector', () => ({
  CompactModelSelector: ({
    currentModel,
    currentModelParamOverrides,
  }: {
    currentModel?: Model | null
    currentModelParamOverrides?: Record<string, unknown> | null
  }) => (
    <div data-testid="compact-model-selector">
      <span>{currentModel?.display_name ?? '模型'}</span>
      <span data-testid="selector-thinking-intent">
        {String(currentModelParamOverrides?.thinking_mode ?? '')}
      </span>
    </div>
  ),
}))

vi.mock('../../panel/ChatIconTooltip', async () => {
  const React = await import('react')
  return {
    ChatIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

function supportedModel(overrides?: Partial<Model>): Model {
  return {
    id: 'supported-1',
    name: 'gpt-think',
    model_name: 'gpt-think',
    display_name: 'Think Model',
    provider: 'test',
    provider_display_name: 'Test',
    description: '',
    max_tokens: 1,
    supports_streaming: true,
    supports_vision: false,
    cost_per_1k_tokens: 0,
    is_default: false,
    runtime_profile: {
      thinking: {
        supported: true,
        modes: ['off', 'standard', 'deep'],
        default_mode: 'standard',
      },
    },
    runtime_controls: [
      {
        key: 'reasoning_effort',
        label: '思考强度',
        kind: 'select',
        param_path: 'reasoning_effort',
        options: [
          { value: 'high', label: '高' },
          { value: 'medium', label: '中' },
        ],
      },
      {
        key: 'verbosity',
        label: '详细程度',
        kind: 'select',
        options: [{ value: 'fast', label: '简洁' }],
      },
    ],
    ...overrides,
  } as Model
}

describe('ChatInputModelBar model settings wiring', () => {
  it('does not render standalone Thinking chip on the bar', () => {
    render(
      <ChatInputModelBar
        models={[supportedModel()]}
        currentModel={supportedModel()}
        currentModelParamOverrides={{ v: 2, thinking_mode: 'deep' }}
        showExecutionSpaceIndicator={false}
      />,
    )
    expect(screen.queryByTestId('thinking-mode-chip')).toBeNull()
    expect(screen.getByTestId('compact-model-selector')).toBeTruthy()
    expect(screen.getByTestId('selector-thinking-intent').textContent).toBe('deep')
  })

  it('hides thinking runtime_controls when runtime_profile.thinking exists', () => {
    render(
      <ChatInputModelBar
        models={[supportedModel()]}
        currentModel={supportedModel()}
        currentModelParamOverrides={null}
        showExecutionSpaceIndicator={false}
      />,
    )
    expect(screen.queryByText('思考强度')).toBeNull()
    expect(screen.queryByText('high')).toBeNull()
    expect(screen.getByText('详细程度')).toBeTruthy()
  })

  it('switch model keeps thinking_mode intent on selector props', () => {
    const intent = { v: 2 as const, thinking_mode: 'deep' as const }
    const supported = supportedModel({ id: 'a', display_name: 'A' })
    const unsupported = supportedModel({
      id: 'b',
      display_name: 'B',
      runtime_profile: {
        thinking: { supported: false, modes: [], default_mode: 'standard' },
      },
      runtime_controls: [],
    })

    const { rerender } = render(
      <ChatInputModelBar
        models={[supported, unsupported]}
        currentModel={supported}
        currentModelParamOverrides={intent}
        showExecutionSpaceIndicator={false}
      />,
    )
    expect(screen.getByTestId('selector-thinking-intent').textContent).toBe('deep')

    rerender(
      <ChatInputModelBar
        models={[supported, unsupported]}
        currentModel={unsupported}
        currentModelParamOverrides={intent}
        showExecutionSpaceIndicator={false}
      />,
    )
    expect(screen.getByTestId('selector-thinking-intent').textContent).toBe('deep')
    expect(screen.queryByTestId('thinking-mode-chip')).toBeNull()
  })
})
