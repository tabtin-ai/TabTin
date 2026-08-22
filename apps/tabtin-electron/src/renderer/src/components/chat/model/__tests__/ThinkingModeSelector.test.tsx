import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThinkingModeSelector } from '../ThinkingModeSelector'
import type { Model } from '@tabtin/chat-client'

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

function model(thinking: NonNullable<Model['runtime_profile']>['thinking']): Model {
  return {
    id: 'm1',
    name: 'm1',
    display_name: 'M1',
    provider: 'moonshot',
    provider_display_name: 'Kimi',
    description: '',
    max_tokens: 1,
    supports_streaming: true,
    supports_vision: false,
    cost_per_1k_tokens: 0,
    is_default: false,
    runtime_profile: { thinking },
  } as Model
}

describe('ThinkingModeSelector (Kimi binary / always-on)', () => {
  it('k2.5/k2.6: 关闭/开启，无深度档', () => {
    render(
      <ThinkingModeSelector
        model={model({
          supported: true,
          modes: ['off', 'standard'],
          default_mode: 'standard',
        })}
        onThinkingModeChange={vi.fn()}
      />,
    )
    expect(screen.getByText('思考')).toBeTruthy()
    expect(screen.getByText('关闭')).toBeTruthy()
    expect(screen.getByText('开启')).toBeTruthy()
    expect(screen.queryByText('深度')).toBeNull()
    expect(screen.queryByText('思考深度')).toBeNull()
    expect(
      screen.getByTestId('model-settings-thinking')
        .querySelector('[data-thinking-mode="deep"]'),
    ).toBeNull()
  })

  it('k2.7-code: 只读始终开启，无关闭按钮', () => {
    render(
      <ThinkingModeSelector
        model={model({
          supported: true,
          modes: [],
          default_mode: 'standard',
          always_on: true,
        })}
        onThinkingModeChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('thinking-always-on').textContent).toContain('始终开启')
    expect(screen.queryByTestId('model-settings-thinking')).toBeNull()
    expect(screen.queryByText('关闭')).toBeNull()
  })
})
