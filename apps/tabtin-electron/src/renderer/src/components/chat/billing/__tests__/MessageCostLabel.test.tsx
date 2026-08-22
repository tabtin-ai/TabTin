import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const billingState = {
  showPerMessageCost: true,
}

vi.mock('@/stores/useBillingStore', () => ({
  useBillingStore: (selector: (state: typeof billingState) => unknown) => selector(billingState),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = opts && 'defaultValue' in opts ? String(opts.defaultValue) : key
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? ''))
    },
  }),
}))

import { MessageCostLabel } from '../MessageCostLabel'

describe('MessageCostLabel', () => {
  beforeEach(() => {
    billingState.showPerMessageCost = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('BYOK / local usage with zero credits shows request tokens and exposes cache details', () => {
    render(
      <MessageCostLabel
        metadata={{
          is_byok: true,
          last_input_tokens: 18_978,
          last_output_tokens: 5,
          last_cache_read_input_tokens: 1_024,
          last_cache_creation_input_tokens: 512,
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: '查看费用详情' })
    expect(trigger.textContent).toContain('19.0K tokens')

    fireEvent.mouseEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByText('你使用的是自带 API 密钥（BYOK），本条消息不从 TabTin 钱包扣 credits。')).toBeTruthy()
    expect(screen.getByText('本次输入：20.5K tokens')).toBeTruthy()
    expect(screen.getByText('缓存命中：1.0K tokens')).toBeTruthy()
    expect(screen.getByText('缓存写入：512 tokens')).toBeTruthy()
    expect(screen.getByText('新增输入：19.0K tokens')).toBeTruthy()
  })

  it('shows explicit zero cache for BYOK / local usage when the provider reports no cache hit', () => {
    render(
      <MessageCostLabel
        metadata={{
          last_input_tokens: 18_104,
          last_output_tokens: 5,
          last_cache_read_input_tokens: 0,
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: '查看费用详情' })
    expect(trigger.textContent).toContain('18.1K tokens')

    fireEvent.click(trigger)

    expect(screen.getByText('本次输入：18.1K tokens')).toBeTruthy()
    expect(screen.getByText('缓存命中：0 tokens')).toBeTruthy()
    expect(screen.getByText('新增输入：18.1K tokens')).toBeTruthy()
  })

  it('does not mix per-call input with turn-level output totals', () => {
    render(
      <MessageCostLabel
        metadata={{
          last_input_tokens: 1_000,
          output_tokens: 9_000,
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: '查看费用详情' })
    expect(trigger.textContent).toContain('1.0K tokens')

    fireEvent.click(trigger)

    expect(screen.queryByText('输出：9.0K tokens')).toBeNull()
  })

  it('uses per-call output when the footer supplies it', () => {
    render(
      <MessageCostLabel
        metadata={{
          last_input_tokens: 1_000,
          last_output_tokens: 25,
          output_tokens: 9_000,
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: '查看费用详情' })
    expect(trigger.textContent).toContain('1.0K tokens')

    fireEvent.click(trigger)

    expect(screen.getByText('messageCost.outputTokens')).toBeTruthy()
  })

  it('hides old messages that have neither cost nor token usage', () => {
    const { container } = render(<MessageCostLabel metadata={{}} />)
    expect(container.firstChild).toBeNull()
  })

  it('respects the billing visibility switch', () => {
    billingState.showPerMessageCost = false
    const { container } = render(
      <MessageCostLabel
        metadata={{
          input_tokens: 1_000,
          output_tokens: 10,
        }}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
