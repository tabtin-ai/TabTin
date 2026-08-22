/**
 * ApprovalTierUpgradeButton — 审批卡片就地升档按钮行为验证。
 *
 * 覆盖：
 *  1. 档位映射：请求批准 → 「自动通过」；自动通过 → 「全部允许」；全部允许不渲染
 *  2. 未超 grant 上限：点击直接写会话档 + onUpgraded，不弹确认
 *  3. 超出 grant 上限：先 ConfirmDialog，确认后 persistGrant → 写会话档 + onUpgraded
 *  4. PMO 群会话不渲染；组织未开放 / 需抬 grant 但无管理权限 → 禁用 + badge
 *
 * 审批档读写规则本身（agentCache 刷新 / grant 解析 / 持久化）由
 * useApprovalGrantControl 承载，在 AgentSecurityPanel.test.tsx 经
 * ApprovalGrantSection 覆盖，这里 mock 掉只验编排。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { controlState, controlFns, authState, orgState, guardState } = vi.hoisted(() => ({
  controlState: {
    saving: false,
    currentGrant: 'always_ask' as string,
    currentConversationApproval: 'always_ask' as string,
    approvalContext: { allowYolo: true, isGroupSpace: false },
    targetSessionId: 'session-1' as string | null,
  },
  controlFns: {
    applyConversationApproval: vi.fn(),
    persistGrant: vi.fn(async () => true),
  },
  authState: { user: { id: 'user-1' } },
  orgState: {
    currentUserRole: 'owner' as string | null,
    selectedOrganization: { id: 'org-1', owner_id: 'user-1' },
  },
  guardState: { blockSettingsEdit: false },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opt?: { defaultValue?: string }) => opt?.defaultValue ?? key,
  }),
}))

vi.mock('@utils/cn', () => ({
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
}))

vi.mock('@components/ui', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open
      ? <button type="button" data-testid="confirm-upgrade" onClick={onConfirm}>confirm</button>
      : null,
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof orgState) => unknown) => selector(orgState),
}))

vi.mock('@/hooks/useCanEditAgentSettings', () => ({
  canEditAgentSettings: (role: string | null) =>
    role === 'owner' || role === 'admin' || role === 'editor',
}))

vi.mock('@components/space-settings/hooks/useSpaceSettingsEditGuard', () => ({
  useSpaceSettingsEditGuard: () => guardState,
  effectiveCanEditAgentSettings: (roleCanEdit: boolean, guard: { blockSettingsEdit: boolean }) =>
    roleCanEdit && !guard.blockSettingsEdit,
}))

vi.mock('@components/space-settings/useApprovalGrantControl', () => ({
  useApprovalGrantControl: () => ({ ...controlState, ...controlFns }),
}))

vi.mock('@/stores/chat/shared/types', () => ({
  approvalModeRank: (mode: string) =>
    ({ always_ask: 0, auto: 1, full_access: 2 })[mode] ?? 0,
}))

import { ApprovalTierUpgradeButton } from '../ApprovalTierUpgradeButton'

function renderButton(onUpgraded = vi.fn()) {
  render(
    <ApprovalTierUpgradeButton
      spaceId="space-1"
      sessionId="session-1"
      onUpgraded={onUpgraded}
    />,
  )
  return onUpgraded
}

beforeEach(() => {
  vi.clearAllMocks()
  controlState.saving = false
  controlState.currentGrant = 'always_ask'
  controlState.currentConversationApproval = 'always_ask'
  controlState.approvalContext = { allowYolo: true, isGroupSpace: false }
  controlFns.persistGrant.mockResolvedValue(true)
  orgState.currentUserRole = 'owner'
  guardState.blockSettingsEdit = false
})

describe('ApprovalTierUpgradeButton', () => {
  it('请求批准 → 按钮显示「自动通过」；自动通过 → 「全部允许」；全部允许不渲染', () => {
    const { unmount } = render(
      <ApprovalTierUpgradeButton spaceId="space-1" sessionId="session-1" onUpgraded={vi.fn()} />,
    )
    expect(screen.getByTestId('approval-tier-upgrade').textContent).toContain('自动通过')
    unmount()

    controlState.currentConversationApproval = 'auto'
    const second = render(
      <ApprovalTierUpgradeButton spaceId="space-1" sessionId="session-1" onUpgraded={vi.fn()} />,
    )
    expect(screen.getByTestId('approval-tier-upgrade').textContent).toContain('全部允许')
    second.unmount()

    controlState.currentConversationApproval = 'full_access'
    render(
      <ApprovalTierUpgradeButton spaceId="space-1" sessionId="session-1" onUpgraded={vi.fn()} />,
    )
    expect(screen.queryByTestId('approval-tier-upgrade')).toBeNull()
  })

  it('grant 已覆盖下一档时：点击直接写会话档并放行，不弹确认', () => {
    controlState.currentGrant = 'auto'
    const onUpgraded = renderButton()

    fireEvent.click(screen.getByTestId('approval-tier-upgrade'))

    expect(screen.queryByTestId('confirm-upgrade')).toBeNull()
    expect(controlFns.persistGrant).not.toHaveBeenCalled()
    expect(controlFns.applyConversationApproval).toHaveBeenCalledWith('auto')
    expect(onUpgraded).toHaveBeenCalledTimes(1)
  })

  it('超出 grant 上限时：先确认，确认后 persistGrant → 写会话档 + 放行', async () => {
    const onUpgraded = renderButton()

    fireEvent.click(screen.getByTestId('approval-tier-upgrade'))
    expect(controlFns.applyConversationApproval).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-upgrade'))
    await waitFor(() => expect(onUpgraded).toHaveBeenCalledTimes(1))
    expect(controlFns.persistGrant).toHaveBeenCalledWith('auto')
    expect(controlFns.applyConversationApproval).toHaveBeenCalledWith('auto')
  })

  it('persistGrant 失败时不写会话档、不放行', async () => {
    controlFns.persistGrant.mockResolvedValue(false)
    const onUpgraded = renderButton()

    fireEvent.click(screen.getByTestId('approval-tier-upgrade'))
    fireEvent.click(screen.getByTestId('confirm-upgrade'))

    await waitFor(() => expect(controlFns.persistGrant).toHaveBeenCalled())
    expect(controlFns.applyConversationApproval).not.toHaveBeenCalled()
    expect(onUpgraded).not.toHaveBeenCalled()
  })

  it('PMO 群会话不渲染', () => {
    controlState.approvalContext = { allowYolo: true, isGroupSpace: true }
    render(
      <ApprovalTierUpgradeButton spaceId="space-1" sessionId="session-1" onUpgraded={vi.fn()} />,
    )
    expect(screen.queryByTestId('approval-tier-upgrade')).toBeNull()
  })

  it('组织未开放宽松审批：按钮禁用 + 「组织未开放」badge，点击无效果', () => {
    controlState.approvalContext = { allowYolo: false, isGroupSpace: false }
    const onUpgraded = renderButton()

    const btn = screen.getByTestId('approval-tier-upgrade') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-org-locked')).toBe('true')
    expect(btn.textContent).toContain('组织未开放')

    fireEvent.click(btn)
    expect(screen.queryByTestId('confirm-upgrade')).toBeNull()
    expect(controlFns.persistGrant).not.toHaveBeenCalled()
    expect(controlFns.applyConversationApproval).not.toHaveBeenCalled()
    expect(onUpgraded).not.toHaveBeenCalled()
  })

  it('需抬 grant 但无管理权限：按钮禁用 + 「需管理员授权」badge', () => {
    orgState.currentUserRole = 'viewer'
    const onUpgraded = renderButton()

    const btn = screen.getByTestId('approval-tier-upgrade') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-manage-locked')).toBe('true')
    expect(btn.textContent).toContain('需管理员授权')

    fireEvent.click(btn)
    expect(screen.queryByTestId('confirm-upgrade')).toBeNull()
    expect(controlFns.persistGrant).not.toHaveBeenCalled()
    expect(onUpgraded).not.toHaveBeenCalled()
  })

  it('grant 已覆盖且无管理权限：不需要抬 grant，不锁定、可直接升会话档', () => {
    controlState.currentGrant = 'auto'
    orgState.currentUserRole = 'viewer'
    const onUpgraded = renderButton()

    const btn = screen.getByTestId('approval-tier-upgrade') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(controlFns.applyConversationApproval).toHaveBeenCalledWith('auto')
    expect(onUpgraded).toHaveBeenCalledTimes(1)
  })
})
