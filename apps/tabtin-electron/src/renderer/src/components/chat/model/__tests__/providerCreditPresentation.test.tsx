import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { Model } from '@tabtin/chat-client'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        'model.promotionCredit.title': '🎁 推广赠送额度',
        'model.promotionCredit.remaining': '剩余 {{credits}} credits',
        'model.promotionCredit.inlineRemaining': '剩余专享 {{credits}} credits',
        'model.promotionCredit.inlineQuota': '赠享 {{remaining}}/{{total}} credits',
        'model.promotionCredit.expireAt': '有效期 {{date}}',
      }
      return (templates[key] || String(options?.defaultValue || key))
        .replace('{{credits}}', String(options?.credits || ''))
        .replace('{{remaining}}', String(options?.remaining || ''))
        .replace('{{total}}', String(options?.total || ''))
        .replace('{{date}}', String(options?.date || ''))
    },
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  ScrollArea: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
}))

vi.mock('../ProviderLogo', () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span data-testid={`provider-${provider}`} />
  ),
}))

import { ModelSelector } from '../ModelSelector'
import {
  confirmPromotionCreditModelSwitch,
  shouldConfirmPromotionCreditModelSwitch,
} from '../providerCreditPresentation'

function model(overrides: Partial<Model>): Model {
  return {
    id: 'model-id',
    name: 'model-name',
    display_name: 'Model',
    provider: 'provider',
    provider_display_name: 'Provider',
    description: '',
    capability_domain: 'chat',
    context_window_tokens: 128000,
    max_input_tokens: 120000,
    max_output_tokens: 8000,
    supports_streaming: true,
    supports_function_calling: true,
    supports_vision: false,
    supports_video_input: false,
    supports_document_input: false,
    billing_type: 'token',
    is_default: false,
    ...overrides,
  } as Model
}

const doubao = model({
  id: 'doubao-model-id',
  name: 'doubao-seed',
  display_name: '豆包 Seed',
  provider: 'volcengine',
  provider_display_name: '豆包',
  promotion_credit: {
    eligible: true,
    provider_key: 'volcengine',
    remaining_credits: 8000,
    total_credits: 10000,
    expire_at: '2026-09-01T00:00:00Z',
    label: '豆包推广赠送额度',
  },
})

const kimi = model({
  id: 'kimi-model-id',
  name: 'kimi-k2.6',
  display_name: 'Kimi K2.6',
  provider: 'moonshot',
  provider_display_name: 'Kimi',
  promotion_credit: null,
})

describe('Provider Credit 模型展示', () => {
  it('只在有服务端权益的模型条目展示余额与有效期', () => {
    render(
      <ModelSelector
        models={[doubao, kimi]}
        currentModel={doubao}
        onModelChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('豆包 Seed'))

    const doubaoButtons = screen.getAllByText('豆包 Seed')
    const doubaoOption = doubaoButtons[doubaoButtons.length - 1].closest('button')
    const kimiOption = screen.getByText('Kimi K2.6').closest('button')

    expect(doubaoOption).not.toBeNull()
    expect(kimiOption).not.toBeNull()
    expect(
      within(doubaoOption as HTMLButtonElement).getByText('赠享 8,000/10,000 credits'),
    ).not.toBeNull()
    expect(
      within(doubaoOption as HTMLButtonElement).getByText(/8,000\/10,000/),
    ).not.toBeNull()
    expect(
      within(kimiOption as HTMLButtonElement).queryByText(/赠享/),
    ).toBeNull()
  })

  it('无权益模型仍可正常选择', () => {
    const onModelChange = vi.fn()
    render(
      <ModelSelector
        models={[doubao, kimi]}
        currentModel={doubao}
        onModelChange={onModelChange}
      />,
    )

    fireEvent.click(screen.getByText('豆包 Seed'))
    fireEvent.click(screen.getByText('Kimi K2.6'))

    expect(onModelChange).toHaveBeenCalledWith('kimi-model-id')
  })
})

describe('模型来源展示', () => {
  it('在同一提供商下区分平台、组织 BYOK 和我的 BYOK', () => {
    const platformModel = model({
      id: 'platform-model',
      display_name: 'GPT Platform',
      provider: 'openai',
      provider_display_name: 'OpenAI',
      provider_scope: 'global',
    })
    const personalByokModel = model({
      id: 'personal-model',
      display_name: 'GPT Personal',
      provider: 'openai',
      provider_display_name: 'OpenAI',
      provider_scope: 'user',
    })
    const organizationByokModel = model({
      id: 'organization-model',
      display_name: 'GPT Organization',
      provider: 'openai',
      provider_display_name: 'OpenAI',
      provider_scope: 'organization',
    })

    render(
      <ModelSelector
        models={[platformModel, organizationByokModel, personalByokModel]}
        currentModel={platformModel}
        onModelChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('GPT Platform'))

    expect(screen.getByRole('region', { name: '平台模型 · OpenAI' })).not.toBeNull()
    expect(screen.getByRole('region', { name: '组织 BYOK · OpenAI' })).not.toBeNull()
    expect(screen.getByRole('region', { name: '我的 BYOK · OpenAI' })).not.toBeNull()
  })
})

describe('Provider Credit 切换提示', () => {
  it('从有权益模型切到无权益模型时弹确认，取消后不继续', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const t = vi.fn(
      (key: string, options?: Record<string, unknown>) => (
        String(options?.defaultValue || key)
          .replace('{{provider}}', String(options?.provider || ''))
          .replace('{{model}}', String(options?.model || ''))
      ),
    )

    const confirmed = await confirmPromotionCreditModelSwitch({
      currentModel: doubao,
      targetModel: kimi,
      t,
      confirm,
    })

    expect(confirmed).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].description).toContain('豆包')
    expect(confirm.mock.calls[0][0].description).toContain('Kimi K2.6')
  })

  it('目标模型也有权益时不提示', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const qwen = model({
      ...kimi,
      id: 'qwen-model-id',
      provider: 'dashscope',
      promotion_credit: {
        eligible: true,
        provider_key: 'dashscope',
        remaining_credits: 5000,
        expire_at: null,
        label: 'Qwen 推广赠送额度',
      },
    })

    expect(shouldConfirmPromotionCreditModelSwitch(doubao, qwen)).toBe(false)
    await expect(
      confirmPromotionCreditModelSwitch({
        currentModel: doubao,
        targetModel: qwen,
        t: key => key,
        confirm,
      }),
    ).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})
