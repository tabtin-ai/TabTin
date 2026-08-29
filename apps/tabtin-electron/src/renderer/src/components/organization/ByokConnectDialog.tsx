import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from 'lucide-react'
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
} from '@components/ui'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL } from '@components/settings/settingsUi'
import { ProviderLogo } from '@components/chat/model/ProviderLogo'
import { getProviderDefaultBaseUrl } from '@/utils/provider-registry'
import { OrganizationLlmApiService } from '@/services/organizationLlmApi'
import { getCustomApiModelRecommendations } from './byok-custom-api-recommendations'
import { provisionByokPlan } from './provision-byok-plan'
import { provisionByokApi } from './provision-byok-api'
import { ByokCodexLoginPanel } from './ByokCodexLoginPanel'
import { ByokScenarioHint } from './byok-scenario-hint'
import { resolveByokApiConnectIdentity, suggestByokConnectionName } from './byok-connection-identity'
import {
  type ByokServiceItem,
  findByokService,
  getByokServiceCatalog,
  resolveLegacyServiceId,
} from './byok-service-catalog'
import { OPENAI_CODEX_BYOK_UI_ENABLED } from '@/utils/featureFlags'
import { canUseOrganizationByokScope } from './byok-organization-scope'

export type ByokConnectDialogMode = 'plan' | 'api'

export interface ByokConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  canManageOrganization: boolean
  isPersonalOrganization?: boolean
  /** @deprecated 仅兼容旧入口；新入口走 initialServiceId */
  mode?: ByokConnectDialogMode
  initialServiceId?: string
  initialTabId?: string
  disabled?: boolean
  existingProviderKeys?: string[]
  onSuccess: (message: string) => void | Promise<void>
}

type WizardStep = 'pick' | 'auth' | 'success'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function ServiceChip(props: {
  item: ByokServiceItem
  label: string
  disabled?: boolean
  onSelect: () => void
}) {
  const { item, label, disabled, onSelect } = props
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-caption text-foreground',
        'hover:border-border hover:bg-muted/30 transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <ProviderLogo
        iconKey={item.iconKey}
        provider={item.providerName}
        className="h-3.5 w-3.5 rounded-[2px]"
      />
      <span>{label}</span>
    </button>
  )
}

export function ByokConnectDialog({
  open,
  onOpenChange,
  organizationId,
  canManageOrganization,
  isPersonalOrganization = false,
  mode,
  initialServiceId,
  initialTabId,
  disabled = false,
  existingProviderKeys = [],
  onSuccess,
}: ByokConnectDialogProps) {
  const { t } = useTranslation('organization')
  const catalog = useMemo(
    () => getByokServiceCatalog(OPENAI_CODEX_BYOK_UI_ENABLED),
    [],
  )
  const resolvedInitialId = initialServiceId
    ?? resolveLegacyServiceId({ mode, tabId: initialTabId })

  const [step, setStep] = useState<WizardStep>('pick')
  const [selectedId, setSelectedId] = useState<string | undefined>(resolvedInitialId)
  const [showMore, setShowMore] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [connectionName, setConnectionName] = useState('')
  const canUseOrgScope = canUseOrganizationByokScope(
    canManageOrganization,
    isPersonalOrganization,
  )
  const [scope, setScope] = useState<'organization' | 'user'>(
    canUseOrgScope ? 'organization' : 'user',
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [successTitle, setSuccessTitle] = useState('')
  const [successModels, setSuccessModels] = useState<string[]>([])
  const [successHint, setSuccessHint] = useState<string | null>(null)

  const selected = selectedId
    ? findByokService(selectedId, OPENAI_CODEX_BYOK_UI_ENABLED)
    : undefined
  const isCodex = selected?.kind === 'chatgpt_codex'
  const isPlan = selected?.kind === 'plan'
  const defaultBaseUrl = selected?.defaultBaseUrl
    ?? (selected?.providerName ? getProviderDefaultBaseUrl(selected.providerName) : '')
  const baseUrlReadOnly = Boolean(selected?.hideBaseUrl)

  const resetForm = () => {
    setApiKey('')
    setConnectionName('')
    setFormError(null)
    setSubmitting(false)
    setSuccessTitle('')
    setSuccessModels([])
    setSuccessHint(null)
    setScope(canUseOrgScope ? 'organization' : 'user')
  }

  useEffect(() => {
    if (!open) return
    resetForm()
    setShowMore(false)
    if (resolvedInitialId) {
      setSelectedId(resolvedInitialId)
      setStep('auth')
    } else {
      setSelectedId(undefined)
      setStep('pick')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在打开时按入口重置
  }, [open, resolvedInitialId, canUseOrgScope])

  useEffect(() => {
    if (!open || isCodex) return
    setBaseUrl(defaultBaseUrl)
  }, [open, selectedId, defaultBaseUrl, isCodex])

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen && !submitting) {
      onOpenChange(false)
    }
  }

  const handleSelectService = (item: ByokServiceItem) => {
    setSelectedId(item.id)
    setApiKey('')
    setConnectionName('')
    setFormError(null)
    setStep('auth')
  }

  const handleBackToPick = () => {
    if (submitting) return
    resetForm()
    setSelectedId(undefined)
    setStep('pick')
  }

  const finishSuccess = async (title: string, models: string[], hint?: string) => {
    setSuccessTitle(title)
    setSuccessModels(models)
    setSuccessHint(hint ?? null)
    setStep('success')
    await onSuccess('')
  }

  const handleSubmit = async () => {
    if (!selected || isCodex) return
    if (!apiKey.trim()) {
      setFormError(t('llm.planConnect.apiKeyRequired'))
      return
    }

    const trimmedBaseUrl = (baseUrlReadOnly ? defaultBaseUrl : baseUrl).trim()
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
    const effectiveScope = canUseOrgScope ? scope : 'user'
    try {
      if (isPlan && selected.preset) {
        const result = await provisionByokPlan({
          organizationId,
          preset: selected.preset,
          apiKey,
          scope: effectiveScope,
          baseUrl: trimmedBaseUrl,
        })
        await probeQuietly(result.providerId)
        await finishSuccess(
          selected.preset.display_name,
          selected.preset.models.map((model) => model.display_name),
        )
        return
      }

      const vendorLabel = t(selected.labelKey)
      const identity = resolveByokApiConnectIdentity({
        providerName: selected.providerName || 'openai',
        baseUrl: trimmedBaseUrl,
        connectionName,
        vendorLabel,
        existingKeys: existingProviderKeys,
        officialBaseUrl: getProviderDefaultBaseUrl(selected.providerName || 'openai'),
      })
      const result = await provisionByokApi({
        organizationId,
        providerName: selected.providerName || 'openai',
        providerKey: identity.providerKey,
        displayName: identity.displayName,
        baseUrl: trimmedBaseUrl,
        apiKey,
        scope: effectiveScope,
      })
      const recommendations = getCustomApiModelRecommendations(selected.providerName || 'openai')
      await probeQuietly(result.providerId)
      await finishSuccess(
        identity.displayName,
        recommendations.map((model) => model.display_name),
      )
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('llm.planConnect.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  const probeQuietly = async (providerId: string) => {
    try {
      await OrganizationLlmApiService.probeProvider(organizationId, providerId)
    } catch {
      // 接入已成功；探测失败不回滚，列表里的「测试」仍可用。
    }
  }

  const recommended = catalog.filter((item) => item.group === 'recommended')
  const more = catalog.filter((item) => item.group === 'more')
  const others = catalog.filter((item) => item.group === 'other')
  const autoModels = isPlan
    ? (selected?.preset?.models ?? []).map((model) => model.display_name)
    : []

  const authTitle = isCodex
    ? t('llm.codex.loginTitle', { defaultValue: '接入 ChatGPT Codex' })
    : isPlan && selected?.preset
      ? t('llm.serviceCatalog.connectTitle', { name: selected.preset.display_name })
      : t('llm.serviceCatalog.connectTitle', { name: selected ? t(selected.labelKey) : '' })

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-start justify-between gap-2 pr-8">
            {step === 'auth' && !resolvedInitialId && (
              <button
                type="button"
                onClick={handleBackToPick}
                disabled={submitting}
                className="mt-0.5 rounded-md p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
                aria-label={t('llm.serviceCatalog.back', { defaultValue: '返回' })}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>
                {step === 'pick' && t('llm.serviceCatalog.pickerTitle', { defaultValue: '添加模型服务' })}
                {step === 'auth' && authTitle}
                {step === 'success' && t('llm.serviceCatalog.successTitle', { defaultValue: '连接成功' })}
              </DialogTitle>
              <DialogDescription>
                {step === 'pick' && t('llm.serviceCatalog.pickerDesc', { defaultValue: '选择要连接的模型服务' })}
                {step === 'auth' && !isCodex && (
                  isPlan
                    ? t('llm.serviceCatalog.planAuthDesc', { defaultValue: '填写 API Key 即可接入，端点与常用模型已预置。' })
                    : t('llm.serviceCatalog.apiAuthDesc', { defaultValue: '填写连接信息后即可在聊天中使用。' })
                )}
                {step === 'auth' && isCodex && t('llm.codex.loginLead', { defaultValue: '使用你的 ChatGPT 账号登录并授权 Codex 能力。' })}
                {step === 'success' && t('llm.serviceCatalog.successAdded', { name: successTitle })}
              </DialogDescription>
            </div>
            <div className="shrink-0">
              <ByokScenarioHint />
            </div>
          </div>
        </DialogHeader>

        <DialogScrollBody className="space-y-4 pt-1">
          {step === 'pick' && (
            <>
              <div className="space-y-2">
                <p className="text-caption font-medium text-muted-foreground">
                  {t('llm.serviceCatalog.recommendedTitle', { defaultValue: '推荐服务' })}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recommended.map((item) => (
                    <ServiceChip
                      key={item.id}
                      item={item}
                      label={t(item.labelKey)}
                      disabled={disabled}
                      onSelect={() => handleSelectService(item)}
                    />
                  ))}
                  {more.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowMore((value) => !value)}
                      className="inline-flex items-center rounded-md border border-dashed border-border/70 px-2.5 py-1.5 text-caption text-muted-foreground hover:border-border hover:text-foreground"
                    >
                      {t('llm.serviceCatalog.moreServices', { defaultValue: '更多服务' })}
                    </button>
                  )}
                </div>
                {showMore && (
                  <div className="flex flex-wrap gap-1.5">
                    {more.map((item) => (
                      <ServiceChip
                        key={item.id}
                        item={item}
                        label={t(item.labelKey)}
                        disabled={disabled}
                        onSelect={() => handleSelectService(item)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-caption font-medium text-muted-foreground">
                  {t('llm.serviceCatalog.otherTitle', { defaultValue: '其他服务' })}
                </p>
                {others.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => handleSelectService(item)}
                    className="w-full rounded-md border border-border/60 bg-background px-3 py-2.5 text-left hover:bg-muted/20 disabled:opacity-50"
                  >
                    <div className="text-body font-medium text-foreground">{t(item.labelKey)}</div>
                    {item.subtitleKey && (
                      <p className="mt-0.5 text-caption text-muted-foreground leading-relaxed">
                        {t(item.subtitleKey)}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 'auth' && isCodex && (
            <div className="space-y-3">
              <ul className="space-y-1.5 text-caption text-muted-foreground leading-relaxed">
                <li>{t('llm.codex.bulletDevice')}</li>
                <li>{t('llm.codex.bulletPersonal')}</li>
                <li>{t('llm.codex.bulletNoShare')}</li>
                <li>{t('llm.codex.bulletRelogin')}</li>
              </ul>
              <ByokCodexLoginPanel
                hideIntro
                disabled={disabled}
                onConnected={async (status) => {
                  await finishSuccess(
                    t('llm.codex.vendorLabel'),
                    status.models.map((model) => model.displayName),
                    t('llm.codex.successPersonal'),
                  )
                }}
              />
            </div>
          )}

          {step === 'auth' && selected && !isCodex && (
            <>
              {formError && <p className="text-body text-destructive">{formError}</p>}

              {autoModels.length > 0 && (
                <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 text-caption text-muted-foreground">
                  <span className="font-medium text-foreground">{t('llm.planConnect.modelsLabel')}</span>
                  {' '}
                  <span>{autoModels.join(' · ')}</span>
                </div>
              )}

              <div className="space-y-3">
                {!isPlan && (
                  <div className="space-y-1.5">
                    <label htmlFor="byok-connection-name" className="text-body text-muted-foreground/80">
                      {t('llm.connectEntries.connectionName')}
                    </label>
                    <Input
                      id="byok-connection-name"
                      className={cn('h-8 text-body', SETTINGS_CONTROL)}
                      value={connectionName}
                      onChange={(event) => setConnectionName(event.target.value)}
                      placeholder={suggestByokConnectionName(
                        t(selected.labelKey),
                        baseUrl || defaultBaseUrl,
                        selected.providerName || 'openai',
                      )}
                      disabled={submitting}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-body text-muted-foreground/80">{t('llm.providers.baseUrl')}</label>
                  <Input
                    className={cn(
                      'h-8 font-mono text-body',
                      SETTINGS_CONTROL,
                      baseUrlReadOnly && 'bg-muted/30 text-muted-foreground',
                    )}
                    value={baseUrl}
                    onChange={(event) => {
                      if (baseUrlReadOnly) return
                      setBaseUrl(event.target.value)
                    }}
                    placeholder={defaultBaseUrl || 'https://your-api.com/v1'}
                    readOnly={baseUrlReadOnly}
                    disabled={submitting}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-body text-muted-foreground/80">{t('llm.providers.apiKey')}</label>
                  <Input
                    className={cn('h-8 text-body', SETTINGS_CONTROL)}
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      selected.preset
                        ? t(selected.preset.api_key_placeholder_key)
                        : t('llm.connectEntries.apiKeyPlaceholderGeneric')
                    }
                    disabled={submitting}
                    autoFocus
                  />
                </div>

                <div className="space-y-2">
                  <p className="text-body text-muted-foreground/80">{t('llm.providers.scope')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <ScopeOption
                      selected={scope === 'user'}
                      disabled={submitting}
                      title={t('llm.providers.scopeUser')}
                      description={t('llm.serviceCatalog.scopePersonalDesc')}
                      onSelect={() => setScope('user')}
                    />
                    <ScopeOption
                      selected={scope === 'organization'}
                      disabled={submitting || !canUseOrgScope}
                      title={t('llm.providers.scopeOrganization')}
                      description={t('llm.serviceCatalog.scopeOrgDesc')}
                      onSelect={() => setScope('organization')}
                    />
                  </div>
                  {!canUseOrgScope && (
                    <p className="text-caption text-muted-foreground/40">
                      {isPersonalOrganization
                        ? t('llm.providers.scopePersonalAccountHint')
                        : t('llm.providers.scopeHint')}
                    </p>
                  )}
                </div>

              </div>
            </>
          )}

          {step === 'success' && (
            <div className="space-y-3">
              {successModels.length > 0 ? (
                <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5">
                  <p className="text-caption font-medium text-foreground">
                    {t('llm.serviceCatalog.successLoaded', { count: successModels.length })}
                  </p>
                  <p className="mt-1 text-caption text-muted-foreground">{successModels.join(' · ')}</p>
                </div>
              ) : (
                <p className="text-caption text-muted-foreground">
                  {t('llm.connectEntries.apiConnectSuccessNoModels')}
                </p>
              )}
              {successHint && (
                <p className="text-caption text-muted-foreground">{successHint}</p>
              )}
            </div>
          )}
        </DialogScrollBody>

        {step === 'auth' && isCodex && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)}>
              {t('llm.providers.cancel')}
            </Button>
          </DialogFooter>
        )}

        {step === 'auth' && !isCodex && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)} disabled={submitting}>
              {t('llm.providers.cancel')}
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting || disabled || !apiKey.trim()}>
              {submitting
                ? t('llm.planConnect.provisioning')
                : t('llm.serviceCatalog.testAndAdd', { defaultValue: '测试并添加' })}
            </Button>
          </DialogFooter>
        )}

        {step === 'success' && (
          <DialogFooter>
            <Button onClick={() => handleClose(false)}>
              {t('llm.serviceCatalog.done', { defaultValue: '完成' })}
            </Button>
          </DialogFooter>
        )}

        {step === 'pick' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)}>
              {t('llm.providers.cancel')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ScopeOption(props: {
  selected: boolean
  disabled?: boolean
  title: string
  description: string
  onSelect: () => void
}) {
  const { selected, disabled, title, description, onSelect } = props
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'rounded-md border px-3 py-2 text-left transition-colors',
        selected ? 'border-accent/50 bg-accent/5' : 'border-border/50 bg-background hover:bg-muted/20',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-background',
      )}
    >
      <div className="text-body font-medium text-foreground">{title}</div>
      <div className="mt-0.5 text-caption text-muted-foreground">{description}</div>
    </button>
  )
}
