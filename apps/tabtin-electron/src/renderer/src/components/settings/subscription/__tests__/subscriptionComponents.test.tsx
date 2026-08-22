import React from 'react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  CreditsSummaryCard,
  CurrentSubscriptionCard,
  SubscriptionActionButton,
  SubscriptionEmptyState,
  SubscriptionPlanDialog,
  SubscriptionSkeleton,
  SubscriptionStatusBadge,
  UpgradeQuoteDialog,
} from '..'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Dialog: ({ open, children }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogScrollBody: ({ children }: any) => <div data-testid="dialog-scroll-body">{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  ScrollArea: ({ children }: any) => <div>{children}</div>,
  StatusNotice: ({ description }: any) => <div role="alert">{description}</div>,
  Switch: ({ checked, onCheckedChange, ...props }: any) => (
    <input type="checkbox" aria-label="switch" checked={checked} onChange={(event) => onCheckedChange?.(event.currentTarget.checked)} {...props} />
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const translations: Record<string, string> = {
        'membership.lifecycleState.active': 'Active',
        'membership.lifecycleState.grace_period': 'Grace Period',
        'membership.lifecycleState.expired': 'Expired',
        'membership.lifecycleState.suspended': 'Suspended',
        'membership.lifecycleState.unknown': 'Unknown',
        'membership.lifecycleState.free': 'Free',
        'membership.tierNames.free': 'Free',
        'membership.tierNames.basic': 'Basic',
        'membership.tierNames.pro': 'Professional',
        'membership.tierNames.team': 'Team',
        'membership.currentSubscription.title': 'Current subscription',
        'membership.currentSubscription.currentPlan': 'Current plan',
        'membership.currentSubscription.freeBadge': 'Free plan',
        'membership.currentSubscription.longTerm': 'Valid indefinitely',
        'membership.currentSubscription.freeDescription': 'No paid subscription is active',
        'membership.currentSubscription.viewPlans': 'View plans',
        'membership.currentSubscription.manage': 'Manage subscription',
        'membership.currentSubscription.upgrade': 'Upgrade plan',
        'membership.currentSubscription.periodStart': 'Starts',
        'membership.currentSubscription.periodEnd': 'Expires',
        'membership.currentSubscription.expiredAt': 'Expired',
        'membership.currentSubscription.remaining': 'Remaining',
        'membership.currentSubscription.remainingDays': '{{days}} day(s) remaining',
        'membership.units.credits': 'credits',
        'membership.creditsSummary.title': 'Credits usage',
        'membership.creditsSummary.subtitle': 'Included monthly credits and cash wallet credits are tracked separately.',
        'membership.creditsSummary.planCredits': 'Included monthly credits',
        'membership.creditsSummary.walletCredits': 'Cash wallet credits',
        'membership.creditsSummary.usageSummary': 'Used {{consumed}} / {{remaining}} remaining',
        'membership.creditsSummary.walletReserved': 'Reserved {{reserved}}',
        'membership.creditsSummary.walletUnaffected': 'Plan changes do not directly change cash wallet credits.',
        'membership.creditsSummary.planUsage': 'Used {{consumed}} / plan {{included}}',
        'membership.creditsSummary.description': 'Plan credits and cash wallet credits are tracked separately. Plan upgrades or downgrades do not directly change cash wallet credits.',
        'membership.overview.creditsSummary': '{{credits}} remaining',
        'membership.planDialog.title': 'Choose a plan',
        'membership.planDialog.descriptionPrefix': 'For discounts or trials, visit ',
        'membership.planDialog.websiteLabel': 'example.com',
        'membership.planDialog.descriptionSuffix': ' and contact your account manager.',
        'membership.planDialog.current': 'Current plan',
        'membership.planDialog.recommended': 'Recommended',
        'membership.planDialog.loading': 'Loading…',
        'membership.planDialog.actions.new': 'Subscribe now',
        'membership.planDialog.actions.upgrade': 'Upgrade plan',
        'membership.planDialog.actions.renew': 'Renew',
        'membership.planDialog.actions.downgrade': 'Downgrade next cycle',
        'membership.planDialog.actions.switch': 'Switch next cycle',
        'membership.billingCycle.monthly': 'Monthly plan',
        'membership.entitlements.llmCredits': 'LLM points',
        'membership.entitlements.members': 'Members',
        'membership.entitlements.storage': 'Storage',
        'membership.entitlements.documents': 'Documents',
        'membership.entitlements.tables': 'Tables',
        'membership.entitlements.groups': 'Groups',
        'membership.entitlements.unlimited': 'Unlimited',
      }
      return Object.entries(values).reduce(
        (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
        translations[key] ?? String(values.defaultValue ?? key),
      )
    },
  }),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  ManagementCardListSkeleton: () => <div data-testid="card-skeleton" />,
  DetailedRowListSkeleton: () => <div data-testid="row-skeleton" />,
}))

vi.mock('../../SettingsInfoTooltip', () => ({
  SettingsInfoTooltip: ({ content }: { content: React.ReactNode }) => <span data-testid="settings-info">{content}</span>,
}))

vi.mock('@/utils/i18n/format', () => ({
  formatDate: (value: string) => value.slice(0, 10),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', {
    minimumFractionDigits: options?.minimumFractionDigits ?? 0,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(value),
}))

const paidMembership = {
  organization_id: 'org-1',
  membership_id: 'mem-1',
  is_member: true,
  tier: { id: 'tier-pro-uuid', tier_type: 'pro', name: '专业会员', tier_level: 10, display_order: 20 },
  lifecycle_state: 'active',
  billing_cycle: 'monthly',
  start_date: '2026-07-01T00:00:00Z',
  end_date: '2026-08-01T00:00:00Z',
  is_expired: false,
  days_until_expiry: 18,
  auto_renew: true,
  can_upgrade: true,
  quotas: {},
  features: {},
} as any

const plans = [
  {
    id: 'tier-free-uuid',
    tier_type: 'free',
    name: '免费版',
    tier_level: 0,
    display_order: 0,
    monthly_price: '0.00',
    yearly_price: null,
    entitlements: { included_credits: '0', max_members: 1, storage_bytes: 1024 * 1024, max_documents: 10, max_tables: 20, max_groups: 1 },
    action: 'renew',
    button: { label: '当前套餐', disabled: true },
    current: true,
  },
  {
    id: 'tier-team-uuid',
    tier_type: 'team',
    name: '团队版',
    tier_level: 20,
    display_order: 30,
    monthly_price: '299.00',
    yearly_price: null,
    entitlements: { included_credits: '30000', max_members: 5, storage_bytes: 50 * 1024 * 1024 * 1024, max_documents: 3000, max_tables: 1000, max_groups: 30 },
    action: 'upgrade',
    button: { label: '升级套餐', disabled: false },
    current: false,
  },
] as any

describe('SubscriptionStatusBadge', () => {
  it('renders active', () => {
    render(<SubscriptionStatusBadge state="active" />)
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('renders grace period', () => {
    render(<SubscriptionStatusBadge state="grace_period" />)
    expect(screen.getByText('Grace Period')).toBeInTheDocument()
  })

  it('renders expired', () => {
    render(<SubscriptionStatusBadge state="expired" />)
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  it('renders suspended', () => {
    render(<SubscriptionStatusBadge state="suspended" />)
    expect(screen.getByText('Suspended')).toBeInTheDocument()
  })

  it('renders unknown fallback', () => {
    render(<SubscriptionStatusBadge />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })
})

describe('CurrentSubscriptionCard', () => {
  it('renders the localized paid tier name', () => {
    render(<CurrentSubscriptionCard membership={paidMembership} canManageOrganization onOpenPlans={vi.fn()} />)
    expect(screen.getByText('Professional')).toBeInTheDocument()
    expect(screen.queryByText('专业会员')).not.toBeInTheDocument()
  })

  it('renders subscription period grid', () => {
    render(<CurrentSubscriptionCard membership={paidMembership} canManageOrganization onOpenPlans={vi.fn()} />)
    expect(screen.getByText('2026-07-01')).toBeInTheDocument()
    expect(screen.getByText('2026-08-01')).toBeInTheDocument()
  })

  it('renders English period labels', () => {
    render(<CurrentSubscriptionCard membership={paidMembership} canManageOrganization onOpenPlans={vi.fn()} />)
    expect(screen.getByText('Starts')).toBeInTheDocument()
    expect(screen.getByText('Expires')).toBeInTheDocument()
    expect(screen.getByText('18 day(s) remaining')).toBeInTheDocument()
  })

  it('prefers the local tier_type translation over the backend-configured name', () => {
    render(
      <CurrentSubscriptionCard
        membership={{
          ...paidMembership,
          tier: { ...paidMembership.tier, id: 'tier-basic-uuid', tier_type: 'basic', name: '后台基础套餐' },
        }}
        canManageOrganization
        onOpenPlans={vi.fn()}
      />,
    )
    expect(screen.getByText('Basic')).toBeInTheDocument()
    expect(screen.queryByText('后台基础套餐')).not.toBeInTheDocument()
  })

  it('falls back to the generic current-plan label for an unknown unnamed tier', () => {
    render(
      <CurrentSubscriptionCard
        membership={{
          ...paidMembership,
          tier: { ...paidMembership.tier, tier_type: 'future', name: '' },
        }}
        canManageOrganization
        onOpenPlans={vi.fn()}
      />,
    )
    expect(screen.getAllByText('Current plan').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('membership.tierNames.future')).not.toBeInTheDocument()
  })

  it('renders expiration date from server field', () => {
    render(<CurrentSubscriptionCard membership={paidMembership} canManageOrganization onOpenPlans={vi.fn()} />)
    expect(screen.getByText('2026-08-01')).toBeInTheDocument()
  })

  it('renders localized current plan badge', () => {
    render(<CurrentSubscriptionCard membership={paidMembership} autoRenewChecked canManageOrganization onOpenPlans={vi.fn()} />)
    expect(screen.getByText('Current plan')).toBeInTheDocument()
  })

  it('calls open plans from manage button', () => {
    const onOpenPlans = vi.fn()
    render(<CurrentSubscriptionCard membership={paidMembership} canManageOrganization onOpenPlans={onOpenPlans} />)
    fireEvent.click(screen.getByText('Manage subscription'))
    expect(onOpenPlans).toHaveBeenCalledTimes(1)
  })

  it('renders free subscription as long-term valid', () => {
    render(<CurrentSubscriptionCard membership={{ ...paidMembership, membership_id: null, lifecycle_state: 'free', tier: { name: '免费版' } }} canManageOrganization onOpenPlans={vi.fn()} />)
    expect(screen.getByText('Valid indefinitely')).toBeInTheDocument()
    expect(screen.getByText('No paid subscription is active')).toBeInTheDocument()
  })
})

describe('CreditsSummaryCard', () => {
  it('renders included credits separately', () => {
    render(<CreditsSummaryCard inline includedCredits="6000" consumedCredits="300" remainingCredits="5700" />)
    expect(screen.getByText('Included monthly credits')).toBeInTheDocument()
    expect(screen.getAllByText('6,000 credits').length).toBeGreaterThan(0)
  })

  it('renders wallet credits as hero metric', () => {
    render(<CreditsSummaryCard inline includedCredits="6000" consumedCredits="300" remainingCredits="5700" wallet={{ available_credits_precise: '99.0000', credits_frozen_precise: '1.0000' } as any} />)
    expect(screen.getByText('Cash wallet credits')).toBeInTheDocument()
    expect(screen.getByText('99 credits')).toBeInTheDocument()
  })

  it('renders reserved wallet credits', () => {
    render(<CreditsSummaryCard inline includedCredits="6000" consumedCredits="300" remainingCredits="5700" wallet={{ available_credits_precise: '99.0000', credits_frozen_precise: '1.0000' } as any} />)
    expect(screen.getByText('Reserved 1 credits')).toBeInTheDocument()
  })

  it('explains membership changes do not affect wallet credits', () => {
    render(<CreditsSummaryCard includedCredits="6000" consumedCredits="300" remainingCredits="5700" />)
    expect(screen.getByTestId('settings-info')).toHaveTextContent('Plan credits and cash wallet credits are tracked separately. Plan upgrades or downgrades do not directly change cash wallet credits.')
  })
})

describe('SubscriptionPlanDialog', () => {
  it('does not render when closed', () => {
    render(<SubscriptionPlanDialog open={false} onOpenChange={vi.fn()} plans={plans} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.queryByText('Choose a plan')).not.toBeInTheDocument()
  })

  it('renders plans when open', () => {
    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={plans} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.getByTestId('dialog-scroll-body')).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.queryByText('免费版')).not.toBeInTheDocument()
    expect(screen.queryByText('团队版')).not.toBeInTheDocument()
  })

  it('does not expose an i18n key for an unknown unnamed plan tier', () => {
    render(
      <SubscriptionPlanDialog
        open
        onOpenChange={vi.fn()}
        plans={[{ ...plans[1], tier_type: 'future', name: '' }]}
        canManageOrganization
        onSelectPlan={vi.fn()}
      />,
    )
    expect(screen.getByText('Current plan')).toBeInTheDocument()
    expect(screen.queryByText('membership.tierNames.future')).not.toBeInTheDocument()
  })

  it('shows the discount and trial consultation guidance', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('tabtin', { openExternal })

    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={plans} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.getByTestId('dialog').textContent).toContain('For discounts or trials, visit example.com and contact your account manager.')
    const websiteLink = screen.getByRole('link', { name: 'example.com' })
    expect(websiteLink).toHaveAttribute('href', 'https://www.example.com/')

    fireEvent.click(websiteLink)
    expect(openExternal).toHaveBeenCalledWith('https://www.example.com/')
  })

  it('localizes the server button action', () => {
    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={plans} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.getByText('Upgrade plan')).toBeInTheDocument()
  })

  it('renders downgrade label from server action/button', () => {
    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={[{ ...plans[1], action: 'downgrade', button: { label: '下周期降级' } }]} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.getByText('Downgrade next cycle')).toBeInTheDocument()
  })

  it('renders switch label from server action/button', () => {
    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={[{ ...plans[1], action: 'switch', button: { label: '下周期切换' } }]} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.getByText('Switch next cycle')).toBeInTheDocument()
  })

  it('calls select handler with chosen plan', () => {
    const onSelect = vi.fn()
    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={plans} canManageOrganization onSelectPlan={onSelect} />)
    fireEvent.click(screen.getByText('Upgrade plan'))
    expect(onSelect).toHaveBeenCalledWith(plans[1])
  })

  it('disables current plan button', () => {
    render(<SubscriptionPlanDialog open onOpenChange={vi.fn()} plans={plans} canManageOrganization onSelectPlan={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Current plan' })).toBeDisabled()
  })
})

describe('UpgradeQuoteDialog', () => {
  const quote = {
    action: 'upgrade',
    quote_token: 'token',
    current_plan: '专业会员',
    target_plan: '团队版',
    period_start: '2026-07-01T00:00:00Z',
    period_end: '2026-08-01T00:00:00Z',
    quoted_at: '2026-07-10T00:00:00Z',
    quote_expires_at: '2026-07-10T00:15:00Z',
    target_effective_period_price: '299.00',
    current_value: '32.67',
    target_value: '199.33',
    discount_amount: '32.67',
    payable_amount: '166.66',
  } as any

  it('renders server payable amount directly', () => {
    render(<UpgradeQuoteDialog open onOpenChange={vi.fn()} quote={quote} />)
    expect(screen.getByText('¥166.66')).toBeInTheDocument()
  })

  it('renders current and target plan names', () => {
    render(<UpgradeQuoteDialog open onOpenChange={vi.fn()} quote={quote} />)
    expect(screen.getByText('Professional → Team')).toBeInTheDocument()
  })

  it('renders create order button after quote', () => {
    render(<UpgradeQuoteDialog open onOpenChange={vi.fn()} quote={quote} onCreateOrder={vi.fn()} />)
    expect(screen.getByText('继续升级 ¥166.66')).toBeInTheDocument()
  })

  it('renders error and retry button', () => {
    render(<UpgradeQuoteDialog open onOpenChange={vi.fn()} error="当前套餐暂不支持在线升级，请联系客服。" onRetry={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('当前套餐暂不支持在线升级，请联系客服。')
    expect(screen.getByText('重新获取报价')).toBeInTheDocument()
  })

  it('calls close handler', () => {
    const onOpenChange = vi.fn()
    render(<UpgradeQuoteDialog open onOpenChange={onOpenChange} quote={quote} />)
    fireEvent.click(screen.getByText('关闭'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders restored active upgrade order without quote', () => {
    render(
      <UpgradeQuoteDialog
        open
        onOpenChange={vi.fn()}
        order={{
          order_id: 'order-1',
          order_no: 'UP-001',
          payment_status: 'pending',
          benefit_status: 'pending',
          payable_amount: '166.66',
          wallet: {
            available_balance: '200.00',
            available_cny: '200.00',
            sufficient: true,
            shortage_amount: '0.00',
            recommended_recharge_amount: '0.00',
          },
          allowed_actions: {
            pay_with_wallet: true,
            pay_with_alipay: true,
            pay_with_wechat: true,
            recharge: false,
          },
        } as any}
      />,
    )
    expect(screen.getByText('已恢复一笔未完成的升级订单。报价 token 不会持久化保存，如需重新选择套餐可关闭后重新获取报价。')).toBeInTheDocument()
    expect(screen.getByText('选择支付方式')).toBeInTheDocument()
  })

  it('renders recharge action when wallet balance is insufficient', () => {
    render(
      <UpgradeQuoteDialog
        open
        onOpenChange={vi.fn()}
        order={{
          order_id: 'order-1',
          order_no: 'UP-001',
          payment_status: 'pending',
          benefit_status: 'pending',
          payable_amount: '166.66',
          wallet: {
            available_balance: '20.00',
            available_cny: '20.00',
            sufficient: false,
            shortage_amount: '146.66',
            recommended_recharge_amount: '146.66',
          },
          allowed_actions: {
            pay_with_wallet: false,
            pay_with_alipay: true,
            pay_with_wechat: true,
            recharge: true,
          },
        } as any}
      />,
    )
    expect(screen.getByText('余额差额')).toBeInTheDocument()
    expect(screen.getByText('充值')).toBeInTheDocument()
  })
})

describe('Skeleton and empty state', () => {
  it('renders loading skeleton', () => {
    render(<SubscriptionSkeleton />)
    expect(screen.getByTestId('card-skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('row-skeleton')).toBeInTheDocument()
  })

  it('renders free empty state', () => {
    render(<SubscriptionEmptyState onOpenPlans={vi.fn()} />)
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(screen.getByText(/Valid indefinitely/)).toBeInTheDocument()
  })

  it('localizes a standard backend free-tier name', () => {
    render(<SubscriptionEmptyState tierName="免费版" tierType="free" onOpenPlans={vi.fn()} />)
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(screen.queryByText('免费版')).not.toBeInTheDocument()
  })

  it('keeps a custom unnamed-tier label when no localized mapping exists', () => {
    render(<SubscriptionEmptyState tierName="后台免费套餐" onOpenPlans={vi.fn()} />)
    expect(screen.getByText('后台免费套餐')).toBeInTheDocument()
  })

  it('calls open plans from empty state', () => {
    const onOpenPlans = vi.fn()
    render(<SubscriptionEmptyState onOpenPlans={onOpenPlans} />)
    fireEvent.click(screen.getByText('Upgrade plan'))
    expect(onOpenPlans).toHaveBeenCalledTimes(1)
  })

  it('renders action button default label', () => {
    render(<SubscriptionActionButton action="new" onClick={vi.fn()} />)
    expect(screen.getByText('Subscribe now')).toBeInTheDocument()
  })
})
