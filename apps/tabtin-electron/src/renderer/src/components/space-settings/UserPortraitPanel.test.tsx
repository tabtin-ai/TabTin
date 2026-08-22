/**
 * UserPortraitPanel —  临时隐藏手动整理 UI（失败静默）
 *
 * 覆盖：不渲染「立即整理」、失败 banner，也不把 last_distill_error 打到 notice。
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserPortrait } from '@/services/userPortraitApi'

const { hookState } = vi.hoisted(() => {
  const state = {
    portrait: null as UserPortrait | null,
    isLoading: false,
    loadError: null as string | null,
    isDistilling: false,
    isStillDistilling: false,
    refresh: vi.fn(),
    submitHint: vi.fn(),
    triggerDistill: vi.fn(),
  }
  return { hookState: state }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) => {
      if (typeof options?.defaultValue === 'string') return options.defaultValue
      if (key === 'userPortrait.distillNow') return '立即整理'
      if (key === 'userPortrait.failed.title') return '上次整理失败'
      if (key === 'userPortrait.failed.retry') return '重试'
      if (key === 'userPortrait.lastDistilled') return '上次整理：'
      if (key === 'userPortrait.neverDistilled') return '尚未整理'
      if (key === 'userPortrait.empty.title') return `${options?.name ?? 'Tin'} 还在认识你`
      if (key === 'userPortrait.empty.hint') return 'hint'
      if (key === 'userPortrait.hintInput.label') return '想要修改？'
      if (key === 'userPortrait.hintInput.placeholder') return 'placeholder'
      if (key === 'userPortrait.hintInput.send') return '发送'
      return key
    },
  }),
}))

vi.mock('@/hooks/useUserPortrait', () => ({
  useUserPortrait: () => hookState,
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, onClick, disabled }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}))

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

import {
  SHOW_DISTILL_FAILED_RETRY_BANNER,
  SHOW_MANUAL_DISTILL_BUTTON,
  UserPortraitPanel,
} from './UserPortraitPanel'

function makePortrait(overrides: Partial<UserPortrait> = {}): UserPortrait {
  return {
    id: 'p1',
    user_id: 'u1',
    organization_id: 'org-1',
    agent_id: 'agent-1',
    content_md: '',
    version: 0,
    last_distilled_at: null,
    last_distill_status: 'idle',
    last_distill_error: '',
    pending_hints_count: 0,
    memory_enabled: true,
    created_at: '2026-07-30T05:00:00.000Z',
    updated_at: '2026-07-30T06:00:00.000Z',
    ...overrides,
  }
}

const DISTILL_ERROR = '整理服务暂时不可用，旧画像仍在，可稍后重试'

describe('UserPortraitPanel ', () => {
  beforeEach(() => {
    hookState.portrait = makePortrait()
    hookState.isLoading = false
    hookState.loadError = null
    hookState.isDistilling = false
    hookState.isStillDistilling = false
    hookState.refresh.mockReset()
    hookState.submitHint.mockReset()
    hookState.triggerDistill.mockReset()
  })

  it('失败静默：不渲染立即整理、失败 banner，也不展示 last_distill_error', () => {
    expect(SHOW_MANUAL_DISTILL_BUTTON).toBe(false)
    expect(SHOW_DISTILL_FAILED_RETRY_BANNER).toBe(false)

    hookState.portrait = makePortrait({
      last_distill_status: 'failed',
      last_distill_error: DISTILL_ERROR,
    })

    render(
      <UserPortraitPanel
        enabled
        canManage
        organizationId="org-1"
        agentId="agent-1"
        agentName="小Tin"
      />,
    )

    expect(screen.queryByText('立即整理')).toBeNull()
    expect(screen.queryByText('上次整理失败')).toBeNull()
    expect(screen.queryByText('重试')).toBeNull()
    expect(screen.queryByText(DISTILL_ERROR)).toBeNull()
  })

  it('轮询从 distilling 落到 failed 时仍静默，不写 error notice', () => {
    hookState.isDistilling = true
    hookState.portrait = makePortrait({
      last_distill_status: 'pending',
      last_distill_error: '',
    })

    const { rerender } = render(
      <UserPortraitPanel
        enabled
        canManage
        organizationId="org-1"
        agentId="agent-1"
        agentName="小Tin"
      />,
    )

    hookState.isDistilling = false
    hookState.portrait = makePortrait({
      last_distill_status: 'failed',
      last_distill_error: DISTILL_ERROR,
      updated_at: '2026-07-30T06:35:21.000Z',
    })

    rerender(
      <UserPortraitPanel
        enabled
        canManage
        organizationId="org-1"
        agentId="agent-1"
        agentName="小Tin"
      />,
    )

    expect(screen.queryByText(DISTILL_ERROR)).toBeNull()
    expect(screen.queryByText('上次整理失败')).toBeNull()
    expect(screen.queryByText('立即整理')).toBeNull()
  })
})
