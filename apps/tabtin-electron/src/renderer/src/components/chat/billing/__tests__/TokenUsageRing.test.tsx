import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const billingState = {
  showPerMessageCost: true,
}

vi.mock('@/stores/useBillingStore', () => ({
  useBillingStore: (selector: (state: typeof billingState) => unknown) => selector(billingState),
}))

import { TokenUsageRing } from '../TokenUsageRing'

describe('TokenUsageRing', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not show cache hit as zero when cache usage is unknown', () => {
    render(
      <TokenUsageRing
        inputTokens={1_000}
        outputTokens={20}
        contextTokens={1_000}
        contextWindow={10_000}
      />,
    )

    fireEvent.mouseEnter(screen.getByLabelText('会话上下文用量 10%，悬停查看详情'))

    expect(screen.queryByText('缓存命中')).toBeNull()
  })

  it('shows explicit zero cache hit when the session usage field exists', () => {
    render(
      <TokenUsageRing
        inputTokens={1_000}
        outputTokens={20}
        contextTokens={1_000}
        contextWindow={10_000}
        cacheReadTokens={0}
        hasCacheReadTokens
      />,
    )

    fireEvent.mouseEnter(screen.getByLabelText('会话上下文用量 10%，悬停查看详情'))

    expect(screen.getByText('缓存命中')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
  })
})
