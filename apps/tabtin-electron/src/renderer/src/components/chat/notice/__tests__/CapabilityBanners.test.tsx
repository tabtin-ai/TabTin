import React from 'react'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CapabilityBanners } from '../CapabilityBanners'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? _key),
  }),
}))

const SESSION_ID = 'session-capability-banner'

beforeEach(() => {
  useChatRuntimeStore.getState().reset()
})

describe('CapabilityBanners', () => {
  it('renders fallback copy for tool/system/reasoning/json_object downgrade events', () => {
    const store = useChatRuntimeStore.getState()
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'tool', fallback_to: 'omit_tools' })
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'system', fallback_to: 'omit_system_prompt' })
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'reasoning', fallback_to: 'omit_reasoning_param' })
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'json_object', fallback_to: 'system_prompt_hint' })

    render(<CapabilityBanners sessionId={SESSION_ID} />)

    expect(screen.getByText(/不支持工具调用/)).toBeTruthy()
    expect(screen.getByText(/不支持 system prompt/)).toBeTruthy()
    expect(screen.getByText(/不支持 reasoning\/thinking 参数/)).toBeTruthy()
    expect(screen.getByText(/不支持 JSON Object/)).toBeTruthy()
  })

  it('runtime_profile stage uses product notice, not omit-thinking copy', () => {
    const store = useChatRuntimeStore.getState()
    store.pushCapabilityBanner(SESSION_ID, {
      kind: 'downgrade',
      feature: 'reasoning',
      fallback_to: 'medium',
      extras: {
        stage: 'runtime_profile',
        reason: 'effort_level_unavailable',
        requested: 'deep',
      },
    })

    render(<CapabilityBanners sessionId={SESSION_ID} />)

    expect(screen.getByText(/不支持你选择的思考强度/)).toBeTruthy()
    expect(screen.queryByText(/已自动忽略/)).toBeNull()
    expect(screen.getByTestId('capability-banner').getAttribute('data-banner-stage')).toBe(
      'runtime_profile',
    )
  })

  it('forced thinking notice from runtime_profile stage', () => {
    useChatRuntimeStore.getState().pushCapabilityBanner(SESSION_ID, {
      kind: 'downgrade',
      feature: 'reasoning',
      fallback_to: 'low',
      extras: { stage: 'runtime_profile', reason: 'thinking_off_unsupported' },
    })
    render(<CapabilityBanners sessionId={SESSION_ID} />)
    expect(screen.getByText(/始终思考/)).toBeTruthy()
    expect(screen.queryByText(/已自动忽略/)).toBeNull()
  })

  it('legacy reasoning keeps omit-thinking message', () => {
    useChatRuntimeStore.getState().pushCapabilityBanner(SESSION_ID, {
      kind: 'downgrade',
      feature: 'reasoning',
      fallback_to: 'omit_reasoning_param',
      extras: { stage: 'wire_adapter' },
    })
    render(<CapabilityBanners sessionId={SESSION_ID} />)
    expect(screen.getByText(/不支持 reasoning\/thinking 参数/)).toBeTruthy()
  })

  it('deduplicates, dismisses, and clears capability banners', () => {
    const store = useChatRuntimeStore.getState()
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'tool', fallback_to: 'omit_tools' })
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'tool', fallback_to: 'omit_tools' })
    store.pushCapabilityBanner(SESSION_ID, { kind: 'downgrade', feature: 'tool', fallback_to: 'auto_tool_choice' })

    const { rerender } = render(<CapabilityBanners sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('capability-banner')).toHaveLength(2)

    act(() => {
      fireEvent.click(screen.getAllByTestId('capability-banner-dismiss')[0])
    })
    rerender(<CapabilityBanners sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('capability-banner')).toHaveLength(1)

    act(() => {
      useChatRuntimeStore.getState().clearCapabilityBanners(SESSION_ID)
    })
    rerender(<CapabilityBanners sessionId={SESSION_ID} />)
    expect(screen.queryByTestId('capability-banners-host')).toBeNull()
  })
})
