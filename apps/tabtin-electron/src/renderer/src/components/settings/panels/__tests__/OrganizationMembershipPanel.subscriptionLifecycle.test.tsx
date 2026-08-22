import React from 'react'
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrganizationMembershipPanel } from '../OrganizationMembershipPanel'

const state = vi.hoisted(() => ({
  overview: undefined as any,
  plans: undefined as any,
  overviewLoading: false,
  plansLoading: false,
  plansEnabled: false,
  refetchOverview: vi.fn(),
  refetchPlans: vi.fn(),
  previewMembershipUpgrade: vi.fn(),
  toggleOrganizationAutoRenew: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Dialog: ({ open, children }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogScrollBody: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  ScrollArea: ({ children }: any) => <div>{children}</div>,
  StatusNotice: ({ description }: any) => <div role="alert">{description}</div>,
  Switch: ({ checked, onCheckedChange, ...props }: any) => (
    <input
      aria-label="自动续费"
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const translations: Record<string, string> = {
        'membership.title': 'Membership & Credits',
        'membership.refresh': 'Refresh',
        'membership.units.credits': 'credits',
        'membership.tierNames.free': 'Free',
        'membership.tierNames.pro': 'Professional',
        'membership.tierNames.enterprise': 'Enterprise',
        'membership.lifecycleState.active': 'Active',
        'membership.lifecycleState.free': 'Free',
        'membership.currentSubscription.title': 'Current subscription',
        'membership.currentSubscription.currentPlan': 'Current plan',
        'membership.currentSubscription.freeBadge': 'Free plan',
        'membership.currentSubscription.freeDescription': 'No paid subscription is active',
        'membership.currentSubscription.longTerm': 'Valid indefinitely',
        'membership.currentSubscription.viewPlans': 'View plans',
        'membership.currentSubscription.manage': 'Manage subscription',
        'membership.currentSubscription.upgrade': 'Upgrade plan',
        'membership.currentSubscription.periodStart': 'Starts',
        'membership.currentSubscription.periodEnd': 'Expires',
        'membership.currentSubscription.remaining': 'Remaining',
        'membership.currentSubscription.remainingDays': '{{days}} day(s) remaining',
        'membership.creditsSummary.title': 'Credits usage',
        'membership.creditsSummary.subtitle': 'Included monthly credits and cash wallet credits are tracked separately.',
        'membership.creditsSummary.planCredits': 'Included monthly credits',
        'membership.creditsSummary.walletCredits': 'Cash wallet credits',
        'membership.creditsSummary.usageSummary': 'Used {{consumed}} / {{remaining}} remaining',
        'membership.creditsSummary.walletReserved': 'Reserved {{reserved}}',
        'membership.creditsSummary.walletUnaffected': 'Plan changes do not directly change cash wallet credits.',
        'membership.creditsSummary.planUsage': 'Used {{consumed}} / plan {{included}}',
        'membership.creditsSummary.description': 'Plan credits and cash wallet credits are tracked separately.',
        'membership.overview.creditsSummary': '{{credits}} remaining',
        'membership.entitlements.title': 'Plan entitlements',
        'membership.entitlements.snapshotDescription': 'Members, documents, tables, storage, and AI credits come from the server entitlement snapshot.',
        'membership.entitlements.limitHint': 'Exceeding a plan entitlement does not delete data; it only limits new items and prompts an upgrade.',
        'membership.entitlements.members': 'Members',
        'membership.entitlements.documents': 'Documents',
        'membership.entitlements.tables': 'Tables',
        'membership.entitlements.storage': 'Storage',
        'membership.entitlements.groups': 'Groups',
        'membership.entitlements.llmCredits': 'LLM points',
        'membership.entitlements.unlimited': 'Unlimited',
        'membership.entitlements.planLimit': 'Plan {{limit}}',
        'membership.entitlements.usedOfLimit': 'Used {{used}} / {{limit}}',
        'membership.planDialog.title': 'Choose a plan',
        'membership.planDialog.descriptionPrefix': 'For discounts or trials, visit ',
        'membership.planDialog.websiteLabel': 'example.com',
        'membership.planDialog.descriptionSuffix': ' and contact your account manager.',
        'membership.planDialog.current': 'Current plan',
        'membership.planDialog.recommended': 'Recommended',
        'membership.planDialog.loading': 'Loading…',
        'membership.planDialog.actions.renew': 'Renew',
        'membership.planDialog.actions.upgrade': 'Upgrade plan',
        'membership.billingCycle.monthly': 'Monthly plan',
      }
      return Object.entries(values).reduce(
        (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
        translations[key] ?? String(values.defaultValue ?? key),
      )
    },
  }),
}))

vi.mock('@/hooks/queries/membership', () => ({
  useSubscriptionOverviewQuery: () => ({
    data: state.overview,
    isLoading: state.overviewLoading,
    error: null,
    refetch: state.refetchOverview,
  }),
  useSubscriptionPlansQuery: (_organizationId: string, options?: { enabled?: boolean }) => {
    state.plansEnabled = Boolean(options?.enabled)
    return {
      data: options?.enabled ? state.plans : undefined,
      isLoading: state.plansLoading,
      isFetching: false,
      error: null,
      refetch: state.refetchPlans,
    }
  },
}))

vi.mock('@services/membershipApi', () => ({
  MembershipApiError: class MembershipApiError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  },
  MembershipApiService: {
    getMembershipScheduledChange: vi.fn().mockResolvedValue(null),
    getActiveMembershipUpgradeOrder: vi.fn().mockResolvedValue(null),
    previewMembershipUpgrade: state.previewMembershipUpgrade,
    toggleOrganizationAutoRenew: state.toggleOrganizationAutoRenew,
  },
}))

vi.mock('../SettingsPanelHeader', () => ({ SettingsPanelHeader: ({ title, meta }: any) => <header><h1>{title}</h1>{meta}</header> }))
vi.mock('../SettingsPanelLayout', () => ({ SettingsPanelLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../SettingsSection', () => ({ SettingsSection: ({ title, children }: any) => <section><h1>{title}</h1>{children}</section> }))
vi.mock('../../SettingsSectionCard', () => ({ SettingsSectionCard: ({ title, subtitle, children }: any) => <section><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}{children}</section> }))
vi.mock('../SettingsSectionCard', () => ({ SettingsSectionCard: ({ title, subtitle, children }: any) => <section><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}{children}</section> }))
vi.mock('../../SettingsInfoTooltip', () => ({
  SettingsInfoTooltip: ({ content }: any) => content ? <span data-testid="settings-info">{content}</span> : null,
}))
vi.mock('../SettingsRow', () => ({
  SettingsRow: ({ label, description, control }: any) => <div><span>{label}</span>{description && <small>{description}</small>}{control}</div>,
  SettingsRowGroup: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('../../SettingsRow', () => ({
  SettingsRow: ({ label, description, control }: any) => <div><span>{label}</span>{description && <small>{description}</small>}{control}</div>,
  SettingsRowGroup: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('../SettingsBadge', () => ({ SettingsBadge: ({ children }: any) => <span>{children}</span> }))
vi.mock('../../SettingsBadge', () => ({ SettingsBadge: ({ children }: any) => <span>{children}</span> }))
vi.mock('../MeterBar', () => ({ MeterBar: () => <div data-testid="meter" /> }))
vi.mock('../../MeterBar', () => ({ MeterBar: () => <div data-testid="meter" /> }))
vi.mock('@components/common/ListSkeletons', () => ({
  ManagementCardListSkeleton: () => <div data-testid="card-skeleton" />,
  DetailedRowListSkeleton: () => <div data-testid="row-skeleton" />,
}))
vi.mock('@/utils/i18n/format', () => ({
  formatDate: (value: string) => value.slice(0, 10),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', {
    minimumFractionDigits: options?.minimumFractionDigits ?? 0,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(value),
}))

const org = { id: 'org-1', name: '研发团队' } as any

const paidOverview = {
  membership: {
    organization_id: 'org-1',
    membership_id: 'mem-1',
    is_member: true,
    tier: { id: 'tier-pro-uuid', tier_type: 'pro', name: '专业会员', tier_level: 10, display_order: 20 },
    lifecycle_state: 'active',
    billing_cycle: 'monthly',
    start_date: '2026-07-01T00:00:00Z',
    end_date: '2026-08-01T00:00:00Z',
    grace_period_end: null,
    is_expired: false,
    days_until_expiry: 18,
    auto_renew: true,
    allowed_actions: ['upgrade', 'renew'],
    can_upgrade: true,
    can_renew: true,
    can_manage: true,
    quotas: {},
    quota_usage: {
      max_documents: { used: 6, limit: 50, plan_limit: 50 },
    },
    features: {},
  },
  subscription_display: { title: '专业会员' },
  wallet: {
    organization_id: 'org-1',
    credits: 100,
    credits_precise: '100.0000',
    credits_frozen: 1,
    credits_frozen_precise: '1.0000',
    available_credits: 99,
    available_credits_precise: '99.0000',
  },
  included_credits: '6000',
  consumed_credits: '300',
  remaining_credits: '5700',
  entitlements: {
    max_members: 1,
    max_documents: 50,
    max_tables: 50,
    max_groups: 1,
    included_storage_bytes: 10737418240,
    quota_usage: { max_documents: { used: 6, limit: 50, plan_limit: 50 } },
  },
  allowed_actions: ['upgrade', 'renew'],
  capabilities: { upgrade_quote_enabled: true, can_upgrade: true, can_renew: true, can_manage: true },
}

const freeOverview = {
  ...paidOverview,
  membership: {
    ...paidOverview.membership,
    membership_id: null,
    is_member: false,
    tier: { id: 'tier-free-uuid', tier_type: 'free', name: '免费版', tier_level: 0, display_order: 0 },
    lifecycle_state: 'free',
    end_date: null,
    days_until_expiry: null,
    auto_renew: false,
    can_upgrade: false,
  },
  included_credits: '0',
  consumed_credits: '0',
  remaining_credits: '0',
}

const plans = {
  current_plan: paidOverview.membership.tier,
  plans: [
    {
      id: 'tier-pro-uuid',
      tier_type: 'pro',
      name: '专业会员',
      tier_level: 10,
      display_order: 20,
      monthly_price: '98.00',
      yearly_price: null,
      entitlements: { included_credits: '6000', max_members: 1, storage_bytes: 10737418240, max_documents: 50, max_tables: 50, max_groups: 1 },
      action: 'renew',
      button: { label: '当前套餐', disabled: true },
      current: true,
    },
    {
      id: 'tier-enterprise-uuid',
      tier_type: 'enterprise',
      name: '企业版',
      tier_level: 20,
      display_order: 30,
      monthly_price: '399.00',
      yearly_price: null,
      entitlements: { included_credits: '30000', max_members: 30, storage_bytes: 107374182400, max_documents: 3000, max_tables: 1000, max_groups: 30 },
      action: 'upgrade',
      button: { label: '升级套餐', disabled: false },
      current: false,
    },
  ],
}

describe('OrganizationMembershipPanel PR3.1 data flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    state.overview = paidOverview
    state.plans = plans
    state.overviewLoading = false
    state.plansLoading = false
    state.plansEnabled = false
  })

  it('renders paid subscription from overview only', () => {
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    expect(screen.getByText('Professional')).toBeInTheDocument()
    expect(screen.queryByText('专业会员')).not.toBeInTheDocument()
    expect(screen.getByText(/2026-08-01/)).toBeInTheDocument()
    expect(screen.getByText('Plan entitlements')).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expect(screen.getByText('Tables')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Groups')).toBeInTheDocument()
    expect(screen.queryByText('成员')).not.toBeInTheDocument()
    expect(screen.queryByText('文档')).not.toBeInTheDocument()
    expect(screen.queryByText('表格')).not.toBeInTheDocument()
    expect(screen.queryByText('群组')).not.toBeInTheDocument()
  })

  it('renders free subscription without fake expiration date', () => {
    state.overview = freeOverview
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    expect(screen.getAllByText('Free').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('免费版')).not.toBeInTheDocument()
    expect(screen.getByText(/Valid indefinitely/)).toBeInTheDocument()
    expect(screen.queryByText(/有效期至/)).not.toBeInTheDocument()
    expect(screen.getByText('Plan entitlements')).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expect(screen.getByText('Tables')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Groups')).toBeInTheDocument()
    expect(screen.getByText('Used 6 / 50')).toBeInTheDocument()
  })

  it('does not enable plans query before opening the plan dialog', () => {
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    expect(state.plansEnabled).toBe(false)
  })

  it('opens plan dialog without calling upgrade preview', () => {
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    fireEvent.click(screen.getByText('Manage subscription'))
    expect(state.plansEnabled).toBe(true)
    expect(state.previewMembershipUpgrade).not.toHaveBeenCalled()
  })

  it('refetches plans and overview whenever the plan dialog opens', async () => {
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    expect(state.refetchPlans).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Manage subscription'))
    await waitFor(() => {
      expect(state.refetchPlans).toHaveBeenCalled()
      expect(state.refetchOverview).toHaveBeenCalled()
    })
  })

  it('localizes the server action label for upgrade plan', () => {
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    fireEvent.click(screen.getByText('Manage subscription'))
    expect(screen.getByText('Upgrade plan')).toBeInTheDocument()
  })

  it('calls upgrade preview exactly once when clicking an upgrade plan', async () => {
    state.previewMembershipUpgrade.mockResolvedValue({
      action: 'upgrade',
      quote_token: 'token',
      current_plan: '专业会员',
      target_plan: '企业版',
      period_start: '2026-07-01T00:00:00Z',
      period_end: '2026-08-01T00:00:00Z',
      quoted_at: '2026-07-10T00:00:00Z',
      quote_expires_at: '2026-07-10T00:15:00Z',
      target_effective_period_price: '399.00',
      current_value: '46.00',
      target_value: '266.00',
      discount_amount: '46.00',
      payable_amount: '220.00',
    })
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    fireEvent.click(screen.getByText('Manage subscription'))
    fireEvent.click(screen.getByText('Upgrade plan'))
    await waitFor(() => expect(state.previewMembershipUpgrade).toHaveBeenCalledTimes(1))
  })

  it('keeps quote_token out of persistent storage', async () => {
    state.previewMembershipUpgrade.mockResolvedValue({
      action: 'upgrade',
      quote_token: 'token',
      current_plan: '专业会员',
      target_plan: '企业版',
      period_start: '2026-07-01T00:00:00Z',
      period_end: '2026-08-01T00:00:00Z',
      quoted_at: '2026-07-10T00:00:00Z',
      quote_expires_at: '2026-07-10T00:15:00Z',
      target_effective_period_price: '399.00',
      current_value: '46.00',
      target_value: '266.00',
      discount_amount: '46.00',
      payable_amount: '220.00',
    })
    render(<OrganizationMembershipPanel organization={org} canManageOrganization />)
    fireEvent.click(screen.getByText('Manage subscription'))
    fireEvent.click(screen.getByText('Upgrade plan'))
    await waitFor(() => expect(screen.getByText('¥220.00')).toBeInTheDocument())
    expect(JSON.stringify(localStorage)).not.toContain('token')
    expect(JSON.stringify(sessionStorage)).not.toContain('token')
  })
})
