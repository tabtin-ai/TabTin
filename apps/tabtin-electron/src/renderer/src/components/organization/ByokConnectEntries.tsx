import { forwardRef, useImperativeHandle, useState } from 'react'
import { CalendarClock, ChevronRight, KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { ProviderLogo } from '@components/chat/model/ProviderLogo'
import { BYOK_PLAN_PRESETS } from './byok-plan-presets'
import { BYOK_API_PROVIDER_OPTIONS } from './byok-api-provider-options'
import { ByokConnectDialog } from './ByokConnectDialog'
import { DEFAULT_BYOK_API_TAB_ID, DEFAULT_BYOK_PLAN_TAB_ID } from './byok-connect-channels'
import { OPENAI_CODEX_BYOK_UI_ENABLED } from '@/utils/featureFlags'

export interface ByokConnectEntriesHandle {
  openPlan: (presetId?: string) => void
  openApi: (providerName?: string) => void
}

interface ByokConnectEntriesProps {
  organizationId: string
  canManageOrganization: boolean
  disabled?: boolean
  onSuccess: (message: string) => void
}

function VendorChip(props: {
  label: string
  iconKey?: string
  provider?: string
  recommended?: boolean
  recommendedLabel?: string
}) {
  const { label, iconKey, provider, recommended, recommendedLabel } = props
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-caption leading-none',
        recommended
          ? 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200'
          : 'border-border/50 bg-muted/30 text-muted-foreground',
      )}
    >
      <ProviderLogo iconKey={iconKey} provider={provider} className="h-3.5 w-3.5 rounded-[2px]" />
      {label}
      {recommended && recommendedLabel && (
        <span className="font-medium text-amber-700 dark:text-amber-300">{recommendedLabel}</span>
      )}
    </span>
  )
}

export const ByokConnectEntries = forwardRef<ByokConnectEntriesHandle, ByokConnectEntriesProps>(
  function ByokConnectEntries(props, ref) {
    const {
      organizationId,
      canManageOrganization,
      disabled = false,
      onSuccess,
    } = props
    const { t } = useTranslation('organization')
    const [planDialogOpen, setPlanDialogOpen] = useState(false)
    const [apiDialogOpen, setApiDialogOpen] = useState(false)
    const [planTabId, setPlanTabId] = useState(DEFAULT_BYOK_PLAN_TAB_ID)
    const [apiTabId, setApiTabId] = useState(DEFAULT_BYOK_API_TAB_ID)

    const recommendedLabel = t('llm.connectEntries.recommendedBadge')

    useImperativeHandle(ref, () => ({
      openPlan: (presetId?: string) => {
        setPlanTabId(presetId ?? DEFAULT_BYOK_PLAN_TAB_ID)
        setPlanDialogOpen(true)
      },
      openApi: (providerName?: string) => {
        setApiTabId(providerName ?? DEFAULT_BYOK_API_TAB_ID)
        setApiDialogOpen(true)
      },
    }))

    return (
      <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setPlanTabId(DEFAULT_BYOK_PLAN_TAB_ID)
              setPlanDialogOpen(true)
            }}
            className={cn(
              'rounded-lg border border-border/60 bg-card p-4 text-left transition-colors',
              'hover:border-sky-500/40 hover:bg-sky-500/5 disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <CalendarClock className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <div className="text-body font-semibold text-foreground">{t('llm.connectEntries.planCategoryTitle')}</div>
                  <p className="mt-1 text-caption text-muted-foreground leading-relaxed">{t('llm.connectEntries.planCategorySubtitle')}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {BYOK_PLAN_PRESETS.map((preset) => (
                    <VendorChip
                      key={preset.id}
                      iconKey={preset.icon_key}
                      label={t(preset.vendorLabelKey)}
                      recommended={preset.recommended}
                      recommendedLabel={preset.recommended ? recommendedLabel : undefined}
                    />
                  ))}
                  {OPENAI_CODEX_BYOK_UI_ENABLED && (
                    <>
                      <VendorChip provider="openai" label={t('llm.codex.openAiChip')} />
                      <VendorChip provider="openai" label={t('llm.codex.codexChip')} />
                    </>
                  )}
                </div>
                <p className="text-caption text-sky-700 dark:text-sky-300">{t('llm.connectEntries.planCategoryAction')}</p>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />
            </div>
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setApiTabId(DEFAULT_BYOK_API_TAB_ID)
              setApiDialogOpen(true)
            }}
            className={cn(
              'rounded-lg border border-border/60 bg-card p-4 text-left transition-colors',
              'hover:border-emerald-500/40 hover:bg-emerald-500/5 disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <KeyRound className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <div className="text-body font-semibold text-foreground">{t('llm.connectEntries.apiCategoryTitle')}</div>
                  <p className="mt-1 text-caption text-muted-foreground leading-relaxed">{t('llm.connectEntries.apiCategorySubtitle')}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {BYOK_API_PROVIDER_OPTIONS.map((option) => (
                    <VendorChip
                      key={option.provider_name}
                      provider={option.provider_name}
                      label={t(option.vendorLabelKey)}
                    />
                  ))}
                </div>
                <p className="text-caption text-emerald-700 dark:text-emerald-300">{t('llm.connectEntries.apiCategoryAction')}</p>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />
            </div>
          </button>
        </div>

        <ByokConnectDialog
          mode="plan"
          open={planDialogOpen}
          onOpenChange={setPlanDialogOpen}
          organizationId={organizationId}
          canManageOrganization={canManageOrganization}
          initialTabId={planTabId}
          disabled={disabled}
          onSuccess={onSuccess}
        />

        <ByokConnectDialog
          mode="api"
          open={apiDialogOpen}
          onOpenChange={setApiDialogOpen}
          organizationId={organizationId}
          canManageOrganization={canManageOrganization}
          initialTabId={apiTabId}
          disabled={disabled}
          onSuccess={onSuccess}
        />
      </>
    )
  },
)
