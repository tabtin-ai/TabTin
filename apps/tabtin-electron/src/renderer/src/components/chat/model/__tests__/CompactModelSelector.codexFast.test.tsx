import React, { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { Model } from '@tabtin/chat-client'
import { CompactModelSelector } from '../CompactModelSelector'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('../ProviderLogo', () => ({
  ProviderLogo: () => <span data-testid="provider-logo" />,
}))

vi.mock('@/hooks/useCloseOnOrganizationContextReset', () => ({
  useCloseOnOrganizationContextReset: () => {},
}))

const codexModel: Model = {
  id: 'gpt-5.6-sol',
  name: 'gpt-5.6-sol',
  display_name: 'GPT-5.6 Sol',
  provider: 'openai-codex',
  provider_display_name: 'OpenAI Codex / ChatGPT',
  provider_scope: 'user',
  description: '',
  max_tokens: 128000,
  supports_streaming: true,
  supports_vision: true,
  supports_function_calling: true,
  cost_per_1k_tokens: 0,
  is_default: false,
}

const codexLuna: Model = {
  ...codexModel,
  id: 'gpt-5.6-luna',
  name: 'gpt-5.6-luna',
  display_name: 'GPT-5.6 Luna',
}

const platformModel: Model = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'kimi',
  display_name: 'Kimi K2.7 Code',
  provider: 'kimi',
  provider_display_name: 'Kimi',
  provider_scope: 'platform',
  description: '',
  max_tokens: 8192,
  supports_streaming: true,
  supports_vision: false,
  supports_function_calling: true,
  cost_per_1k_tokens: 0,
  is_default: true,
}

const platformWithSpeedFast: Model = {
  ...platformModel,
  id: '22222222-2222-2222-2222-222222222222',
  name: 'demo-fast',
  display_name: 'Demo Fast Model',
  runtime_controls: [
    {
      key: 'speed',
      label: '速度',
      kind: 'select',
      param_path: 'speed',
      default_value: null,
      visibility: 'model_menu',
      options: [
        { value: null, label: '标准' },
        { value: 'fast', label: 'Fast' },
      ],
    },
  ],
}

describe('CompactModelSelector Fast', () => {
  it('用独立来源标签区分平台、组织 BYOK 和我的 BYOK', () => {
    const official = {
      ...platformModel,
      provider: 'openai',
      provider_display_name: 'OpenAI',
      provider_scope: 'global' as const,
      display_name: 'GPT Platform',
    }
    const organization = {
      ...official,
      id: 'organization-model',
      provider_scope: 'organization' as const,
      display_name: 'GPT Organization',
    }
    const personal = {
      ...official,
      id: 'personal-model',
      provider_scope: 'user' as const,
      display_name: 'GPT Personal',
    }

    render(
      <CompactModelSelector
        models={[official, organization, personal]}
        currentModel={official}
        onModelChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /GPT Platform/i }))

    const platformGroup = screen.getByRole('region', { name: '平台模型 · OpenAI' })
    const organizationGroup = screen.getByRole('region', { name: '组织 BYOK · OpenAI' })
    const personalGroup = screen.getByRole('region', { name: '我的 BYOK · OpenAI' })
    expect(within(platformGroup).getByText('平台模型').className).toContain('bg-accent/10')
    expect(within(organizationGroup).getByText('组织 BYOK').className).toContain('bg-warning/10')
    expect(within(personalGroup).getByText('我的 BYOK').className).toContain('bg-success/10')
  })

  it('禁用状态下空模型入口也不可触发重试', () => {
    const onRetry = vi.fn()
    render(
      <CompactModelSelector
        models={[]}
        currentModel={null}
        onModelChange={vi.fn()}
        onRetry={onRetry}
        disabled
      />,
    )

    const trigger = screen.getByRole('button') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('勾选 Codex 时右栏显示速度选项，点快速写入 service_tier=fast', () => {
    const onModelChange = vi.fn()
    render(
      <CompactModelSelector
        models={[platformModel, codexModel]}
        currentModel={codexModel}
        onModelChange={onModelChange}
        currentModelParamOverrides={null}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Sol/i }))
    const panel = screen.getByTestId('model-runtime-options-panel')
    expect(panel.querySelector('[data-testid="model-fast-selector"]')).toBeTruthy()
    expect(screen.getByText('速度')).toBeTruthy()
    expect(screen.getByTestId('model-fast-option-standard').textContent).toBe('标准')
    expect(screen.getByTestId('model-fast-option-fast').textContent).toBe('快速')
    expect(screen.getByTestId('model-fast-option-standard').getAttribute('aria-checked')).toBe(
      'true',
    )
    fireEvent.click(screen.getByTestId('model-fast-option-fast'))

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-sol', undefined, {
      key: 'service_tier',
      value: 'fast',
    })
  })

  it('目录声明 speed=fast 的平台模型右栏可点快速写入 speed', () => {
    const onModelChange = vi.fn()
    render(
      <CompactModelSelector
        models={[platformWithSpeedFast]}
        currentModel={platformWithSpeedFast}
        onModelChange={onModelChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Demo Fast Model/i }))
    fireEvent.click(screen.getByTestId('model-fast-option-fast'))

    expect(onModelChange).toHaveBeenCalledWith(
      '22222222-2222-2222-2222-222222222222',
      undefined,
      { key: 'speed', value: 'fast' },
    )
  })

  it('快速已开启时点标准清回 null；触发条显示闪电', () => {
    const onModelChange = vi.fn()
    render(
      <CompactModelSelector
        models={[codexModel]}
        currentModel={codexModel}
        onModelChange={onModelChange}
        currentModelParamOverrides={{
          service_tier: 'fast',
          fast_by_model: JSON.stringify({ 'gpt-5.6-sol': true }),
        }}
      />,
    )

    expect(screen.getByTestId('model-fast-trigger-icon')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Sol/i }))
    expect(screen.getByTestId('model-fast-option-fast').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('model-fast-option-standard'))

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-sol', undefined, {
      key: 'service_tier',
      value: null,
    })
  })

  it('切换到非 Codex 时右栏不显示速度；切回 Codex 才显示', () => {
    function Harness() {
      const [current, setCurrent] = useState<Model>(codexLuna)
      return (
        <CompactModelSelector
          models={[codexModel, codexLuna, platformModel]}
          currentModel={current}
          onModelChange={(modelId) => {
            const next = [codexModel, codexLuna, platformModel].find((m) => m.id === modelId)
            if (next) setCurrent(next)
          }}
          currentModelParamOverrides={{
            fast_by_model: JSON.stringify({ 'gpt-5.6-sol': true }),
          }}
        />
      )
    }

    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Luna/i }))
    expect(screen.getByTestId('model-fast-selector')).toBeTruthy()
    expect(screen.getByTestId('model-fast-option-standard').getAttribute('aria-checked')).toBe(
      'true',
    )

    fireEvent.click(screen.getByRole('button', { name: /Kimi/i }))
    expect(screen.queryByTestId('model-fast-selector')).toBeNull()
  })

  it('旧会话仅有 service_tier 时右栏快速为选中态，点标准可关', () => {
    const onModelChange = vi.fn()
    render(
      <CompactModelSelector
        models={[codexModel, codexLuna]}
        currentModel={codexModel}
        onModelChange={onModelChange}
        currentModelParamOverrides={{ service_tier: 'fast' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Sol/i }))
    expect(screen.getByTestId('model-fast-option-fast').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByTestId('model-fast-option-standard'))
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-sol', undefined, {
      key: 'service_tier',
      value: null,
    })
  })

  it('未声明 Fast 的模型右栏不显示速度，触发条无闪电', () => {
    render(
      <CompactModelSelector
        models={[platformModel]}
        currentModel={platformModel}
        onModelChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Kimi/i }))
    expect(screen.queryByTestId('model-fast-selector')).toBeNull()
    expect(screen.queryByTestId('model-fast-trigger-icon')).toBeNull()
  })

  it('切换模型后列表保持打开，便于继续对比', () => {
    function Harness() {
      const [current, setCurrent] = useState(codexModel)
      return (
        <CompactModelSelector
          models={[codexModel, codexLuna]}
          currentModel={current}
          onModelChange={(modelId) => {
            const next = [codexModel, codexLuna].find((m) => m.id === modelId)
            if (next) setCurrent(next)
          }}
        />
      )
    }

    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Sol/i }))
    expect(screen.getByTestId('compact-model-selector-menu')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Luna/i }))
    expect(screen.getByTestId('compact-model-selector-menu')).toBeTruthy()
    expect(
      screen.getByTestId('compact-model-selector-menu').textContent,
    ).toMatch(/GPT-5\.6 Luna/)
  })
})
