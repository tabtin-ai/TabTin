import React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogScrollBody, DialogTitle, ScrollArea, StatusNotice } from '@tabtin/smartsheet-ui'
import type { SubscriptionPlan } from '@/types/membership'
import { SettingsBadge } from '../SettingsBadge'
import { SubscriptionActionButton } from './SubscriptionActionButton'
import {
  formatCreditsDisplay,
  formatPriceDisplay,
  formatQuota,
  formatStorageQuota,
  resolveTierDisplayName,
} from './subscriptionFormat'

const TABTIN_WEBSITE_URL = 'https://www.example.com/'

export const SubscriptionPlanDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  plans: SubscriptionPlan[]
  loading?: boolean
  error?: string
  canManageOrganization: boolean
  loadingPlanId?: string | null
  onSelectPlan: (plan: SubscriptionPlan) => void
}> = ({ open, onOpenChange, plans, loading = false, error = '', canManageOrganization, loadingPlanId, onSelectPlan }) => {
  const { t } = useTranslation('settings')
  const creditsUnit = t('membership.units.credits')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[980px]">
        <DialogHeader>
          <DialogTitle>{t('membership.planDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('membership.planDialog.descriptionPrefix')}
            <a
              href={TABTIN_WEBSITE_URL}
              onClick={(event) => {
                event.preventDefault()
                void window.tabtin.openExternal(TABTIN_WEBSITE_URL)
              }}
              className="text-primary underline-offset-4 hover:underline"
            >
              {t('membership.planDialog.websiteLabel')}
            </a>
            {t('membership.planDialog.descriptionSuffix')}
          </DialogDescription>
        </DialogHeader>

        {error ? <StatusNotice tone="danger" description={error} /> : null}
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-80 animate-pulse rounded-[16px] bg-muted/30" />
            ))}
          </div>
        ) : (
          <DialogScrollBody>
            <ScrollArea scrollBar="horizontal" className="pb-2">
              <div className="grid min-w-[780px] grid-cols-3 gap-3">
                {plans.map((plan) => (
                  <div
                    key={plan.id}
                    className={`flex min-h-[360px] flex-col rounded-[16px] border p-4 ${
                      plan.current ? 'border-primary bg-primary/5' : 'border-border bg-background'
                    }`}
                  >
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div>
                        <div className="text-title font-semibold text-foreground">
                          {resolveTierDisplayName(
                            plan.name,
                            plan.tier_type,
                            (tierType) => t(`membership.tierNames.${tierType}`, { defaultValue: '' }),
                            t('membership.currentSubscription.currentPlan'),
                          )}
                        </div>
                        <div className="mt-1 text-title font-semibold text-foreground">
                          {formatPriceDisplay(plan.monthly_price)}
                        </div>
                        <div className="text-body text-muted-foreground">{t('membership.billingCycle.monthly')}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {plan.current && <SettingsBadge tone="accent">{t('membership.planDialog.current')}</SettingsBadge>}
                        {plan.recommended && <SettingsBadge tone="success">{t('membership.planDialog.recommended')}</SettingsBadge>}
                      </div>
                    </div>

                    <div className="flex-1 space-y-2 text-body">
                      <PlanRow label={t('membership.entitlements.llmCredits')} value={formatCreditsDisplay(plan.entitlements.included_credits, creditsUnit)} />
                      <PlanRow label={t('membership.entitlements.members')} value={formatQuota(plan.entitlements.max_members, t('membership.entitlements.unlimited'))} />
                      <PlanRow label={t('membership.entitlements.storage')} value={formatStorageQuota(plan.entitlements.storage_bytes, t('membership.entitlements.unlimited'))} />
                      <PlanRow label={t('membership.entitlements.documents')} value={formatQuota(plan.entitlements.max_documents, t('membership.entitlements.unlimited'))} />
                      <PlanRow label={t('membership.entitlements.tables')} value={formatQuota(plan.entitlements.max_tables, t('membership.entitlements.unlimited'))} />
                      <PlanRow label={t('membership.entitlements.groups')} value={formatQuota(plan.entitlements.max_groups, t('membership.entitlements.unlimited'))} />
                    </div>

                    <SubscriptionActionButton
                      action={plan.action}
                      label={plan.button?.label}
                      current={plan.current}
                      disabled={!canManageOrganization || plan.button?.disabled}
                      loading={loadingPlanId === plan.id}
                      onClick={() => onSelectPlan(plan)}
                    />
                  </div>
                ))}
              </div>
            </ScrollArea>
          </DialogScrollBody>
        )}
      </DialogContent>
    </Dialog>
  )
}

const PlanRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-3">
    <span className="text-muted-foreground">{label}</span>
    <span className="text-right text-foreground">{value}</span>
  </div>
)

SubscriptionPlanDialog.displayName = 'SubscriptionPlanDialog'
