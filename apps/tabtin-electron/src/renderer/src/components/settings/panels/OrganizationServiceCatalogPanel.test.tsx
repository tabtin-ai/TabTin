import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const billingMocks = vi.hoisted(() => ({
  getBillingPolicy: vi.fn(),
  updateBillingPolicy: vi.fn(),
  getOrganizationSummary: vi.fn(),
  getLowBalanceConfig: vi.fn(),
  updateLowBalanceConfig: vi.fn(),
  getServiceCatalog: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'organizationPricingRules.officialServicePrice') {
        return `${String(options?.price)} 点券/${String(options?.unit)}`
      }
      if (typeof options?.defaultValue === 'string') return options.defaultValue
      return key
    },
  }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (state: { setRoute: () => void }) => unknown) =>
    selector({ setRoute: vi.fn() }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: {
    updateOrganization: ReturnType<typeof vi.fn>
    isLoading: boolean
  }) => unknown) =>
    selector({
      updateOrganization: vi.fn(),
      isLoading: false,
    }),
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'owner-1' } }),
}))

vi.mock('@/services/billingApi', () => ({
  OrganizationBillingApiService: {
    getBillingPolicy: billingMocks.getBillingPolicy,
    updateBillingPolicy: billingMocks.updateBillingPolicy,
    getOrganizationSummary: billingMocks.getOrganizationSummary,
    getLowBalanceConfig: billingMocks.getLowBalanceConfig,
    updateLowBalanceConfig: billingMocks.updateLowBalanceConfig,
    getServiceCatalog: billingMocks.getServiceCatalog,
  },
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
  }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ConfirmDialog: () => null,
  EmptyState: () => null,
  Input: ({
    value,
    onChange,
    onKeyDown,
    disabled,
    type,
    className,
  }: {
    value?: string
    onChange?: React.ChangeEventHandler<HTMLInputElement>
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
    disabled?: boolean
    type?: string
    className?: string
  }) => (
    <input
      type={type}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      disabled={disabled}
      className={className}
    />
  ),
  StatusNotice: ({ title, description }: { title?: React.ReactNode; description?: React.ReactNode }) => (
    <div role="status">
      {title ? <span>{title}</span> : null}
      {description ? <span>{description}</span> : null}
    </div>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    disabled?: boolean
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
  toast: billingMocks.toast,
}))

vi.mock('../SettingsPanelHeader', () => ({
  SettingsPanelHeader: ({ title }: { title: React.ReactNode }) => <h2>{title}</h2>,
}))

vi.mock('../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock('../SettingsSectionCard', () => ({
  SettingsSectionCard: ({
    title,
    actions,
    children,
  }: React.PropsWithChildren<{ title?: React.ReactNode; actions?: React.ReactNode }>) => (
    <section>
      <h3>{title}</h3>
      {actions}
      {children}
    </section>
  ),
}))

vi.mock('../SettingsRow', () => ({
  SettingsRow: ({
    label,
    control,
    children,
  }: React.PropsWithChildren<{
    label: React.ReactNode
    control?: React.ReactNode
  }>) => (
    <div>
      <span>{label}</span>
      {control}
      {children}
    </div>
  ),
  SettingsRowGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../SettingsLink', () => ({
  SettingsLink: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
}))

vi.mock('@components/common/ListSkeletons', () => ({
  ManagementCardListSkeleton: () => null,
}))

vi.mock('@components/agent-memory/WorkspaceAutoMemorySection', () => ({
  WorkspaceAutoMemorySection: ({
    organizationId,
    embedded,
  }: {
    organizationId: string
    embedded?: boolean
  }) => <div>自动记忆配置:{organizationId}:{String(embedded)}</div>,
}))

vi.mock('@components/agent-memory/MemoryRecordStylePage', () => ({
  MemoryRecordStylePage: () => <div>记忆偏好</div>,
}))

vi.mock('@components/agent-memory/OrgAgentDiaryFeed', () => ({
  OrgAgentDiaryFeed: ({ organizationId }: { organizationId: string }) => (
    <div>Agent 工作日记:{organizationId}</div>
  ),
}))

import { OrganizationServiceCatalogPanel } from './OrganizationServiceCatalogPanel'

describe('OrganizationServiceCatalogPanel Enter 保存', () => {
  beforeEach(() => {
    billingMocks.getBillingPolicy.mockReset()
    billingMocks.updateBillingPolicy.mockReset()
    billingMocks.getOrganizationSummary.mockReset()
    billingMocks.getLowBalanceConfig.mockReset()
    billingMocks.updateLowBalanceConfig.mockReset()
    billingMocks.getServiceCatalog.mockReset()
    billingMocks.toast.mockReset()

    billingMocks.getBillingPolicy.mockResolvedValue({
      auto_topup_enabled: true,
      auto_topup_spend_yuan: '10',
      auto_topup_monthly_cap_yuan: '100',
    })
    billingMocks.updateBillingPolicy.mockResolvedValue({
      auto_topup_enabled: true,
      auto_topup_spend_yuan: '20',
      auto_topup_monthly_cap_yuan: '100',
    })
    billingMocks.getOrganizationSummary.mockResolvedValue({
      llm_month_budget: { auto_topup_spent_yuan: '0' },
    })
    billingMocks.getLowBalanceConfig.mockResolvedValue({
      warning_credits: '1000',
      critical_credits: '200',
      email_enabled: false,
      owner_has_email: false,
      owner_email_masked: null,
      owner_user_id: 'owner-1',
    })
    billingMocks.updateLowBalanceConfig.mockResolvedValue({
      warning_credits: '1500',
      critical_credits: '200',
      email_enabled: false,
      owner_has_email: false,
      owner_email_masked: null,
      owner_user_id: 'owner-1',
    })
    billingMocks.getServiceCatalog.mockResolvedValue({
      services: [
        {
          service_key: 'media.image',
          name: 'AI 文生图',
          description: '使用 AI 根据文字描述生成图片',
          unit: '张',
          unit_price: '25',
          category: 'media',
        },
        {
          service_key: 'llm.tokens',
          name: '大模型对话',
          description: 'LLM Token 消耗，按模型动态定价',
          unit: '千 token',
          unit_price: null,
          category: 'llm',
        },
      ],
    })
  })

  it('计费规则按调用渠道展示官方服务和 BYOK 说明', async () => {
    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
        readOnly
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getServiceCatalog).toHaveBeenCalledWith('org-1')
    })

    expect(screen.getByText('organizationPricingRules.pricingExplanationTitle')).toBeTruthy()
    expect(screen.getByText('organizationPricingRules.officialServicesTitle')).toBeTruthy()
    expect(screen.getByText('organizationPricingRules.byokTitle')).toBeTruthy()
    expect(screen.getByText('organizationPricingRules.byokNoCredits')).toBeTruthy()
    expect(screen.getByText('AI 文生图')).toBeTruthy()
    expect(screen.getByText('25 点券/张')).toBeTruthy()
    expect(screen.getByText('organizationPricingRules.officialServiceOnly')).toBeTruthy()
    expect(screen.queryByText('大模型对话')).toBeNull()
  })

  it.each([
    ['个人组织', 'personal'],
    ['团队组织', 'team'],
  ] as const)('%s 在 AI 服务开关页读取对应 Workspace 的自动记忆设置', async (_label, type) => {
    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: `${type}-org`, name: 'Org', owner_id: 'owner-1', type }}
        canManageOrganization
      />,
    )

    expect(await screen.findByText(`自动记忆配置:${type}-org:true`)).toBeTruthy()
  })

  it('团队普通成员可查看自动记忆设置，但不读取 Owner 账务配置', async () => {
    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'team-org', name: 'Org', owner_id: 'another-owner', type: 'team' }}
        canManageOrganization={false}
      />,
    )

    expect(await screen.findByText('自动记忆配置:team-org:true')).toBeTruthy()
    expect(billingMocks.getBillingPolicy).not.toHaveBeenCalled()
    expect(billingMocks.getLowBalanceConfig).not.toHaveBeenCalled()
  })

  it('自动补充金额输入框按 Enter 触发保存', async () => {
    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getBillingPolicy).toHaveBeenCalled()
    })

    const amountInput = screen.getAllByRole('spinbutton')[0] as HTMLInputElement
    fireEvent.change(amountInput, { target: { value: '20' } })
    fireEvent.keyDown(amountInput, { key: 'Enter' })

    await waitFor(() => {
      expect(billingMocks.updateBillingPolicy).toHaveBeenCalledWith('org-1', {
        auto_topup_enabled: true,
        auto_topup_spend_yuan: 20,
        auto_topup_monthly_cap_yuan: 100,
      })
    })
  })

  it('金额≥1000 时输入框回填无千分位且不为空 ', async () => {
    billingMocks.getBillingPolicy.mockResolvedValue({
      auto_topup_enabled: true,
      auto_topup_spend_yuan: '7777',
      auto_topup_monthly_cap_yuan: '89898',
    })
    billingMocks.updateBillingPolicy.mockResolvedValue({
      auto_topup_enabled: true,
      auto_topup_spend_yuan: '7777',
      auto_topup_monthly_cap_yuan: '89898',
    })

    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getBillingPolicy).toHaveBeenCalled()
    })

    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[]
    expect(inputs[0].value).toBe('7777')
    expect(inputs[1].value).toBe('89898')
    expect(inputs[0].value).not.toContain(',')
    expect(inputs[1].value).not.toContain(',')

    fireEvent.keyDown(inputs[0], { key: 'Enter' })
    await waitFor(() => {
      expect(billingMocks.updateBillingPolicy).toHaveBeenCalledWith('org-1', {
        auto_topup_enabled: true,
        auto_topup_spend_yuan: 7777,
        auto_topup_monthly_cap_yuan: 89898,
      })
    })

    await waitFor(() => {
      expect(inputs[0].value).toBe('7777')
      expect(inputs[1].value).toBe('89898')
    })
  })

  it('低余额预警输入框按 Enter 触发保存', async () => {
    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getLowBalanceConfig).toHaveBeenCalled()
    })

    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[]
    const warningInput = inputs[2]
    fireEvent.change(warningInput, { target: { value: '1500' } })
    fireEvent.keyDown(warningInput, { key: 'Enter' })

    await waitFor(() => {
      expect(billingMocks.updateLowBalanceConfig).toHaveBeenCalledWith('org-1', {
        warning_credits: 1500,
        critical_credits: 200,
        email_enabled: false,
      })
    })
  })

  it('同值保存低余额配置只保存配置，不触发额外提醒', async () => {
    billingMocks.updateLowBalanceConfig.mockResolvedValue({
      warning_credits: '1000',
      critical_credits: '200',
      email_enabled: false,
      owner_has_email: false,
      owner_email_masked: null,
      owner_user_id: 'owner-1',
    })

    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getLowBalanceConfig).toHaveBeenCalled()
    })

    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[]
    fireEvent.keyDown(inputs[2], { key: 'Enter' })

    await waitFor(() => {
      expect(billingMocks.updateLowBalanceConfig).toHaveBeenCalledWith('org-1', {
        warning_credits: 1000,
        critical_credits: 200,
        email_enabled: false,
      })
    })
  })

  it('IME 组字中按 Enter 不触发保存', async () => {
    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getBillingPolicy).toHaveBeenCalled()
    })

    const amountInput = screen.getAllByRole('spinbutton')[0] as HTMLInputElement
    fireEvent.change(amountInput, { target: { value: '20' } })
    fireEvent.keyDown(amountInput, {
      key: 'Enter',
      isComposing: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(billingMocks.updateBillingPolicy).not.toHaveBeenCalled()
  })

  it('拨开开关立即落库，无需点保存', async () => {
    billingMocks.getBillingPolicy.mockResolvedValue({
      auto_topup_enabled: false,
      auto_topup_spend_yuan: '10',
      auto_topup_monthly_cap_yuan: '100',
    })
    billingMocks.updateBillingPolicy.mockResolvedValue({
      auto_topup_enabled: true,
      auto_topup_spend_yuan: '10',
      auto_topup_monthly_cap_yuan: '100',
    })

    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getBillingPolicy).toHaveBeenCalled()
    })

    const toggle = screen.getAllByRole('checkbox')[1] as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(billingMocks.updateBillingPolicy).toHaveBeenCalledWith('org-1', {
        auto_topup_enabled: true,
        auto_topup_spend_yuan: 10,
        auto_topup_monthly_cap_yuan: 100,
      })
    })
  })

  it('关闭开关立即落库', async () => {
    billingMocks.updateBillingPolicy.mockResolvedValue({
      auto_topup_enabled: false,
      auto_topup_spend_yuan: '10',
      auto_topup_monthly_cap_yuan: '100',
    })

    render(
      <OrganizationServiceCatalogPanel
        organization={{ id: 'org-1', name: 'Org', owner_id: 'owner-1' }}
        canManageOrganization
      />,
    )

    await waitFor(() => {
      expect(billingMocks.getBillingPolicy).toHaveBeenCalled()
    })

    const toggle = screen.getAllByRole('checkbox')[1] as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(billingMocks.updateBillingPolicy).toHaveBeenCalledWith('org-1', {
        auto_topup_enabled: false,
      })
    })
  })
})
