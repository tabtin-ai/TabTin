import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelRuntimeOptionsPanel } from '../ModelRuntimeOptionsPanel'
import type { Model } from '@tabtin/chat-client'

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

function modelWithThinking(overrides?: Partial<Model>): Model {
  return {
    id: 'm1',
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
    context_tiers: [
      {
        id: 'standard',
        label: '标准 272K',
        is_default: true,
        is_user_selectable: true,
        max_input_tokens: 272000,
        tags: [],
        has_extra_headers: false,
      },
      {
        id: 'long',
        label: '长文档 1M',
        is_default: false,
        is_user_selectable: true,
        max_input_tokens: 1000000,
        tags: [],
        has_extra_headers: true,
      },
    ],
    runtime_profile: {
      thinking: {
        supported: true,
        modes: ['off', 'standard', 'deep'],
        default_mode: 'standard',
      },
    },
    ...overrides,
  } as Model
}

/** 未来 Catalog 声明可执行 performance 时的 fixture（当前生产不下发）。 */
function modelWithPerformanceSupported(overrides?: Partial<Model>): Model {
  return modelWithThinking({
    runtime_profile: {
      thinking: {
        supported: true,
        modes: ['off', 'standard', 'deep'],
        default_mode: 'standard',
      },
      performance: { supported: true },
    } as Model['runtime_profile'],
    ...overrides,
  })
}

describe('ModelRuntimeOptionsPanel', () => {
  it('shows Thinking when runtime_profile.thinking is supported', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking()}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('thinking-mode-selector')).toBeTruthy()
    expect(screen.getByText('思考深度')).toBeTruthy()
    expect(screen.queryByText('reasoning_effort')).toBeNull()
  })

  it('hides PerformanceProfileSelector when performance.supported is missing', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking()}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('performance-profile-selector')).toBeNull()
    expect(screen.queryByText('响应策略')).toBeNull()
    expect(screen.queryByText('快速')).toBeNull()
  })

  it('hides PerformanceProfileSelector when performance.supported is false', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          runtime_profile: {
            thinking: {
              supported: true,
              modes: ['off', 'standard', 'deep'],
              default_mode: 'standard',
            },
            performance: { supported: false },
          } as Model['runtime_profile'],
        })}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('performance-profile-selector')).toBeNull()
  })

  it('shows PerformanceProfileSelector when performance.supported is true', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithPerformanceSupported()}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('performance-profile-selector')).toBeTruthy()
    expect(screen.getByText('响应策略')).toBeTruthy()
    expect(screen.queryByText('回答模式')).toBeNull()
    expect(screen.getByText('快速')).toBeTruthy()
    expect(screen.getByText('平衡')).toBeTruthy()
    expect(screen.getByText('质量优先')).toBeTruthy()
  })

  it('defaults performance highlight to balanced when supported', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithPerformanceSupported()}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    const balanced = screen.getByTestId('performance-profile-selector')
      .querySelector('[data-performance-profile="balanced"]')
    expect(balanced?.className).toMatch(/primary/)
  })

  it('clicking fast writes performance_profile only when supported', () => {
    const onPerformanceProfileChange = vi.fn()
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithPerformanceSupported()}
        currentModelParamOverrides={{ v: 2, thinking_mode: 'deep' }}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={onPerformanceProfileChange}
      />,
    )
    fireEvent.click(
      screen.getByTestId('performance-profile-selector')
        .querySelector('[data-performance-profile="fast"]')!,
    )
    expect(onPerformanceProfileChange).toHaveBeenCalledWith({
      key: 'performance_profile',
      value: 'fast',
    })
    expect(JSON.stringify(onPerformanceProfileChange.mock.calls[0][0]))
      .not.toMatch(/thinking_mode|response_mode|answer_mode|speed/)
  })

  it('writes thinking_mode without touching performance callback', () => {
    const onThinkingModeChange = vi.fn()
    const onPerformanceProfileChange = vi.fn()
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking()}
        currentModelParamOverrides={{ v: 2, thinking_mode: 'standard', performance_profile: 'fast' }}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={onThinkingModeChange}
        onPerformanceProfileChange={onPerformanceProfileChange}
      />,
    )
    fireEvent.click(
      screen.getByTestId('model-settings-thinking')
        .querySelector('[data-thinking-mode="deep"]')!,
    )
    expect(onThinkingModeChange).toHaveBeenCalledWith({
      key: 'thinking_mode',
      value: 'deep',
    })
    expect(onPerformanceProfileChange).not.toHaveBeenCalled()
  })

  it('shows context tiers with catalog labels', () => {
    const onSelectTier = vi.fn()
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking()}
        onSelectTier={onSelectTier}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByText('标准 272K')).toBeTruthy()
    fireEvent.click(screen.getByText('长文档 1M'))
    expect(onSelectTier).toHaveBeenCalledWith('long')
  })

  it('shows read-only context window when no selectable tiers', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          context_tiers: [],
          context_window_tokens: 1_048_576,
        })}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByText('上下文能力')).toBeTruthy()
    expect(screen.getByTestId('context-window-readonly').textContent).toBe('1M')
  })

  it('shows speed options under context for Codex and writes service_tier', () => {
    const onFastChange = vi.fn()
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          id: 'gpt-5.6-sol',
          name: 'gpt-5.6-sol',
          display_name: 'GPT-5.6 Sol',
          provider: 'openai-codex',
          context_tiers: [],
          context_window_tokens: 1_100_000,
          runtime_profile: undefined,
        })}
        onSelectTier={vi.fn()}
        onFastChange={onFastChange}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('model-fast-selector')).toBeTruthy()
    expect(screen.getByText('速度')).toBeTruthy()
    expect(screen.getByTestId('model-fast-option-standard').textContent).toBe('标准')
    expect(screen.getByTestId('model-fast-option-fast').getAttribute('title')).toBe(
      '1.5 倍速度，用量更多',
    )
    fireEvent.click(screen.getByTestId('model-fast-option-fast'))
    expect(onFastChange).toHaveBeenCalledWith({
      key: 'service_tier',
      value: 'fast',
    })
  })

  it('shows reasoning effort options for Codex catalog control and writes param', () => {
    const onReasoningEffortChange = vi.fn()
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          id: 'gpt-5.6-luna',
          name: 'gpt-5.6-luna',
          display_name: 'GPT-5.6 Luna',
          provider: 'openai-codex',
          runtime_profile: undefined,
          context_tiers: [],
          context_window_tokens: 1_100_000,
          runtime_controls: [
            {
              key: 'reasoning_effort',
              label: '推理强度',
              description: '更高档位会更快消耗使用额度。',
              kind: 'select',
              param_path: 'reasoning_effort',
              default_value: 'medium',
              visibility: 'model_menu',
              options: [
                { value: 'low', label: '轻度' },
                { value: 'medium', label: '中' },
                { value: 'high', label: '高' },
                { value: 'xhigh', label: '极高' },
                { value: 'max', label: '最大' },
              ],
            },
          ],
        })}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={onReasoningEffortChange}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('reasoning-effort-selector')).toBeTruthy()
    expect(screen.getByText('推理强度')).toBeTruthy()
    expect(screen.queryByText('默认')).toBeNull()
    expect(screen.getByTestId('reasoning-effort-option-medium').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByText('更高档位会更快消耗使用额度。')).toBeTruthy()
    fireEvent.click(screen.getByTestId('reasoning-effort-option-xhigh'))
    expect(onReasoningEffortChange).toHaveBeenCalledWith({
      key: 'reasoning_effort',
      value: 'xhigh',
    })
  })

  it('hides reasoning effort selector when runtime_profile.thinking is present', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          runtime_controls: [
            {
              key: 'reasoning_effort',
              label: '思考强度',
              kind: 'select',
              param_path: 'reasoning_effort',
              options: [{ value: 'high', label: '高' }],
            },
          ],
        })}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('reasoning-effort-selector')).toBeNull()
    expect(screen.getByTestId('thinking-mode-selector')).toBeTruthy()
  })

  it('kimi k2.5/k2.6: shows binary toggle, not deep / low-medium-high', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          runtime_profile: {
            thinking: {
              supported: true,
              modes: ['off', 'standard'],
              default_mode: 'standard',
            },
          },
        })}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('thinking-mode-selector')).toBeTruthy()
    expect(screen.getByText('思考')).toBeTruthy()
    expect(screen.getByText('关闭')).toBeTruthy()
    expect(screen.getByText('开启')).toBeTruthy()
    expect(screen.queryByText('深度')).toBeNull()
    expect(screen.queryByText('Low')).toBeNull()
    expect(screen.queryByText('Medium')).toBeNull()
    expect(screen.queryByText('High')).toBeNull()
    expect(screen.queryByText('Max')).toBeNull()
    expect(
      screen.getByTestId('model-settings-thinking')
        .querySelector('[data-thinking-mode="deep"]'),
    ).toBeNull()
  })

  it('kimi k2.7-code: readonly always-on, no off control', () => {
    render(
      <ModelRuntimeOptionsPanel
        model={modelWithThinking({
          runtime_profile: {
            thinking: {
              supported: true,
              modes: [],
              default_mode: 'standard',
              always_on: true,
            },
          },
        })}
        onSelectTier={vi.fn()}
        onFastChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onThinkingModeChange={vi.fn()}
        onPerformanceProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('thinking-mode-selector')).toBeTruthy()
    expect(screen.getByTestId('thinking-always-on').textContent).toContain('始终开启')
    expect(screen.queryByTestId('model-settings-thinking')).toBeNull()
    expect(screen.queryByText('关闭')).toBeNull()
  })
})
