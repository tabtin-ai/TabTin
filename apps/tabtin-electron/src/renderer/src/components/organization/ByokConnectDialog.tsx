import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollBody,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL } from '@components/settings/settingsUi'
import { ProviderLogo } from '@components/chat/model/ProviderLogo'
import { getProviderDefaultBaseUrl } from '@/utils/provider-registry'
import { getCustomApiModelRecommendations } from './byok-custom-api-recommendations'
import { provisionByokPlan } from './provision-byok-plan'
import { provisionByokApi } from './provision-byok-api'
import { ByokScenarioHint } from './byok-scenario-hint'
import { ByokCodexLoginPanel } from './ByokCodexLoginPanel'
import {
  buildByokApiChannels,
  buildByokPlanChannels,
  DEFAULT_BYOK_API_TAB_ID,
  DEFAULT_BYOK_PLAN_TAB_ID,
  findByokApiChannel,
  findByokPlanChannel,
} from './byok-connect-channels'

export type ByokConnectDialogMode = 'plan' | 'api'

export interface ByokConnectDialogProps {
  mode: ByokConnectDialogMode
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  canManageOrganization: boolean
  initialTabId?: string
  disabled?: boolean
  onSuccess: (message: string) => void
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function ByokConnectDialog({
  mode,
  open,
  onOpenChange,
  organizationId,
  canManageOrganization,
  initialTabId,
  disabled = false,
  onSuccess,
}: ByokConnectDialogProps) {
  const { t } = useTranslation('organization')
  const planChannels = useMemo(() => buildByokPlanChannels(), [])
  const apiChannels = useMemo(() => buildByokApiChannels(), [])
  const recommendedLabel = t('llm.connectEntries.recommendedBadge')

  const defaultTabId = mode === 'plan' ? DEFAULT_BYOK_PLAN_TAB_ID : DEFAULT_BYOK_API_TAB_ID
  const resolvedInitialTabId = initialTabId ?? defaultTabId

  const [activeTabId, setActiveTabId] = useState(resolvedInitialTabId)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [scope, setScope] = useState<'organization' | 'user'>('organization')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const activeSubscriptionChannel = mode === 'plan'
    ? findByokPlanChannel(planChannels, activeTabId) ?? planChannels[0]
    : undefined
  const activePlan = activeSubscriptionChannel?.kind === 'plan'
    ? activeSubscriptionChannel
    : undefined
  const activeCodex = activeSubscriptionChannel?.kind === 'chatgpt_codex'
    ? activeSubscriptionChannel
    : undefined
  const activeApi = mode === 'api'
    ? findByokApiChannel(apiChannels, activeTabId) ?? apiChannels[0]
    : undefined

  const defaultBaseUrl = activePlan?.preset.base_url
    ?? (activeApi ? getProviderDefaultBaseUrl(activeApi.providerName) : '')

  useEffect(() => {
    if (!open) return
    setActiveTabId(resolvedInitialTabId)
    setApiKey('')
    setFormError(null)
    setScope(canManageOrganization ? 'organization' : 'user')
  }, [open, resolvedInitialTabId, canManageOrganization])

  useEffect(() => {
    if (!open || activeCodex) return
    setBaseUrl(defaultBaseUrl)
  }, [open, activeTabId, mode, defaultBaseUrl, activeCodex])

  const handleTabChange = (tabId: string) => {
    setActiveTabId(tabId)
    setApiKey('')
    setFormError(null)
  }

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen && !submitting) {
      onOpenChange(false)
    }
  }

  const handleSubmit = async () => {
    if (!apiKey.trim()) {
      setFormError(t('llm.planConnect.apiKeyRequired'))
      return
    }

    const trimmedBaseUrl = baseUrl.trim()
    if (!trimmedBaseUrl) {
      setFormError(t('llm.connectEntries.apiBaseUrlMissing'))
      return
    }
    if (!isHttpUrl(trimmedBaseUrl)) {
      setFormError(t('llm.providers.validation.baseUrlInvalid'))
      return
    }

    setFormError(null)
    setSubmitting(true)
    try {
      if (mode === 'plan') {
        const channel = findByokPlanChannel(planChannels, activeTabId) ?? planChannels[0]
        if (!channel || channel.kind !== 'plan') return
        const preset = channel.preset
        const result = await provisionByokPlan({
          organizationId,
          preset,
          apiKey,
          scope,
          baseUrl: trimmedBaseUrl,
        })
        onOpenChange(false)
        onSuccess(
          result.modelsCreated > 0
            ? t('llm.planConnect.success', { count: result.modelsCreated, name: preset.display_name })
            : t('llm.connectEntries.apiConnectSuccessNoModels'),
        )
        return
      }

      const channel = findByokApiChannel(apiChannels, activeTabId) ?? apiChannels[0]
      if (!channel) return

      const result = await provisionByokApi({
        organizationId,
        providerName: channel.providerName,
        baseUrl: trimmedBaseUrl,
        apiKey,
        scope,
      })

      onOpenChange(false)
      if (result.modelsCreated > 0) {
        onSuccess(t('llm.connectEntries.apiConnectSuccess', { count: result.modelsCreated }))
      } else {
        onSuccess(t('llm.connectEntries.apiConnectSuccessNoModels'))
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('llm.planConnect.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  if (mode === 'plan' && !activeSubscriptionChannel) return null
  if (mode === 'api' && !activeApi) return null

  const planPreset = activePlan?.preset
  const apiRecommendations = activeApi
    ? getCustomApiModelRecommendations(activeApi.providerName)
    : []

  const titleKey = mode === 'plan'
    ? 'llm.connectEntries.planFormTitle'
    : 'llm.connectEntries.apiFormTitle'
  const descKey = mode === 'plan'
    ? 'llm.connectEntries.planFormDesc'
    : 'llm.connectEntries.apiFormDesc'

  const description = planPreset
    ? t(planPreset.connectDescKey)
    : activeApi
      ? t(activeApi.subtitleKey)
      : ''

  const apiKeyPlaceholder = planPreset
    ? t(planPreset.api_key_placeholder_key)
    : t('llm.connectEntries.apiKeyPlaceholderGeneric')

  const apiKeyHint = planPreset
    ? t(planPreset.apiKeyHintKey)
    : t('llm.connectEntries.apiKeyHintGeneric')

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          {/* pr-8：给 DialogContent 右上角绝对定位关闭钮留位，避免「场景说明」被挤成竖排 */}
          <div className="flex items-start justify-between gap-3 pr-8">
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>{t(titleKey)}</DialogTitle>
              <DialogDescription>{t(descKey)}</DialogDescription>
            </div>
            <div className="shrink-0">
              <ByokScenarioHint />
            </div>
          </div>
        </DialogHeader>

        <TabsRoot value={activeTabId} onValueChange={handleTabChange}>
          <TabsList className="h-auto w-full max-w-full justify-start gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1">
            {mode === 'plan' && planChannels.map((channel) => {
              const recommended = channel.kind === 'plan' && channel.preset.recommended
              return (
                <TabsTrigger
                  key={channel.tabId}
                  value={channel.tabId}
                  disabled={disabled || submitting}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-caption',
                    recommended && 'data-[state=active]:ring-1 data-[state=active]:ring-amber-500/30',
                  )}
                >
                  <ProviderLogo
                    {...(channel.kind === 'plan'
                      ? { iconKey: channel.preset.icon_key }
                      : { provider: 'openai' })}
                    className="h-3.5 w-3.5 rounded-[2px]"
                  />
                  <span>{t(channel.kind === 'plan' ? channel.preset.vendorLabelKey : channel.vendorLabelKey)}</span>
                  {recommended && (
                    <span className="rounded px-1 py-px text-[10px] font-medium leading-none bg-amber-500/15 text-amber-700 dark:text-amber-300">
                      {recommendedLabel}
                    </span>
                  )}
                </TabsTrigger>
              )
            })}
            {mode === 'api' && apiChannels.map((channel) => (
              <TabsTrigger
                key={channel.tabId}
                value={channel.tabId}
                disabled={disabled || submitting}
                className="inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-caption"
              >
                <ProviderLogo provider={channel.providerName} className="h-3.5 w-3.5 rounded-[2px]" />
                <span>{t(channel.vendorLabelKey)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </TabsRoot>

        <DialogScrollBody className="space-y-4 pt-1">
          {activeCodex ? (
            <ByokCodexLoginPanel
              disabled={disabled}
              onConnected={async () => {
                onOpenChange(false)
                onSuccess(t('llm.codex.connectedSuccess'))
              }}
            />
          ) : (
            <>
              {formError && <p className="text-body text-destructive">{formError}</p>}
              <p className="text-caption text-muted-foreground leading-relaxed">{description}</p>
              <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 space-y-2 text-caption text-muted-foreground">
                {((planPreset?.models.length ?? 0) > 0 || apiRecommendations.length > 0) && (
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{t('llm.planConnect.modelsLabel')}</span>
                    {' '}
                    <span className="inline-block max-w-full overflow-x-auto align-bottom whitespace-nowrap">
                      {planPreset
                        ? planPreset.models.map((model) => model.display_name).join(' · ')
                        : apiRecommendations.map((model) => model.display_name).join(' · ')}
                    </span>
                  </div>
                )}
                {planPreset && (
                  <a
                    href={planPreset.docs_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-accent hover:underline"
                  >
                    {t(planPreset.docsLinkKey)}
                  </a>
                )}
              </div>

              <div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 space-y-1.5">
                    <label className="text-body text-muted-foreground/80">{t('llm.providers.baseUrl')}</label>
                    <Input
                      className={cn('h-8 font-mono text-body', SETTINGS_CONTROL)}
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={defaultBaseUrl || 'https://api.openai.com/v1'}
                      disabled={submitting}
                    />
                    <p className="text-caption text-muted-foreground/60">
                      {t('llm.connectEntries.baseUrlEditableHint')}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-body text-muted-foreground/80">{t('llm.providers.scope')}</label>
                    <Select
                      value={scope}
                      onValueChange={(value) => setScope(value as 'organization' | 'user')}
                      disabled={submitting}
                    >
                      <SelectTrigger className={cn('h-8 text-body', SETTINGS_CONTROL)}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="organization" disabled={!canManageOrganization}>
                          {t('llm.providers.scopeOrganization')}
                        </SelectItem>
                        <SelectItem value="user">{t('llm.providers.scopeUser')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {!canManageOrganization && (
                      <p className="text-caption text-muted-foreground/40">{t('llm.providers.scopeHint')}</p>
                    )}
                  </div>
                  <div className="col-span-2 space-y-1.5">
                    <label className="text-body text-muted-foreground/80">{t('llm.providers.apiKey')}</label>
                    <Input
                      className={cn('h-8 text-body', SETTINGS_CONTROL)}
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={apiKeyPlaceholder}
                      disabled={submitting}
                      autoFocus
                    />
                    <p className="text-caption text-muted-foreground/60">{apiKeyHint}</p>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogScrollBody>

        {!activeCodex && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)} disabled={submitting}>
              {t('llm.providers.cancel')}
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting || disabled || !apiKey.trim()}>
              {submitting ? t('llm.planConnect.provisioning') : t('llm.planConnect.submit')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
