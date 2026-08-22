/**
 *  回归：在团队设置页切换团队时，驱动右侧面板的 setRoute(路由) 必须与
 * selectOrganization(全局上下文/数据加载) 解耦——路由要同步切到新团队，不能被
 * 排在 `await selectOrganization` 之后。否则 detail/members 接口慢或失败时，
 * 切换器已显示新团队、面板仍停在旧团队（错位 + 误操作风险）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

const setRoute = vi.fn()
// selectOrganization 返回一个永不 resolve 的 promise，模拟 detail/members 加载未完成。
// 旧实现把 setRoute 排在 `await selectOrganization` 之后 → 永远不会被调用（用例失败）。
const selectOrganization = vi.fn(() => new Promise<void>(() => {}))
const runWithAgentContextSwitchGuard = vi.hoisted(() => vi.fn((
  _kind: string,
  proceed: () => Promise<void> | void,
) => {
  void proceed()
  return Promise.resolve(true)
}))

const organizations = [
  { id: 'wt-old', name: 'Old Team', type: 'team' },
  { id: 'wt-new', name: 'New Team', type: 'team' },
]
let selectedOrganization: { id: string; name: string; type: string } = organizations[0]
let activeRoute: { category: string; section: string; organizationId: string } | null = {
  category: 'organization',
  section: 'team',
  organizationId: 'wt-old',
}

vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: unknown) => unknown) =>
    selector({ organizations, selectedOrganization, selectOrganization }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (s: unknown) => unknown) =>
    selector({ activeRoute, setRoute }),
}))

vi.mock('@/services/agentContextSwitchGuard', () => ({
  runWithAgentContextSwitchGuard,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: Pass,
    DropdownMenuItem: ({
      children,
      onSelect,
    }: {
      children?: React.ReactNode
      onSelect?: () => void
    }) => (
      <button type="button" onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
  }
})

import { SettingsTeamSwitcher } from '../SettingsTeamSwitcher'

describe('SettingsTeamSwitcher ', () => {
  beforeEach(() => {
    setRoute.mockClear()
    selectOrganization.mockClear()
    runWithAgentContextSwitchGuard.mockClear()
    selectedOrganization = organizations[0]
    activeRoute = { category: 'organization', section: 'team', organizationId: 'wt-old' }
  })

  it('点新团队时同步切换设置路由到新团队（不被 selectOrganization 的加载阻塞）', () => {
    const { getByText } = render(<SettingsTeamSwitcher />)

    fireEvent.click(getByText('New Team'))

    // 即使 selectOrganization 尚未（且永不）resolve，setRoute 也已同步以新 organizationId 调用。
    expect(setRoute).toHaveBeenCalledTimes(1)
    expect(setRoute).toHaveBeenCalledWith({
      category: 'organization',
      section: 'team',
      organizationId: 'wt-new',
    })
    expect(selectOrganization).toHaveBeenCalledTimes(1)
    expect(runWithAgentContextSwitchGuard).toHaveBeenCalledWith('organization', expect.any(Function))
  })

  it('不在 organization 设置页时不改设置路由，仅切全局上下文', () => {
    activeRoute = { category: 'profile' as unknown as string, section: 'account', organizationId: '' }
    const { getByText } = render(<SettingsTeamSwitcher />)

    fireEvent.click(getByText('New Team'))

    expect(setRoute).not.toHaveBeenCalled()
    expect(selectOrganization).toHaveBeenCalledTimes(1)
  })
})
