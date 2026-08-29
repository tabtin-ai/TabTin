import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, Plus, Power, Search, Trash2, X } from 'lucide-react'
import {
  Button, ConfirmDialog, Input, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator,
  SelectTrigger, SelectValue, Switch, toast,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogScrollBody,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import type {
  OrganizationLlmProvider,
  OrganizationLlmModel,
  OrganizationProviderCreatePayload,
  OrganizationModelCreatePayload,
  OrganizationModelSearchResult,
  SubagentModelPolicy,
} from '@/types/llm-organization'
import { OrganizationLlmApiService } from '@/services/organizationLlmApi'
import { useChatModelStore } from '@stores/useChatModelStore'
import { SETTINGS_CONTROL } from '@components/settings/settingsUi'
import { SettingsSectionCard } from '@components/settings/SettingsSectionCard'
import { SettingsRow, SettingsRowGroup } from '@components/settings/SettingsRow'
import { SettingsLink } from '@components/settings/SettingsLink'
import { ChipTabBar } from '@components/common/ChipTabBar'
import { cn } from '@utils/cn'
import {
  getAvailableProviders,
  getProviderApiKeyRequired,
  getProviderDefaultBaseUrl,
  getProviderShortLabel,
  hasProviderMetas,
} from '@/utils/provider-registry'
import { formatLlmProbeErrorLine } from '@/utils/formatLlmProbeError'
import {
  resolveProviderConnectivityStatus,
  resolveProviderDegradedReason,
} from './providerConnectivityStatus'
import { ByokConnectEntries, type ByokConnectEntriesHandle } from './ByokConnectEntries'
import {
  BYOK_PROVIDER_KEY_PATTERN,
  buildByokProviderKey,
  suggestByokConnectionName,
} from './byok-connection-identity'
import { findPlanPresetByProviderKey } from './byok-service-catalog'
import { modelMatchesChannel } from './byok-channel-model-search'
import { ByokScenarioHint } from './byok-scenario-hint'
import { getCustomApiModelRecommendations, type ByokCustomApiModelRecommendation } from './byok-custom-api-recommendations'
import type { OpenAICodexStatus } from './ByokCodexLoginPanel'
import { OPENAI_CODEX_BYOK_UI_ENABLED } from '@/utils/featureFlags'
import {
  canUseAsPersonalDefault,
  canUseAsWorkspaceDefault,
  ensureCustomChatJsonCapability,
} from './organizationModelCapabilities'
import {
  groupModelsBySourceAndProvider,
  MODEL_SOURCE_DEFAULT_LABELS,
} from '@/components/chat/model/modelSourceGrouping'
import { isOpenAICodexModel } from '../../../../shared/openai-codex-models'
import {
  loadOrganizationDeviceModelPreferences,
  saveOrganizationDeviceModelPreferences,
  type OrganizationDeviceModelPreferences,
} from '@/stores/chat/session/organizationDeviceModelPreference'
import { canUseOrganizationByokScope } from './byok-organization-scope'

const PROVIDER_KEY_PATTERN = BYOK_PROVIDER_KEY_PATTERN
const CHAT_MODES = new Set([undefined, null, '', 'chat', 'llm', 'completion', 'response'])
const PRESET_MODEL_PREVIEW_LIMIT = 3
const SERVICE_MODEL_PREVIEW_LIMIT = 4
const USER_DEFAULT_MODEL_INHERIT_VALUE = '__inherit_team_default__'
const SUBAGENT_FOLLOW_TEAM_VALUE = '__subagent_follow_team__'
const SUBAGENT_FOLLOW_MAIN_VALUE = '__subagent_follow_main__'
const SUBAGENT_MODEL_VALUE_PREFIX = 'model:'
/** BYOK 新建模型表单默认上下文窗口（与 agent-runtime DEFAULT_CONTEXT_WINDOW 对齐） */
const DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS = 200_000
const DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS_INPUT = String(DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS)

function isChatModel(model: OrganizationLlmModel): boolean {
  const domain = model.capability_domain ?? model.mode
  return CHAT_MODES.has(domain)
}

function isProviderRoutingEnabled(provider: OrganizationLlmProvider): boolean {
  return provider.routing_enabled ?? provider.is_active ?? true
}

function isModelProviderRoutingEnabled(model: OrganizationLlmModel): boolean {
  return model.provider_routing_enabled ?? model.provider_is_active ?? true
}

function isModelReady(model: OrganizationLlmModel): boolean {
  return model.wave_status == null || model.wave_status === '' || model.wave_status === 'ready'
}

function isModelEnabled(model: OrganizationLlmModel): boolean {
  return isModelProviderRoutingEnabled(model) && isModelReady(model) && model.is_active !== false
}

function isProviderKeyUsable(key: import('@/types/llm-organization').ProviderKeyInfo): boolean {
  return key.is_active ?? key.is_usable
}

function VisibilityLabel({ scope }: { scope: 'global' | 'organization' | 'user' | string | null | undefined }) {
  const { t } = useTranslation('organization')
  if (scope === 'organization') {
    return <span className="text-caption text-muted-foreground">{t('llm.providers.visibilityOrg')}</span>
  }
  if (scope === 'user') {
    return <span className="text-caption text-muted-foreground">{t('llm.providers.visibilityUser')}</span>
  }
  return null
}

function formatServiceEndpoint(url?: string | null): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

function getServiceProtocolLabel(
  provider: OrganizationLlmProvider,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const plan = findPlanPresetByProviderKey(provider.provider_key)
  if (plan) return translate(plan.vendorLabelKey)
  if (provider.name === 'openai') {
    return translate('llm.serviceCatalog.openaiCompatible.label')
  }
  return getProviderShortLabel(provider.name, provider.display_name)
}

/**
 * 应用范围说明区 —— Provider 详情抽屉常驻；按 scope 显示对应 byokScopeWarning。
 */
function ByokScopeNotice({ scope }: { scope: 'global' | 'organization' | 'user' | string | null | undefined }) {
  const { t } = useTranslation('organization')
  if (scope !== 'organization' && scope !== 'user') return null
  const text = scope === 'organization'
    ? t('modelSettings.byokScopeWarning.organization')
    : t('modelSettings.byokScopeWarning.user')
  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 flex items-start gap-2">
      <Info className="h-3 w-3 text-amber-600 flex-shrink-0 mt-0.5" />
      <p className="text-caption text-amber-700/90 dark:text-amber-200/90 leading-relaxed">
        {text}
      </p>
    </div>
  )
}

interface OrganizationModelSettingsProps {
  organizationId: string
  canManageOrganization: boolean
  isPersonalOrganization?: boolean
}

export const OrganizationModelSettings: React.FC<OrganizationModelSettingsProps> = ({
  organizationId,
  canManageOrganization,
  isPersonalOrganization = false,
}) => {
  const { t } = useTranslation('organization')
  const canUseOrgScope = canUseOrganizationByokScope(
    canManageOrganization,
    isPersonalOrganization,
  )
  const refreshChatModels = useChatModelStore((state) => state.loadModels)
  const [providers, setProviders] = useState<OrganizationLlmProvider[]>([])
  const [models, setModels] = useState<OrganizationLlmModel[]>([])
  const [organizationDefaultModelId, setOrganizationDefaultModelId] = useState('')
  const [userDefaultModelId, setUserDefaultModelId] = useState('')
  const [deviceMainModelId, setDeviceMainModelId] = useState('')
  const [defaultConfigScope, setDefaultConfigScope] = useState<'user' | 'organization'>('user')
  const [userSubagentModelPolicy, setUserSubagentModelPolicy] = useState<SubagentModelPolicy>('inherit')
  const [userSubagentModelId, setUserSubagentModelId] = useState('')
  const [organizationSubagentModelPolicy, setOrganizationSubagentModelPolicy] = useState<'inherit' | 'fixed'>('inherit')
  const [organizationSubagentModelId, setOrganizationSubagentModelId] = useState('')
  const [deviceSubagentModelId, setDeviceSubagentModelId] = useState('')
  const [loading, setLoading] = useState(false)
  const [savingSubagentModel, setSavingSubagentModel] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [openAICodexStatus, setOpenAICodexStatus] = useState<OpenAICodexStatus>({
    connected: false,
    models: [],
  })

  const [providerFormOpen, setProviderFormOpen] = useState(false)
  const [modelFormOpen, setModelFormOpen] = useState(false)
  const [presetModelsExpanded, setPresetModelsExpanded] = useState(false)
  const suppressCreateDialogUntilRef = useRef(0)
  const byokConnectRef = useRef<ByokConnectEntriesHandle>(null)

  const [providerName, setProviderName] = useState('openai')
  const [providerKey, setProviderKey] = useState('')
  const [providerKeyTouched, setProviderKeyTouched] = useState(false)
  const [providerDisplayName, setProviderDisplayName] = useState('')
  const [providerBaseUrl, setProviderBaseUrl] = useState('')
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerScope, setProviderScope] = useState<'organization' | 'user'>(
    canUseOrgScope ? 'organization' : 'user',
  )
  const [creatingProvider, setCreatingProvider] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [providerFormError, setProviderFormError] = useState<string | null>(null)
  const [validatingProviderId, setValidatingProviderId] = useState<string | null>(null)
  const [providerProbeResults, setProviderProbeResults] = useState<Record<string, { type: 'success' | 'error'; message: string }>>({})

  const [modelProviderId, setModelProviderId] = useState('')
  const [modelProviderLocked, setModelProviderLocked] = useState(false)
  const [modelName, setModelName] = useState('')
  const [modelDisplayName, setModelDisplayName] = useState('')
  const [modelBaseUrl, setModelBaseUrl] = useState('')
  const [modelMaxTokens, setModelMaxTokens] = useState(DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS_INPUT)
  const [modelSupportsVision, setModelSupportsVision] = useState(false)
  const [modelSupportsStreaming, setModelSupportsStreaming] = useState(true)
  const [modelSupportsFunctionCalling, setModelSupportsFunctionCalling] = useState(true)
  const [modelCapabilitiesConfig, setModelCapabilitiesConfig] = useState<Record<string, unknown>>({})
  const [modelAdvancedOpen, setModelAdvancedOpen] = useState(false)
  const [providerAdvancedOpen, setProviderAdvancedOpen] = useState(false)
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(null)
  const [moreActionsId, setMoreActionsId] = useState<string | null>(null)
  const [creatingModel, setCreatingModel] = useState(false)
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [modelFormError, setModelFormError] = useState<string | null>(null)
  const [modelSearchKeyword, setModelSearchKeyword] = useState('')
  const [modelSearchResults, setModelSearchResults] = useState<OrganizationModelSearchResult[]>([])
  const [searchingModels, setSearchingModels] = useState(false)

  const [savingOrganizationDefault, setSavingOrganizationDefault] = useState(false)
  const [savingUserDefault, setSavingUserDefault] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean
    type: 'provider' | 'model' | 'key'
    target: OrganizationLlmProvider | OrganizationLlmModel | { id: string; label: string; provider_id: string } | null
  }>({ open: false, type: 'provider', target: null })

  // 密钥管理 state
  const [providerKeys, setProviderKeys] = useState<import('@/types/llm-organization').ProviderKeyInfo[]>([])
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [newKeyApiKey, setNewKeyApiKey] = useState('')
  const [newKeyPriority, setNewKeyPriority] = useState('0')
  const [addingKey, setAddingKey] = useState(false)

  const availableModelProviders = useMemo(
    () => providers.filter((provider) => provider.scope !== 'global'),
    [providers]
  )
  const existingProviderKeys = useMemo(
    () => providers.map((provider) => provider.provider_key).filter(Boolean),
    [providers],
  )

  // BYOK「提供商」类型下拉读全局 providerMetas，该数据仅由 chat 模型目录加载
  // （useChatModelStore.loadModels → /catalog）填充。用户可能未经聊天直接进本设置页，
  // 此时 providerMetas 为空 → 下拉空。这里挂载时兜底触发一次加载，并订阅 store 让加载
  // 完成后重渲染（getAvailableProviders 是渲染期读全局变量、非响应式）。
  const chatModelsLoaded = useChatModelStore((state) => state.availableModels.length > 0)
  useEffect(() => {
    if (!hasProviderMetas()) {
      void refreshChatModels(organizationId)
    }
  }, [organizationId, refreshChatModels])
  const providerTypeOptions = useMemo(
    () => getAvailableProviders(),
    [chatModelsLoaded],
  )

  const visibleModels = useMemo(
    () => models.filter(isChatModel),
    [models]
  )

  const customModels = useMemo(
    () => visibleModels.filter((m) => m.provider_scope !== 'global'),
    [visibleModels]
  )

  const customProviders = useMemo(
    () => providers.filter((provider) => provider.scope !== 'global'),
    [providers],
  )

  const modelsByProviderId = useMemo(() => {
    const grouped = new Map<string, OrganizationLlmModel[]>()
    for (const model of customModels) {
      const providerId = model.provider_id
      if (!providerId) continue
      const bucket = grouped.get(providerId) ?? []
      bucket.push(model)
      grouped.set(providerId, bucket)
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name))
    }
    return grouped
  }, [customModels])

  const systemModels = useMemo(
    () => visibleModels
      .filter((m) => m.provider_scope === 'global')
      .sort((a, b) => {
        const enabledDiff = Number(isModelEnabled(b)) - Number(isModelEnabled(a))
        if (enabledDiff !== 0) return enabledDiff
        return (a.display_name || a.name).localeCompare(b.display_name || b.name)
      }),
    [visibleModels]
  )

  const previewSystemModels = useMemo(
    () => presetModelsExpanded ? systemModels : systemModels.slice(0, PRESET_MODEL_PREVIEW_LIMIT),
    [presetModelsExpanded, systemModels],
  )

  const currentOrganizationDefaultModel = useMemo(
    () => visibleModels.find((model) => model.id === organizationDefaultModelId) ?? null,
    [organizationDefaultModelId, visibleModels],
  )

  const currentUserDefaultModel = useMemo(
    () => visibleModels.find((model) => model.id === userDefaultModelId) ?? null,
    [userDefaultModelId, visibleModels],
  )

  const defaultSelectableModels = useMemo(
    () => visibleModels.filter(canUseAsWorkspaceDefault),
    [visibleModels],
  )

  const defaultModelGroups = useMemo(
    () => groupModelsBySourceAndProvider(defaultSelectableModels),
    [defaultSelectableModels],
  )

  const userDefaultSelectableModels = useMemo(
    () => visibleModels.filter(canUseAsPersonalDefault),
    [visibleModels],
  )

  const userDefaultModelGroups = useMemo(
    () => groupModelsBySourceAndProvider(userDefaultSelectableModels),
    [userDefaultSelectableModels],
  )

  const localCodexModels = useMemo(
    () => openAICodexStatus.connected ? openAICodexStatus.models : [],
    [openAICodexStatus],
  )

  const effectiveUserDefaultModelId = deviceMainModelId || userDefaultModelId

  const selectedModelProvider = useMemo(
    () => providers.find((provider) => provider.id === modelProviderId) ?? null,
    [modelProviderId, providers],
  )

  const customApiModelRecommendations = useMemo(
    () => getCustomApiModelRecommendations(selectedModelProvider?.name ?? ''),
    [selectedModelProvider?.name],
  )

  const refreshOpenAICodexStatus = useCallback(async (): Promise<OpenAICodexStatus> => {
    const status = await window.tabtin.openaiCodex.getStatus()
    setOpenAICodexStatus(status)
    return status
  }, [])

  const resetProviderForm = () => {
    const defaultUrl = getProviderDefaultBaseUrl('openai')
    setProviderName('openai')
    setProviderKeyTouched(false)
    setProviderKey(buildByokProviderKey('openai', defaultUrl, { existingKeys: existingProviderKeys }))
    setProviderDisplayName('')
    setProviderBaseUrl(defaultUrl)
    setProviderApiKey('')
    setProviderScope(canUseOrgScope ? 'organization' : 'user')
    setEditingProviderId(null)
    setProviderFormError(null)
    setProviderAdvancedOpen(false)
  }

  const resetModelForm = () => {
    setModelProviderId('')
    setModelProviderLocked(false)
    setModelName('')
    setModelDisplayName('')
    setModelBaseUrl('')
    setModelMaxTokens(DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS_INPUT)
    setModelSupportsVision(false)
    setModelSupportsStreaming(true)
    setModelSupportsFunctionCalling(true)
    setModelCapabilitiesConfig(ensureCustomChatJsonCapability({}))
    setModelAdvancedOpen(false)
    setEditingModelId(null)
    setModelFormError(null)
    setModelSearchKeyword('')
    setModelSearchResults([])
  }

  const openModelDialogForProvider = (provider: OrganizationLlmProvider) => {
    if (Date.now() < suppressCreateDialogUntilRef.current) return
    resetModelForm()
    setModelProviderId(provider.id)
    setModelProviderLocked(true)
    if (provider.base_url) {
      setModelBaseUrl(provider.base_url)
    }
    setModelFormOpen(true)
  }

  const loadAll = useCallback(async (): Promise<{
    providers: OrganizationLlmProvider[]
    models: OrganizationLlmModel[]
  } | null> => {
    setLoading(true)
    setNotice(null)
    try {
      // Codex 本机状态与列表并行，避免串行 IPC 拖长首屏 loading
      const [providerList, modelList, codexStatus, devicePreferences] = await Promise.all([
        OrganizationLlmApiService.listProviders(organizationId),
        OrganizationLlmApiService.listModels(organizationId),
        refreshOpenAICodexStatus().catch(() => ({ connected: false, models: [] as OpenAICodexStatus['models'] })),
        loadOrganizationDeviceModelPreferences(organizationId).catch(
          (): OrganizationDeviceModelPreferences => ({}),
        ),
      ])
      const nextModels = modelList.models || []
      setProviders(providerList)
      setModels(nextModels)
      setOrganizationDefaultModelId(
        modelList.organization_default_model_id || modelList.default_model_id || '',
      )
      setUserDefaultModelId(modelList.user_default_model_id || '')
      setDeviceMainModelId(devicePreferences.mainModelId || '')
      const localSubagentModelId = devicePreferences.subagentModelId || ''
      setDeviceSubagentModelId(localSubagentModelId)
      setUserSubagentModelPolicy(
        localSubagentModelId ? 'fixed' : modelList.user_subagent_model_policy || 'inherit',
      )
      setUserSubagentModelId(localSubagentModelId || modelList.user_subagent_model_id || '')
      setOrganizationSubagentModelPolicy(modelList.organization_subagent_model_policy || modelList.subagent_model_policy || 'inherit')
      setOrganizationSubagentModelId(modelList.organization_subagent_model_id || '')
      setOpenAICodexStatus(codexStatus)
      return { providers: providerList, models: nextModels }
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.errors.loadModelsFailed') })
      return null
    } finally {
      setLoading(false)
    }
  }, [organizationId, refreshOpenAICodexStatus, t])

  useEffect(() => { void loadAll() }, [loadAll])

  useEffect(() => {
    const unsubscribe = window.tabtin.openaiCodex.onStatusChanged(() => {
      void refreshOpenAICodexStatus()
        .then(() => {
          // 登录与断开都刷新：断开时要立即移除本机模型，并重读主进程已清理的
          // 设备默认，不能让失效 BYOK 继续留在下拉框与子 Agent 策略里。
          void loadAll()
          void refreshChatModels(organizationId)
        })
        .catch(() => {
          setOpenAICodexStatus({ connected: false, models: [] })
        })
    })
    return unsubscribe
  }, [loadAll, organizationId, refreshChatModels, refreshOpenAICodexStatus])

  const handleDisconnectOpenAICodex = async () => {
    setNotice(null)
    try {
      await window.tabtin.openaiCodex.logout()
      if (deviceMainModelId || deviceSubagentModelId) {
        await saveOrganizationDeviceModelPreferences(organizationId, {})
        setDeviceMainModelId('')
        setDeviceSubagentModelId('')
      }
      await refreshOpenAICodexStatus()
      await loadAll()
      await refreshChatModels(organizationId)
      setNotice({ type: 'success', message: t('llm.codex.disconnect') })
    } catch (err) {
      setNotice({
        type: 'error',
        message: err instanceof Error ? err.message : t('llm.codex.logoutFailed'),
      })
    }
  }

  // ── Provider Dialog helpers ──

  const openProviderDialog = (initialProviderName?: string) => {
    if (Date.now() < suppressCreateDialogUntilRef.current) return
    resetProviderForm()
    if (initialProviderName) {
      const defaultUrl = getProviderDefaultBaseUrl(initialProviderName)
      setProviderName(initialProviderName)
      setProviderKeyTouched(false)
      setProviderKey(buildByokProviderKey(initialProviderName, defaultUrl, { existingKeys: existingProviderKeys }))
      setProviderBaseUrl(defaultUrl)
    }
    setProviderFormOpen(true)
  }

  const openProviderEditDialog = (provider: OrganizationLlmProvider) => {
    setEditingProviderId(provider.id)
    setProviderName(provider.name)
    setProviderKeyTouched(true)
    setProviderKey(provider.provider_key)
    setProviderDisplayName(provider.display_name || '')
    setProviderBaseUrl(provider.base_url || '')
    setProviderApiKey('')
    setProviderScope(provider.scope === 'organization' ? 'organization' : 'user')
    setProviderFormError(null)
    setProviderFormOpen(true)
  }

  const handleProviderDialogClose = (open: boolean) => {
    if (!open && !creatingProvider) {
      suppressCreateDialogUntilRef.current = Date.now() + 600
      setProviderFormOpen(false)
      window.setTimeout(resetProviderForm, 200)
    }
  }

  const isApiKeyRequired = getProviderApiKeyRequired(providerName)

  const handleCreateProvider = async () => {
    setProviderFormError(null)
    if (!providerKey.trim() || !PROVIDER_KEY_PATTERN.test(providerKey.trim())) {
      setProviderFormError(t('llm.providers.validation.providerKeyInvalid'))
      return
    }
    if (!editingProviderId && !providerBaseUrl.trim()) {
      setProviderFormError(t('llm.providers.validation.required'))
      return
    }
    if (providerBaseUrl.trim()) {
      try {
        const parsed = new URL(providerBaseUrl.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setProviderFormError(t('llm.providers.validation.baseUrlInvalid'))
          return
        }
      } catch {
        setProviderFormError(t('llm.providers.validation.baseUrlInvalid'))
        return
      }
    }
    if (isApiKeyRequired && !editingProviderId && !providerApiKey.trim()) {
      setProviderFormError(t('llm.providers.validation.required'))
      return
    }

    setCreatingProvider(true)
    try {
      const providerNameForValidate = providerName
      const providerKeyForValidate = providerKey.trim()
      const isCreating = !editingProviderId
      if (editingProviderId) {
        await OrganizationLlmApiService.updateProvider(organizationId, editingProviderId, {
          display_name: providerDisplayName.trim() || undefined,
          base_url: providerBaseUrl.trim() || undefined,
          api_key: providerApiKey.trim() || undefined,
        })
      } else {
        const typeLabel = providerTypeOptions.find((option) => option.value === providerName)?.label || providerName
        const payload: OrganizationProviderCreatePayload = {
          provider_name: providerName,
          provider_key: providerKey.trim(),
          display_name: providerDisplayName.trim() || suggestByokConnectionName(
            typeLabel,
            providerBaseUrl.trim(),
            providerName,
          ),
          base_url: providerBaseUrl.trim(),
          api_key: providerApiKey.trim(),
          scope: canUseOrgScope ? providerScope : 'user',
        }
        await OrganizationLlmApiService.createProvider(organizationId, payload)
      }
      setProviderFormOpen(false)
      window.setTimeout(resetProviderForm, 200)
      const refreshed = await loadAll()
      await refreshChatModels(organizationId)
      if (isCreating) {
        const created = refreshed?.providers.find(
          (item) => item.provider_key === providerKeyForValidate && item.scope !== 'global',
        )
        if (created) {
          openModelDialogForProvider(created)
          setNotice({ type: 'success', message: t('llm.providers.createSuccessContinueModel') })
        } else {
          setNotice({ type: 'success', message: t('llm.providers.createSuccessWithModelHint') })
        }
        return
      }
      try {
        const result = await OrganizationLlmApiService.validateProvider(
          providerNameForValidate, organizationId, providerKeyForValidate
        )
        setNotice(result.valid
          ? { type: 'success', message: t('llm.providers.validateSuccess') }
          : { type: 'error', message: result.message || t('llm.providers.validateFailed') }
        )
      } catch (err) {
        setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.providers.validateFailed') })
      }
    } catch (err) {
      const fallback = editingProviderId
        ? t('llm.errors.updateProviderFailed')
        : t('llm.errors.createProviderFailed')
      setProviderFormError(err instanceof Error ? err.message : fallback)
    } finally {
      setCreatingProvider(false)
    }
  }

  const handleToggleProvider = async (provider: OrganizationLlmProvider) => {
    const routingEnabled = isProviderRoutingEnabled(provider)
    setNotice(null)
    try {
      await OrganizationLlmApiService.updateProvider(organizationId, provider.id, {
        routing_enabled: !routingEnabled,
      })
      setNotice({
        type: 'success',
        message: routingEnabled ? t('llm.providers.disableSuccess') : t('llm.providers.enableSuccess'),
      })
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.errors.updateProviderFailed') })
    }
  }

  const handleDeleteProvider = (provider: OrganizationLlmProvider) => {
    setDeleteConfirm({ open: true, type: 'provider', target: provider })
  }

  const executeDeleteProvider = async (provider: OrganizationLlmProvider) => {
    setNotice(null)
    try {
      await OrganizationLlmApiService.deleteProvider(organizationId, provider.id)
      setNotice({ type: 'success', message: t('llm.providers.deleteSuccess') })
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.errors.deleteProviderFailed') })
    }
  }

  const handleProbeProvider = async (provider: OrganizationLlmProvider) => {
    setNotice(null)
    setValidatingProviderId(provider.id)
    setProviderProbeResults((prev) => {
      const next = { ...prev }
      delete next[provider.id]
      return next
    })
    try {
      const result = await OrganizationLlmApiService.probeProvider(organizationId, provider.id, 1)
      if (result.valid) {
        const message = `${t('llm.providers.validateSuccess')} · ${Math.round(result.latency_ms || 0)}ms`
        setProviderProbeResults((prev) => ({ ...prev, [provider.id]: { type: 'success', message } }))
        setNotice({ type: 'success', message })
      } else {
        const message = formatLlmProbeErrorLine(
          {
            error: result.error,
            error_code: result.error_code,
            status_code: result.status_code,
            details: result.details,
          },
          t,
        )
        setProviderProbeResults((prev) => ({ ...prev, [provider.id]: { type: 'error', message } }))
        setNotice({ type: 'error', message })
      }
      await loadAll()
    } catch (err) {
      const raw = err instanceof Error ? err.message : ''
      const message = formatLlmProbeErrorLine(
        { error: raw || t('llm.providers.validateFailed') },
        t,
      )
      setProviderProbeResults((prev) => ({ ...prev, [provider.id]: { type: 'error', message } }))
      setNotice({ type: 'error', message })
    } finally {
      setValidatingProviderId(null)
    }
  }

  // ── Key Management helpers ──

  const loadProviderKeys = useCallback(async (providerId: string) => {
    setLoadingKeys(true)
    try {
      const result = await OrganizationLlmApiService.listProviderKeys(organizationId, providerId)
      setProviderKeys(result.keys || [])
    } catch { setProviderKeys([]) }
    finally { setLoadingKeys(false) }
  }, [organizationId])

  const handleAddKey = async () => {
    if (!editingProviderId || !newKeyLabel.trim() || !newKeyApiKey.trim()) return
    setAddingKey(true)
    try {
      await OrganizationLlmApiService.createProviderKey(organizationId, editingProviderId, {
        label: newKeyLabel.trim(),
        api_key: newKeyApiKey.trim(),
        priority: parseInt(newKeyPriority) || 0,
      })
      setNewKeyLabel('')
      setNewKeyApiKey('')
      setNewKeyPriority('0')
      setAddKeyOpen(false)
      await loadProviderKeys(editingProviderId)
      await loadAll()
    } catch (err) {
      setProviderFormError(err instanceof Error ? err.message : 'Failed to add key')
    } finally { setAddingKey(false) }
  }

  const handleDeleteKey = async (keyId: string) => {
    if (!editingProviderId) return
    try {
      await OrganizationLlmApiService.deleteProviderKey(organizationId, editingProviderId, keyId)
      await loadProviderKeys(editingProviderId)
      await loadAll()
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Failed to delete key' })
    }
  }

  useEffect(() => {
    if (editingProviderId && providerFormOpen) {
      void loadProviderKeys(editingProviderId)
    } else {
      setProviderKeys([])
    }
  }, [editingProviderId, providerFormOpen, loadProviderKeys])

  // ── Model Dialog helpers ──

  const openModelEditDialog = (model: OrganizationLlmModel) => {
    if (model.provider_scope === 'global') return
    const providerBaseUrl = providers.find((provider) => provider.id === model.provider_id)?.base_url || ''
    setEditingModelId(model.id)
    setModelProviderId(model.provider_id || '')
    setModelName(model.name || '')
    setModelDisplayName(model.display_name || '')
    setModelBaseUrl(model.base_url || providerBaseUrl)
    setModelMaxTokens(String(model.max_tokens || DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS))
    setModelSupportsVision(Boolean(model.supports_vision))
    setModelSupportsStreaming(Boolean(model.supports_streaming))
    setModelSupportsFunctionCalling(model.supports_function_calling !== false)
    setModelCapabilitiesConfig(ensureCustomChatJsonCapability(model.capabilities_config))
    setModelAdvancedOpen(false)
    setModelFormError(null)
    setModelSearchKeyword('')
    setModelSearchResults([])
    setModelProviderLocked(true)
    setModelFormOpen(true)
  }

  const handleModelDialogClose = (open: boolean) => {
    if (!open && !creatingModel) {
      suppressCreateDialogUntilRef.current = Date.now() + 600
      setModelFormOpen(false)
      window.setTimeout(resetModelForm, 200)
    }
  }

  const handleCreateModel = async () => {
    setModelFormError(null)
    if (!modelProviderId) {
      setModelFormError(t('llm.models.validation.providerRequired'))
      return
    }
    if (!modelName.trim() || !modelDisplayName.trim()) {
      setModelFormError(t('llm.models.validation.required'))
      return
    }
    const inheritedBaseUrl = selectedModelProvider?.base_url?.trim() || modelBaseUrl.trim()
    if (!inheritedBaseUrl) {
      setModelFormError(t('llm.models.validation.baseUrlRequired', { defaultValue: '当前渠道没有可用地址' }))
      return
    }
    const maxTokens = Number(modelMaxTokens)
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      setModelFormError(t('llm.models.validation.maxTokens'))
      return
    }

    setCreatingModel(true)
    try {
      if (editingModelId) {
        await OrganizationLlmApiService.updateModel(organizationId, editingModelId, {
          model_name: modelName.trim(),
          display_name: modelDisplayName.trim(),
          base_url: inheritedBaseUrl,
          max_tokens: maxTokens,
          capabilities_config: ensureCustomChatJsonCapability(modelCapabilitiesConfig),
          supports_vision: modelSupportsVision,
          supports_streaming: modelSupportsStreaming,
          supports_function_calling: modelSupportsFunctionCalling,
        })
        setNotice({ type: 'success', message: t('llm.models.updateSuccess') })
      } else {
        const payload: OrganizationModelCreatePayload = {
          provider_id: modelProviderId,
          model_name: modelName.trim(),
          display_name: modelDisplayName.trim(),
          base_url: inheritedBaseUrl,
          max_tokens: maxTokens,
          capabilities_config: ensureCustomChatJsonCapability(modelCapabilitiesConfig),
          supports_vision: modelSupportsVision,
          supports_streaming: modelSupportsStreaming,
          supports_function_calling: modelSupportsFunctionCalling,
        }
        await OrganizationLlmApiService.createModel(organizationId, payload)
        setNotice({ type: 'success', message: t('llm.models.createSuccess') })
      }
      setModelFormOpen(false)
      window.setTimeout(resetModelForm, 200)
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      const fallback = editingModelId
        ? t('llm.errors.updateModelFailed')
        : t('llm.errors.createModelFailed')
      setModelFormError(err instanceof Error ? err.message : fallback)
    } finally {
      setCreatingModel(false)
    }
  }

  const handleDeleteModel = (model: OrganizationLlmModel) => {
    if (model.provider_scope === 'global') return
    setDeleteConfirm({ open: true, type: 'model', target: model })
  }

  const executeDeleteModel = async (model: OrganizationLlmModel) => {
    setNotice(null)
    try {
      await OrganizationLlmApiService.deleteModel(organizationId, model.id)
      setNotice({ type: 'success', message: t('llm.models.deleteSuccess') })
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.errors.deleteModelFailed') })
    }
  }

  const handleSearchModels = async () => {
    const keyword = modelSearchKeyword.trim()
    if (!selectedModelProvider) {
      setModelFormError(t('llm.models.validation.providerRequired'))
      return
    }
    if (!keyword) {
      setModelFormError(t('llm.models.searchValidation'))
      return
    }
    setModelFormError(null)
    setSearchingModels(true)
    try {
      const result = await OrganizationLlmApiService.searchModels(
        keyword,
        organizationId,
        selectedModelProvider.id,
      )
      const scoped = (result.models || []).filter((item) => modelMatchesChannel(item, selectedModelProvider))
      setModelSearchResults(scoped)
      if (scoped.length === 0) {
        setModelFormError(t('llm.models.searchEmpty'))
      }
    } catch (err) {
      setModelFormError(err instanceof Error ? err.message : t('llm.errors.searchModelFailed'))
    } finally {
      setSearchingModels(false)
    }
  }

  const handleApplySearchModel = (item: OrganizationModelSearchResult) => {
    setModelName(item.name)
    setModelDisplayName(item.name)
    if (item.context_window_tokens) setModelMaxTokens(String(item.context_window_tokens))
    if (item.supports_vision) setModelSupportsVision(true)
  }

  const handleApplyCustomApiRecommendation = (item: ByokCustomApiModelRecommendation) => {
    setModelName(item.model_name)
    setModelDisplayName(item.display_name)
    setModelMaxTokens(String(item.max_tokens))
    setModelSupportsVision(Boolean(item.supports_vision))
    setModelFormError(null)
  }

  const handleSetOrganizationDefaultModel = async (modelId: string) => {
    if (!modelId) return
    setSavingOrganizationDefault(true)
    setNotice(null)
    try {
      if (!canManageOrganization || isOpenAICodexModel(modelId)) return
      await OrganizationLlmApiService.setDefaultModel(organizationId, modelId)
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.errors.setDefaultModelFailed') })
    } finally {
      setSavingOrganizationDefault(false)
    }
  }

  const handleSetUserDefaultModel = async (modelId: string) => {
    if (!modelId) return
    setSavingUserDefault(true)
    setNotice(null)
    try {
      if (modelId === USER_DEFAULT_MODEL_INHERIT_VALUE) {
        await OrganizationLlmApiService.setUserDefaultModel(organizationId, null)
        const saved = await saveOrganizationDeviceModelPreferences(organizationId, {
          ...(deviceSubagentModelId ? { subagentModelId: deviceSubagentModelId } : {}),
        })
        setDeviceMainModelId(saved.mainModelId || '')
      } else if (isOpenAICodexModel(modelId)) {
        const saved = await saveOrganizationDeviceModelPreferences(organizationId, {
          mainModelId: modelId,
          ...(deviceSubagentModelId ? { subagentModelId: deviceSubagentModelId } : {}),
        })
        setDeviceMainModelId(saved.mainModelId || '')
      } else {
        await OrganizationLlmApiService.setUserDefaultModel(organizationId, modelId)
        await saveOrganizationDeviceModelPreferences(organizationId, {
          ...(deviceSubagentModelId ? { subagentModelId: deviceSubagentModelId } : {}),
        })
        setDeviceMainModelId('')
      }
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : t('llm.errors.setUserDefaultModelFailed') })
    } finally {
      setSavingUserDefault(false)
    }
  }

  const saveSubagentModelPolicy = async (
    scope: 'user' | 'organization',
    mode: SubagentModelPolicy,
    modelId?: string,
  ) => {
    setSavingSubagentModel(true)
    setNotice(null)
    try {
      const isLocalModel = mode === 'fixed' && Boolean(modelId && isOpenAICodexModel(modelId))
      if (scope === 'user' && isLocalModel && modelId) {
        const saved = await saveOrganizationDeviceModelPreferences(organizationId, {
          ...(deviceMainModelId ? { mainModelId: deviceMainModelId } : {}),
          subagentModelId: modelId,
        })
        setDeviceSubagentModelId(saved.subagentModelId || '')
      } else if (scope === 'user') {
        if (mode === 'fixed' && modelId) {
          await OrganizationLlmApiService.setUserSubagentModelPolicy(organizationId, {
            mode,
            model_id: modelId,
          })
        } else {
          await OrganizationLlmApiService.setUserSubagentModelPolicy(organizationId, { mode })
        }
        await saveOrganizationDeviceModelPreferences(organizationId, {
          ...(deviceMainModelId ? { mainModelId: deviceMainModelId } : {}),
        })
        setDeviceSubagentModelId('')
      } else {
        if (canManageOrganization) {
          await OrganizationLlmApiService.setSubagentModelPolicy(organizationId, {
            mode: mode === 'inherit_main' ? 'inherit' : mode,
            ...(mode === 'fixed' && modelId ? { model_id: modelId } : {}),
          })
        } else {
          return
        }
      }
      await loadAll()
      await refreshChatModels(organizationId)
    } catch (err) {
      await loadAll()
      setNotice({
        type: 'error',
        message: err instanceof Error ? err.message : t('llm.errors.setSubagentModelFailed'),
      })
    } finally {
      setSavingSubagentModel(false)
    }
  }

  const handleSubagentSelectionChange = (scope: 'user' | 'organization', value: string) => {
    if (scope === 'user' && value === SUBAGENT_FOLLOW_TEAM_VALUE) {
      setUserSubagentModelPolicy('inherit')
      setUserSubagentModelId('')
      void saveSubagentModelPolicy('user', 'inherit')
      return
    }
    if (value === SUBAGENT_FOLLOW_MAIN_VALUE) {
      if (scope === 'user') {
        setUserSubagentModelPolicy('inherit_main')
        setUserSubagentModelId('')
        void saveSubagentModelPolicy('user', 'inherit_main')
      } else {
        setOrganizationSubagentModelPolicy('inherit')
        setOrganizationSubagentModelId('')
        void saveSubagentModelPolicy('organization', 'inherit')
      }
      return
    }
    if (!value.startsWith(SUBAGENT_MODEL_VALUE_PREFIX)) {
      return
    }
    const modelId = value.slice(SUBAGENT_MODEL_VALUE_PREFIX.length)
    if (scope === 'user') {
      setUserSubagentModelPolicy('fixed')
      setUserSubagentModelId(modelId)
    } else {
      setOrganizationSubagentModelPolicy('fixed')
      setOrganizationSubagentModelId(modelId)
    }
    void saveSubagentModelPolicy(scope, 'fixed', modelId)
  }

  // ── 新建表单：协议变化重置默认 URL；provider_key 仅首次派生，手改后不覆盖 ──
  useEffect(() => {
    if (!providerFormOpen || editingProviderId) return
    setProviderBaseUrl(getProviderDefaultBaseUrl(providerName))
    setProviderKeyTouched(false)
  }, [providerName, providerFormOpen, editingProviderId])

  useEffect(() => {
    if (!providerFormOpen || editingProviderId || providerKeyTouched) return
    setProviderKey(buildByokProviderKey(providerName, providerBaseUrl, {
      existingKeys: existingProviderKeys,
      officialBaseUrl: getProviderDefaultBaseUrl(providerName),
    }))
  }, [
    providerName,
    providerBaseUrl,
    providerFormOpen,
    editingProviderId,
    providerKeyTouched,
    existingProviderKeys,
  ])

  useEffect(() => {
    if (!canUseOrgScope) setProviderScope('user')
  }, [canUseOrgScope])

  useEffect(() => {
    if (editingModelId || !modelProviderId) return
    const selectedProvider = providers.find((provider) => provider.id === modelProviderId)
    if (selectedProvider?.base_url) {
      setModelBaseUrl(selectedProvider.base_url)
    }
  }, [editingModelId, modelProviderId, providers])

  const renderByokModelRow = (model: OrganizationLlmModel) => {
    const isActive = isModelEnabled(model)
    const isOrganizationDefault = model.id === organizationDefaultModelId
    const isUserDefault = model.id === userDefaultModelId
    const canBeOrganizationDefault = canManageOrganization && canUseAsWorkspaceDefault(model)
    const canBeUserDefault = canUseAsPersonalDefault(model)
    const statusLabel = isActive
      ? t('llm.models.statusReady', { defaultValue: '可用' })
      : !isModelProviderRoutingEnabled(model)
      ? t('llm.models.statusProviderDisabled', { defaultValue: '渠道未启用' })
      : t('llm.models.statusNotReady', { defaultValue: '未就绪' })

    return (
      <div key={model.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/20 transition-colors">
        <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', isActive ? 'bg-success' : 'bg-muted-foreground/30')} title={statusLabel} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-body text-foreground truncate">{model.display_name}</span>
            {isOrganizationDefault && (
              <span className="text-caption text-accent">{t('llm.default.organizationLabel', { defaultValue: '团队默认' })}</span>
            )}
            {isUserDefault && (
              <span className="text-caption text-success">{t('llm.default.userLabel', { defaultValue: '我的默认' })}</span>
            )}
            {!isActive && (
              <span className="text-caption text-muted-foreground/70">{statusLabel}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canBeUserDefault && !isUserDefault && (
            <button
              type="button"
              onClick={() => handleSetUserDefaultModel(model.id)}
              disabled={savingUserDefault}
              className="text-caption text-muted-foreground/80 hover:text-success transition-colors disabled:opacity-30"
            >
              {t('llm.default.setAsUser', { defaultValue: '设为我的默认' })}
            </button>
          )}
          {canBeOrganizationDefault && !isOrganizationDefault && (
            <button
              type="button"
              onClick={() => handleSetOrganizationDefaultModel(model.id)}
              disabled={savingOrganizationDefault}
              className="text-caption text-muted-foreground/80 hover:text-accent transition-colors disabled:opacity-30"
            >
              {t('llm.default.setAsOrganization', { defaultValue: '设为团队默认' })}
            </button>
          )}
          <button type="button" onClick={() => openModelEditDialog(model)} disabled={model.provider_scope === 'organization' && !canManageOrganization} className="text-caption text-muted-foreground/80 hover:text-foreground transition-colors disabled:opacity-30">
            {t('llm.models.edit')}
          </button>
          <button type="button" onClick={() => handleDeleteModel(model)} disabled={model.provider_scope === 'organization' && !canManageOrganization} className="text-caption text-muted-foreground/80 hover:text-destructive transition-colors disabled:opacity-30">
            {t('llm.models.delete')}
          </button>
        </div>
      </div>
    )
  }

  const renderSubagentPolicyControls = (scope: 'user' | 'organization') => {
    const isUserScope = scope === 'user'
    const policy = isUserScope ? userSubagentModelPolicy : organizationSubagentModelPolicy
    const selectedModelId = isUserScope ? userSubagentModelId : organizationSubagentModelId
    const selectableGroups = isUserScope ? userDefaultModelGroups : defaultModelGroups
    const canEdit = isUserScope || canManageOrganization
    const includeLocalModels = isUserScope && localCodexModels.length > 0
    const hasModelOptions = selectableGroups.length > 0 || includeLocalModels
    const selectedValue = policy === 'fixed' && selectedModelId
      ? `${SUBAGENT_MODEL_VALUE_PREFIX}${selectedModelId}`
      : isUserScope && policy === 'inherit'
        ? SUBAGENT_FOLLOW_TEAM_VALUE
        : SUBAGENT_FOLLOW_MAIN_VALUE
    return (
      <Select
        value={selectedValue}
        onValueChange={(value) => handleSubagentSelectionChange(scope, value)}
        disabled={!canEdit || savingSubagentModel || loading}
      >
        <SelectTrigger
          aria-label={t('llm.defaultConfig.subagentPolicy', { defaultValue: '子 Agent 默认模型' })}
          className={cn('h-9 text-body', SETTINGS_CONTROL)}
        >
          <SelectValue placeholder={t('llm.defaultConfig.pickSubagentModel', { defaultValue: '选择子 Agent 模型' })} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {isUserScope && (
              <SelectItem value={SUBAGENT_FOLLOW_TEAM_VALUE}>
                {t('llm.defaultConfig.subagentInheritOrganization', { defaultValue: '跟随团队设置' })}
              </SelectItem>
            )}
            <SelectItem value={SUBAGENT_FOLLOW_MAIN_VALUE}>
              {t('llm.defaultConfig.subagentInherit', { defaultValue: '跟随主 Agent' })}
            </SelectItem>
          </SelectGroup>
          {hasModelOptions && <SelectSeparator />}
          {includeLocalModels && (
            <>
              <SelectGroup>
                <SelectLabel>
                  {t('llm.defaultConfig.deviceModelGroup', { defaultValue: '本机模型 · ChatGPT' })}
                </SelectLabel>
                {localCodexModels.map((model) => (
                  <SelectItem key={model.id} value={`${SUBAGENT_MODEL_VALUE_PREFIX}${model.id}`}>
                    {model.displayName} · {t('llm.defaultConfig.currentDevice', { defaultValue: '仅当前设备' })}
                  </SelectItem>
                ))}
              </SelectGroup>
              {selectableGroups.length > 0 && <SelectSeparator />}
            </>
          )}
          {selectableGroups.map((group, index) => (
            <React.Fragment key={group.key}>
              {index > 0 && <SelectSeparator />}
              <SelectGroup>
                <SelectLabel>
                  {t(`chat:model.source.${group.source}`, {
                    defaultValue: MODEL_SOURCE_DEFAULT_LABELS[group.source],
                  })} · {getProviderShortLabel(group.provider, group.providerDisplayName)}
                </SelectLabel>
                {group.models.map((model) => (
                  <SelectItem key={model.id} value={`${SUBAGENT_MODEL_VALUE_PREFIX}${model.id}`}>
                    {model.display_name} · {model.provider_display_name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </React.Fragment>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <div className="space-y-4">
      {notice && (
        <p className={cn('text-body', notice.type === 'success' ? 'text-success' : 'text-destructive')}>
          {notice.message}
        </p>
      )}

      {/* ── 分区一：TabTin 预置模型（平台内置，开箱即用） ── */}
      {systemModels.length > 0 && (
          <SettingsSectionCard
            title={t('llm.presetSection.title', { defaultValue: 'TabTin 预置模型' })}
          subtitle={t('llm.presetSection.subtitle', { defaultValue: '平台内置模型，开箱即用，可设为个人或团队默认。' })}
          subtitleAsTooltip
        >
          <div className="space-y-0.5">
            {previewSystemModels.map((model) => {
              const isActive = isModelEnabled(model)
              const isOrganizationDefault = model.id === organizationDefaultModelId
              const isUserDefault = model.id === userDefaultModelId
              const statusLabel = isActive
                ? t('llm.models.statusReady', { defaultValue: '可用' })
                : !isModelProviderRoutingEnabled(model)
                ? t('llm.models.statusProviderDisabled', { defaultValue: '渠道未启用' })
                : t('llm.models.statusNotReady', { defaultValue: '未就绪' })
              return (
                <div key={model.id} className="flex items-center gap-3 rounded-md px-2 py-2">
                  <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', isActive ? 'bg-success' : 'bg-muted-foreground/30')} title={statusLabel} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body text-foreground truncate">{model.display_name}</span>
                      <span className={cn(
                        'rounded px-1.5 py-0.5 text-caption',
                        isActive ? 'bg-success/10 text-success' : 'bg-muted/40 text-muted-foreground/80',
                      )}>
                        {statusLabel}
                      </span>
                      {isOrganizationDefault && (
                        <span className="text-caption text-accent bg-accent/10 px-1.5 py-0.5 rounded">{t('llm.default.organizationLabel', { defaultValue: '团队默认' })}</span>
                      )}
                      {isUserDefault && (
                        <span className="text-caption text-success bg-success/10 px-1.5 py-0.5 rounded">{t('llm.default.userLabel', { defaultValue: '我的默认' })}</span>
                      )}
                    </div>
                    <div className="text-caption text-muted-foreground/40 truncate">
                      {model.name} · {model.provider_display_name} · {model.max_tokens} tokens
                    </div>
                  </div>
                </div>
              )
            })}
            {systemModels.length > PRESET_MODEL_PREVIEW_LIMIT && (
              <button
                type="button"
                onClick={() => setPresetModelsExpanded((expanded) => !expanded)}
                className="px-2 pt-2 text-left text-caption text-muted-foreground/60 hover:text-foreground transition-colors"
              >
                {presetModelsExpanded
                  ? t('llm.presetSection.collapse', { defaultValue: '收起' })
                  : t('llm.presetSection.viewAll', { defaultValue: '查看全部 →' })}
              </button>
            )}
          </div>
        </SettingsSectionCard>
      )}

      {/* ── 我的模型服务 ── */}
      <SettingsSectionCard
        title={t('llm.byokSection.title')}
        subtitle={t('llm.byokSection.subtitle')}
        actions={(
          <SettingsLink onClick={() => byokConnectRef.current?.open()}>
            {'+ ' + t('llm.providers.createApi')}
          </SettingsLink>
        )}
        bodyClassName="space-y-3"
      >
        <ByokConnectEntries
          ref={byokConnectRef}
          organizationId={organizationId}
          canManageOrganization={canManageOrganization}
          isPersonalOrganization={isPersonalOrganization}
          disabled={loading}
          existingProviderKeys={existingProviderKeys}
          onSuccess={async (message) => {
            await loadAll()
            await refreshChatModels(organizationId)
            if (message) setNotice({ type: 'success', message })
          }}
        />
        <div className="space-y-2">
          <div className="space-y-3">
            {customProviders.length === 0
              && !(OPENAI_CODEX_BYOK_UI_ENABLED && openAICodexStatus.connected) ? (
              <p className="text-caption text-muted-foreground/60 py-1">{t('llm.providers.empty')}</p>
            ) : (
              <>
                {OPENAI_CODEX_BYOK_UI_ENABLED && openAICodexStatus.connected && (
                  <div className="overflow-hidden rounded-md border border-border/50 bg-background">
                    <div className="flex items-start gap-3 px-3 py-2.5">
                      <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-body font-medium text-foreground">{t('llm.codex.vendorLabel')}</span>
                          <span className="rounded bg-success/10 px-1.5 py-0.5 text-caption text-success">
                            {t('llm.providers.connected')}
                          </span>
                        </div>
                        <p className="mt-0.5 text-caption text-muted-foreground">
                          {t('llm.codex.accountLogin')} · {t('llm.codex.devicePersonal')}
                        </p>
                        <p className="text-caption text-muted-foreground/70">{t('llm.codex.deviceOnly')}</p>
                        <p className="mt-1.5 text-caption text-muted-foreground">
                          {t('llm.providers.modelCount', { count: openAICodexStatus.models.length })}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {openAICodexStatus.models.map((model) => (
                            <span key={model.id} className="rounded bg-muted/50 px-1.5 py-0.5 text-caption text-foreground">
                              {model.displayName}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => byokConnectRef.current?.openPlan('chatgpt_codex')}
                          className="text-caption text-muted-foreground/80 transition-colors hover:text-foreground"
                        >
                          {t('llm.codex.reconnect')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDisconnectOpenAICodex()}
                          className="text-caption text-muted-foreground/80 transition-colors hover:text-destructive"
                        >
                          {t('llm.codex.disconnect')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {customProviders.map((provider) => {
                const providerModels = modelsByProviderId.get(provider.id) ?? []
                const routingEnabled = isProviderRoutingEnabled(provider)
                const probeResult = providerProbeResults[provider.id]
                const canManageProvider = provider.scope !== 'organization' || canManageOrganization
                const connectivityStatus = resolveProviderConnectivityStatus({
                  routingEnabled,
                  runtimeStatus: provider.runtime_status,
                  latestProbe: probeResult,
                })
                const degradedReason = resolveProviderDegradedReason({
                  healthSuccessRate: provider.health_success_rate,
                  healthAverageLatencyMs: provider.health_avg_latency_ms,
                  healthConsecutiveFailures: provider.health_consecutive_failures,
                })
                const degradedStatusLabel = {
                  recent_failures: t('llm.providers.statusDegraded', { defaultValue: '近期有失败' }),
                  slow_response: t('llm.providers.statusSlowResponse', { defaultValue: '响应较慢' }),
                  recovering: t('llm.providers.statusRecovering', { defaultValue: '恢复观察中' }),
                  unstable: t('llm.providers.statusUnstable', { defaultValue: '连接不稳定' }),
                }[degradedReason]
                const statusColor = connectivityStatus === 'paused' ? 'bg-muted-foreground/20'
                  : connectivityStatus === 'healthy' ? 'bg-success'
                  : connectivityStatus === 'degraded' ? 'bg-warning'
                  : connectivityStatus === 'unhealthy' ? 'bg-destructive'
                  : 'bg-muted-foreground/40'
                const planPreset = findPlanPresetByProviderKey(provider.provider_key)
                const previewModels = providerModels.slice(0, SERVICE_MODEL_PREVIEW_LIMIT)
                const hiddenModelCount = Math.max(0, providerModels.length - previewModels.length)
                const modelsExpanded = expandedServiceId === provider.id
                const statusLabel = connectivityStatus === 'paused'
                  ? t('llm.providers.routingPaused', { defaultValue: '已暂停路由' })
                  : connectivityStatus === 'healthy'
                  ? t('llm.providers.statusNormal', { defaultValue: '正常' })
                  : connectivityStatus === 'degraded'
                  ? degradedStatusLabel
                  : connectivityStatus === 'unhealthy'
                  ? t('llm.providers.statusUnhealthy', { defaultValue: '连通异常' })
                  : t('llm.providers.statusUnknown', { defaultValue: '未测试' })
                const statusBadgeClass = connectivityStatus === 'paused'
                  ? 'bg-muted/40 text-muted-foreground/80'
                  : connectivityStatus === 'healthy'
                  ? 'bg-success/10 text-success'
                  : connectivityStatus === 'degraded'
                  ? 'bg-warning/10 text-warning'
                  : connectivityStatus === 'unhealthy'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted/40 text-muted-foreground/80'

                return (
                  <div key={provider.id} className="overflow-hidden rounded-md border border-border/50 bg-background">
                    <div className="flex items-start gap-3 px-3 py-2.5">
                      <div className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', statusColor)} title={statusLabel} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-body font-medium text-foreground truncate">{provider.display_name || provider.name}</span>
                          <span className={cn('rounded px-1.5 py-0.5 text-caption', statusBadgeClass)}>
                            {statusLabel}
                          </span>
                        </div>
                        <p className="mt-0.5 text-caption text-muted-foreground">
                          {getServiceProtocolLabel(provider, t)}
                          {formatServiceEndpoint(provider.base_url) && (
                            <>
                              <span className="mx-1 text-muted-foreground/40">·</span>
                              {formatServiceEndpoint(provider.base_url)}
                            </>
                          )}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <VisibilityLabel scope={provider.scope} />
                          {!routingEnabled && (
                            <span className="text-caption text-muted-foreground/60">
                              {t('llm.providers.routingDisabledHint', { defaultValue: '聊天不会自动选用' })}
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-caption text-muted-foreground">
                          {t('llm.providers.modelCount', { count: providerModels.length })}
                        </p>
                        {providerModels.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {previewModels.map((model) => (
                              <span key={model.id} className="rounded bg-muted/50 px-1.5 py-0.5 text-caption text-foreground">
                                {model.display_name}
                              </span>
                            ))}
                            {hiddenModelCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setExpandedServiceId(modelsExpanded ? null : provider.id)}
                                className="rounded bg-muted/40 px-1.5 py-0.5 text-caption text-muted-foreground hover:text-foreground"
                              >
                                {t('llm.providers.moreModels', { count: hiddenModelCount })}
                              </button>
                            )}
                          </div>
                        )}
                        {probeResult && (
                          <div className={cn(
                            'mt-1 truncate text-caption',
                            probeResult.type === 'success' ? 'text-success' : 'text-destructive',
                          )}>
                            {probeResult.message}
                          </div>
                        )}
                        {!probeResult
                          && !!provider.health_last_error
                          && (connectivityStatus === 'unhealthy' || connectivityStatus === 'degraded')
                          && (
                            <div className="mt-1 truncate text-caption text-destructive">
                              {provider.health_last_error}
                            </div>
                          )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button type="button" onClick={() => openProviderEditDialog(provider)} disabled={!canManageProvider} className="text-caption text-muted-foreground/80 hover:text-foreground transition-colors disabled:opacity-30">
                            {planPreset ? t('llm.providers.editKey') : t('llm.providers.edit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleProbeProvider(provider)}
                            disabled={validatingProviderId === provider.id || providerModels.length === 0}
                            className="text-caption text-muted-foreground/80 hover:text-foreground transition-colors disabled:opacity-30"
                            title={providerModels.length === 0 ? t('llm.providers.testRequiresModel') : undefined}
                          >
                            {validatingProviderId === provider.id ? t('llm.providers.validating', { defaultValue: '测试中' }) : t('llm.providers.testConnection', { defaultValue: '测试' })}
                          </button>
                          <button type="button" onClick={() => handleDeleteProvider(provider)} disabled={!canManageProvider} className="text-caption text-muted-foreground/80 hover:text-destructive transition-colors disabled:opacity-30">
                            {t('llm.providers.delete')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setMoreActionsId(moreActionsId === provider.id ? null : provider.id)}
                            className="text-caption text-muted-foreground/60 hover:text-foreground"
                          >
                            {t('llm.providers.moreActions')}
                          </button>
                        </div>
                        {moreActionsId === provider.id && (
                          <button type="button" onClick={() => handleToggleProvider(provider)} disabled={!canManageProvider} className="text-caption text-muted-foreground/80 hover:text-foreground transition-colors disabled:opacity-30">
                            {routingEnabled ? t('llm.providers.pauseRouting', { defaultValue: '暂停路由' }) : t('llm.providers.resumeRouting', { defaultValue: '启用路由' })}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="border-t border-border/20 bg-muted/10 px-3 py-2">
                      <div className="space-y-1">
                        {(modelsExpanded || providerModels.length <= SERVICE_MODEL_PREVIEW_LIMIT) && providerModels.map((model) => renderByokModelRow(model))}
                        {providerModels.length === 0 && (
                          <p className="text-caption text-muted-foreground/60 py-1">{t('llm.models.emptyUnderProvider')}</p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openModelDialogForProvider(provider)}
                            disabled={!canManageProvider}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-caption font-medium text-accent hover:bg-accent/10 transition-colors disabled:opacity-30"
                          >
                            <Plus className="h-3 w-3" />
                            {t('llm.models.addUnderProvider')}
                          </button>
                          {providerModels.length > SERVICE_MODEL_PREVIEW_LIMIT && (
                            <button
                              type="button"
                              onClick={() => setExpandedServiceId(modelsExpanded ? null : provider.id)}
                              className="text-caption text-muted-foreground hover:text-foreground"
                            >
                              {modelsExpanded
                                ? t('llm.presetSection.collapse')
                                : t('llm.providers.manageModels')}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
                })}
              </>
            )}
          </div>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        title={t('llm.defaultConfig.title', { defaultValue: '默认模型' })}
        subtitle={t('llm.defaultConfig.subtitle', {
          defaultValue: '我的默认只影响当前账号，团队默认由组织管理员配置。',
        })}
        subtitleAsTooltip
        bodyClassName="space-y-3"
      >
        <ChipTabBar
          value={defaultConfigScope}
          onValueChange={setDefaultConfigScope}
          ariaLabel={t('llm.defaultConfig.title', { defaultValue: '默认模型' })}
          items={[
            { value: 'user', label: t('llm.defaultConfig.userDefaultsTab', { defaultValue: '我的' }) },
            { value: 'organization', label: t('llm.defaultConfig.organizationDefaultsTab', { defaultValue: '团队' }) },
          ]}
        />
        <SettingsRowGroup>
          {defaultConfigScope === 'user' ? (
            <>
              <SettingsRow
                label={t('llm.defaultConfig.userCurrentModel', { defaultValue: '默认模型' })}
                control={(
                  <Select
                    value={effectiveUserDefaultModelId || USER_DEFAULT_MODEL_INHERIT_VALUE}
                    onValueChange={handleSetUserDefaultModel}
                    disabled={savingUserDefault || loading}
                  >
                    <SelectTrigger
                      aria-label={t('llm.defaultConfig.userCurrentModel', { defaultValue: '默认模型' })}
                      className={cn('h-9 text-body', SETTINGS_CONTROL)}
                    >
                      <SelectValue placeholder={t('llm.defaultConfig.userPickHint', { defaultValue: '选择我的默认模型' })} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={USER_DEFAULT_MODEL_INHERIT_VALUE}>
                        {t('llm.defaultConfig.followTeamSetting', { defaultValue: '跟随团队设置' })}
                      </SelectItem>
                      {(localCodexModels.length > 0 || userDefaultModelGroups.length > 0) && <SelectSeparator />}
                      {currentUserDefaultModel && !canUseAsPersonalDefault(currentUserDefaultModel) && (
                        <SelectItem value={currentUserDefaultModel.id} disabled>
                          {currentUserDefaultModel.display_name} · {t('llm.defaultConfig.unavailableCurrent', { defaultValue: '当前不可用' })}
                        </SelectItem>
                      )}
                      {localCodexModels.length > 0 && (
                        <>
                          <SelectGroup>
                            <SelectLabel>
                              {t('llm.defaultConfig.deviceModelGroup', { defaultValue: '本机模型 · ChatGPT' })}
                            </SelectLabel>
                            {localCodexModels.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.displayName} · {t('llm.defaultConfig.currentDevice', { defaultValue: '仅当前设备' })}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                          {userDefaultModelGroups.length > 0 && <SelectSeparator />}
                        </>
                      )}
                      {userDefaultModelGroups.map((group, index) => (
                        <React.Fragment key={group.key}>
                          {index > 0 && <SelectSeparator />}
                          <SelectGroup>
                            <SelectLabel>
                              {t(`chat:model.source.${group.source}`, {
                                defaultValue: MODEL_SOURCE_DEFAULT_LABELS[group.source],
                              })} · {getProviderShortLabel(group.provider, group.providerDisplayName)}
                            </SelectLabel>
                            {group.models.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.display_name} · {model.provider_display_name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </React.Fragment>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <SettingsRow
                label={t('llm.defaultConfig.subagentPolicy', { defaultValue: '子 Agent 默认模型' })}
                control={renderSubagentPolicyControls('user')}
              />
            </>
          ) : (
            <>
              <SettingsRow
                label={t('llm.defaultConfig.organizationCurrentModel', { defaultValue: '默认模型' })}
                control={(
                  <Select
                    value={organizationDefaultModelId || undefined}
                    onValueChange={handleSetOrganizationDefaultModel}
                    disabled={!canManageOrganization || savingOrganizationDefault || loading || defaultSelectableModels.length === 0}
                  >
                    <SelectTrigger
                      aria-label={t('llm.defaultConfig.organizationCurrentModel', { defaultValue: '默认模型' })}
                      className={cn('h-9 text-body', SETTINGS_CONTROL)}
                    >
                      <SelectValue placeholder={t('llm.defaultConfig.organizationPickHint', { defaultValue: '选择团队默认模型' })} />
                    </SelectTrigger>
                    <SelectContent>
                      {currentOrganizationDefaultModel && !canUseAsWorkspaceDefault(currentOrganizationDefaultModel) && (
                        <SelectItem value={currentOrganizationDefaultModel.id} disabled>
                          {currentOrganizationDefaultModel.display_name} · {t('llm.defaultConfig.unavailableCurrent', { defaultValue: '当前不可用' })}
                        </SelectItem>
                      )}
                      {defaultModelGroups.map((group, index) => (
                        <React.Fragment key={group.key}>
                          {index > 0 && <SelectSeparator />}
                          <SelectGroup>
                            <SelectLabel>
                              {t(`chat:model.source.${group.source}`, {
                                defaultValue: MODEL_SOURCE_DEFAULT_LABELS[group.source],
                              })} · {getProviderShortLabel(group.provider, group.providerDisplayName)}
                            </SelectLabel>
                            {group.models.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.display_name} · {model.provider_display_name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </React.Fragment>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <SettingsRow
                label={t('llm.defaultConfig.subagentPolicy', { defaultValue: '子 Agent 默认模型' })}
                control={renderSubagentPolicyControls('organization')}
              />
            </>
          )}
        </SettingsRowGroup>
      </SettingsSectionCard>


      {/* ── 添加/编辑渠道弹窗 ── */}
      {providerFormOpen && (
        <Dialog open={providerFormOpen} onOpenChange={handleProviderDialogClose}>
          <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <DialogTitle>
                  {editingProviderId ? t('llm.providers.editTitle') : t('llm.providers.createApiTitle')}
                </DialogTitle>
                <DialogDescription>
                  {editingProviderId ? t('llm.byokSection.subtitle') : t('llm.providers.createApiDesc')}
                </DialogDescription>
              </div>
              {(providerScope === 'organization' || providerScope === 'user') && !editingProviderId && (
                <ByokScenarioHint />
              )}
            </div>
          </DialogHeader>

          <DialogScrollBody className="space-y-5">
            {editingProviderId && <ByokScopeNotice scope={providerScope} />}
            {providerFormError && <p className="text-body text-destructive">{providerFormError}</p>}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.providers.provider')}</label>
                <Select value={providerName} onValueChange={setProviderName}>
                  <SelectTrigger className={cn('h-8 text-body', SETTINGS_CONTROL)} disabled={!!editingProviderId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerTypeOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.providers.scope')}</label>
                <Select value={providerScope} onValueChange={(v) => setProviderScope(v as 'organization' | 'user')}>
                  <SelectTrigger className={cn('h-8 text-body', SETTINGS_CONTROL)} disabled={!!editingProviderId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="organization" disabled={!canUseOrgScope}>
                      {t('llm.providers.scopeOrganization')} · {t('llm.serviceCatalog.scopeOrgDesc')}
                    </SelectItem>
                    <SelectItem value="user">
                      {t('llm.providers.scopeUser')} · {t('llm.serviceCatalog.scopePersonalDesc')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {!canUseOrgScope && (
                  <p className="text-caption text-muted-foreground/40">
                    {isPersonalOrganization
                      ? t('llm.providers.scopePersonalAccountHint')
                      : t('llm.providers.scopeHint')}
                  </p>
                )}
              </div>
              {providerAdvancedOpen && (
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.providers.providerKey')}</label>
                <Input
                  className={cn('h-8 text-body', SETTINGS_CONTROL)}
                  value={providerKey}
                  onChange={(e) => {
                    setProviderKeyTouched(true)
                    setProviderKey(e.target.value)
                  }}
                  placeholder="openai-openrouter"
                  disabled={!!editingProviderId}
                />
                <p className="text-caption text-muted-foreground/60">{t('llm.providers.providerKeyHint')}</p>
              </div>
              )}
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.providers.displayName')}</label>
                <Input
                  className={cn('h-8 text-body', SETTINGS_CONTROL)}
                  value={providerDisplayName}
                  onChange={(e) => setProviderDisplayName(e.target.value)}
                  placeholder={suggestByokConnectionName(
                    providerTypeOptions.find((option) => option.value === providerName)?.label || providerName,
                    providerBaseUrl,
                    providerName,
                  )}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <label htmlFor="organization-provider-base-url" className="text-body text-muted-foreground/80">
                  {t('llm.providers.baseUrl')}
                </label>
                <Input
                  id="organization-provider-base-url"
                  className={cn('h-8 font-mono text-body', SETTINGS_CONTROL)}
                  value={providerBaseUrl}
                  onChange={(e) => setProviderBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
                <p className="text-caption text-muted-foreground/60">
                  {t('llm.providers.baseUrlDefaultHint')}
                </p>
                {providerName === 'minimax' && (
                  <p className="text-caption text-muted-foreground/60">
                    {t('llm.providers.minimaxCustomApiHint')}
                  </p>
                )}
                {providerName === 'qwen' && (
                  <p className="text-caption text-muted-foreground/60">
                    {t('llm.providers.dashscopeCustomApiHint')}
                  </p>
                )}
                {providerName === 'volcengine' && (
                  <p className="text-caption text-muted-foreground/60">
                    {t('llm.providers.volcengineCustomApiHint')}
                  </p>
                )}
                {providerName === 'zhipu' && (
                  <p className="text-caption text-muted-foreground/60">
                    {t('llm.providers.zhipuCustomApiHint')}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">
                  {t('llm.providers.apiKey')}
                  {!isApiKeyRequired && <span className="text-caption text-muted-foreground/40 ml-1">{t('llm.providers.optional')}</span>}
                </label>
                <Input className={cn('h-8 text-body', SETTINGS_CONTROL)} type="password" value={providerApiKey} onChange={(e) => setProviderApiKey(e.target.value)} placeholder={editingProviderId ? t('llm.providers.apiKeyEditPlaceholder') : !isApiKeyRequired ? t('llm.providers.localApiKeyPlaceholder') : 'sk-...'} />
              </div>
            </div>
            {!editingProviderId && (
              <p className="text-caption text-muted-foreground/60">
                {t('llm.providers.createModelHint')}
              </p>
            )}
            <button
              type="button"
              onClick={() => setProviderAdvancedOpen((open) => !open)}
              className="text-caption text-muted-foreground hover:text-foreground"
            >
              {t('llm.serviceCatalog.advancedSettings')}
            </button>

            {/* ── 密钥管理区域（编辑模式下显示） ── */}
            {editingProviderId && (
              <div className="border-t border-border/20 pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-body font-medium text-foreground">{t('llm.providers.keysTitle')}</h4>
                    <p className="text-caption text-muted-foreground/40">{t('llm.providers.keysDesc')}</p>
                  </div>
                  <button type="button" onClick={() => setAddKeyOpen(!addKeyOpen)} className="text-caption text-accent hover:text-accent/80 transition-colors">
                    {'+ ' + t('llm.providers.keyAdd')}
                  </button>
                </div>

                {addKeyOpen && (
                  <div className="rounded-md border border-border/20 p-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Input className={cn('h-7 text-caption', SETTINGS_CONTROL)} value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} placeholder={t('llm.providers.keyLabelPlaceholder')} />
                      <Input className={cn('h-7 text-caption', SETTINGS_CONTROL)} value={newKeyPriority} onChange={(e) => setNewKeyPriority(e.target.value)} placeholder={t('llm.providers.keyPriority')} type="number" />
                    </div>
                    <Input className={cn('h-7 text-caption', SETTINGS_CONTROL)} type="password" value={newKeyApiKey} onChange={(e) => setNewKeyApiKey(e.target.value)} placeholder={t('llm.providers.keyApiKey')} />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" className="h-6 text-caption" onClick={() => setAddKeyOpen(false)}>{t('llm.providers.cancel')}</Button>
                      <Button size="sm" className="h-6 text-caption" onClick={handleAddKey} disabled={addingKey || !newKeyLabel.trim() || !newKeyApiKey.trim()}>
                        {addingKey ? '...' : t('llm.providers.keyAdd')}
                      </Button>
                    </div>
                  </div>
                )}

                {loadingKeys ? (
                  <p className="text-caption text-muted-foreground/40 py-1">...</p>
                ) : providerKeys.length === 0 ? (
                  <p className="text-caption text-muted-foreground/40 py-1">
                    {t('llm.providers.noExtraKeys', { defaultValue: '暂无额外密钥；当前渠道仍可使用创建时填写的 API Key。' })}
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {providerKeys.map((k) => {
                      const keyUsable = isProviderKeyUsable(k)
                      const manuallyDisabled = Boolean(k.disabled_until)
                      const inCooldown = Boolean(k.cooldown_until)
                      const statusLabel = manuallyDisabled ? t('llm.providers.keyStatusDisabled')
                        : inCooldown ? t('llm.providers.keyStatusCooldown')
                        : !keyUsable ? t('llm.providers.keyStatusInactive')
                        : t('llm.providers.keyStatusUsable')
                      const statusColor = manuallyDisabled ? 'bg-destructive'
                        : inCooldown ? 'bg-warning'
                        : !keyUsable ? 'bg-muted-foreground/20'
                        : 'bg-success'
                      return (
                        <div key={k.id} className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/20 transition-colors">
                          <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', statusColor)} title={statusLabel} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-caption font-medium text-foreground truncate">{k.label}</span>
                              <span className="text-caption text-muted-foreground/30">{k.api_key_preview}</span>
                              {k.priority !== 0 && <span className="text-caption text-muted-foreground/30">P{k.priority}</span>}
                            </div>
                            <div className="text-caption text-muted-foreground/30">
                              {statusLabel}
                              {k.total_requests > 0 && <span className="ml-1">· {k.total_requests} req</span>}
                              {k.error_count > 0 && <span className="ml-1 text-destructive/60">· {k.error_count} err</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await OrganizationLlmApiService.updateProviderKey(organizationId, editingProviderId, k.id, { is_active: manuallyDisabled })
                                  await loadProviderKeys(editingProviderId)
                                } catch (err) {
                                  // 失败必须给用户反馈——空 catch 让"点了启用/停用按钮但状态没变"
                                  // 成为静默 bug（同 set-yolo-mode IPC 静默吞错的反模式）
                                  toast({
                                    description: err instanceof Error ? err.message : t('llm.providers.toggleFailed', { defaultValue: '操作失败，请重试' }),
                                    variant: 'destructive',
                                  })
                                }
                              }}
                              disabled={inCooldown && !manuallyDisabled}
                              className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground/40 hover:text-foreground transition-colors"
                              title={
                                inCooldown && !manuallyDisabled
                                  ? t('llm.providers.keyStatusCooldown')
                                  : manuallyDisabled ? t('llm.providers.enable') : t('llm.providers.disable')
                              }
                            >
                              <Power className="h-2.5 w-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirm({ open: true, type: 'key', target: { id: k.id, label: k.label, provider_id: editingProviderId } })}
                              className="h-5 w-5 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground/40 hover:text-destructive transition-colors"
                              title={t('llm.providers.delete')}
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </DialogScrollBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleProviderDialogClose(false)} disabled={creatingProvider}>
              {t('llm.providers.cancel')}
            </Button>
            <Button onClick={handleCreateProvider} disabled={creatingProvider || loading}>
              {creatingProvider ? t('llm.providers.creating') : editingProviderId ? t('llm.providers.save') : t('llm.providers.create')}
            </Button>
          </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── 添加/编辑模型弹窗 ── */}
      {modelFormOpen && (
        <Dialog open={modelFormOpen} onOpenChange={handleModelDialogClose}>
          <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingModelId ? t('llm.models.edit') : t('llm.models.create')}
            </DialogTitle>
            <DialogDescription>{t('llm.models.desc')}</DialogDescription>
          </DialogHeader>

          <DialogScrollBody className="space-y-5">
            {modelFormError && <p className="text-body text-destructive">{modelFormError}</p>}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.models.provider')}</label>
                {modelProviderLocked && selectedModelProvider ? (
                  <div className={cn('flex h-8 items-center rounded-md border bg-muted/20 px-3 text-body', SETTINGS_CONTROL)}>
                    <span className="truncate">{selectedModelProvider.display_name || selectedModelProvider.name}</span>
                  </div>
                ) : (
                  <Select value={modelProviderId} onValueChange={setModelProviderId}>
                    <SelectTrigger className={cn('h-8 text-body', SETTINGS_CONTROL)} disabled={!!editingModelId}>
                      <SelectValue placeholder={t('llm.models.providerPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModelProviders.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.models.maxTokens')}</label>
                <Input className={cn('h-8 text-body', SETTINGS_CONTROL)} value={modelMaxTokens} onChange={(e) => setModelMaxTokens(e.target.value)} placeholder={DEFAULT_BYOK_CONTEXT_WINDOW_TOKENS_INPUT} />
              </div>
            </div>

            {!editingModelId && customApiModelRecommendations.length > 0 && (
              <div className="space-y-2">
                <label className="text-body text-muted-foreground/80">{t('llm.models.recommendedModels')}</label>
                <div className="flex flex-wrap gap-2">
                  {customApiModelRecommendations.map((item) => (
                    <button
                      key={item.model_name}
                      type="button"
                      onClick={() => handleApplyCustomApiRecommendation(item)}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-caption transition-colors',
                        modelName === item.model_name
                          ? 'border-accent/50 bg-accent/10 text-accent'
                          : 'border-border/40 bg-muted/20 text-foreground hover:border-accent/30 hover:bg-accent/5',
                      )}
                    >
                      {item.display_name}
                    </button>
                  ))}
                </div>
                <p className="text-caption text-muted-foreground/50">{t('llm.models.recommendedModelsHint')}</p>
              </div>
            )}

            {/* 搜索模型 */}
            {!editingModelId && (
              <div className="hidden space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.models.searchKeyword')}</label>
                <div className="flex items-center gap-2">
                  <Input className={cn('h-8 text-body flex-1', SETTINGS_CONTROL)} value={modelSearchKeyword} onChange={(e) => setModelSearchKeyword(e.target.value)} placeholder={t('llm.models.searchPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSearchModels() }} />
                  <Button size="sm" variant="outline" onClick={handleSearchModels} disabled={searchingModels} className="h-8 text-body shrink-0">
                    <Search className="h-3 w-3 mr-1" />
                    {searchingModels ? t('llm.models.searching') : t('llm.models.search')}
                  </Button>
                  {modelSearchKeyword && (
                    <button type="button" onClick={() => { setModelSearchKeyword(''); setModelSearchResults([]) }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground/60"><X className="h-3 w-3" /></button>
                  )}
                </div>

                {modelSearchResults.length > 0 && (
                  <div className="mt-2 max-h-36 overflow-y-auto rounded-md border border-border/20 divide-y divide-border/10">
                    {modelSearchResults.map((item) => (
                      <button key={item.name} type="button" className="w-full text-left px-3 py-2 hover:bg-muted/30 transition-colors" onClick={() => handleApplySearchModel(item)}>
                        <div className="flex items-center justify-between text-body">
                          <span className="text-foreground">{item.name}</span>
                          {item.provider && <span className="text-muted-foreground/40">{item.provider}</span>}
                        </div>
                        <div className="text-caption text-muted-foreground/40">
                          {[item.mode, item.context_window_tokens ? `${item.context_window_tokens} tokens` : null].filter(Boolean).join(' · ')}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.models.modelName')}</label>
                <Input className={cn('h-8 text-body', SETTINGS_CONTROL)} value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="gpt-4o" />
              </div>
              <div className="space-y-1.5">
                <label className="text-body text-muted-foreground/80">{t('llm.models.displayName')}</label>
                <Input className={cn('h-8 text-body', SETTINGS_CONTROL)} value={modelDisplayName} onChange={(e) => setModelDisplayName(e.target.value)} placeholder="GPT-4o" />
              </div>
            </div>

            <p className="truncate text-caption text-muted-foreground/60">
              {t('llm.models.endpointInherit', {
                defaultValue: '使用渠道地址：{{url}}',
                url: selectedModelProvider?.base_url || modelBaseUrl || '-',
              })}
            </p>

            <div className="space-y-2 rounded-md border border-border/20 bg-muted/10 px-3 py-2">
              <button
                type="button"
                onClick={() => setModelAdvancedOpen((open) => !open)}
                className="text-caption text-accent hover:text-accent/80"
              >
                {modelAdvancedOpen
                  ? t('llm.models.hideEndpointOverride', { defaultValue: '收起高级' })
                  : t('llm.models.advancedCapabilities', { defaultValue: '高级能力' })}
              </button>
              {modelAdvancedOpen && (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-8">
                  <label className="flex items-center gap-2 text-body text-muted-foreground/80">
                    <Switch checked={modelSupportsFunctionCalling} onCheckedChange={setModelSupportsFunctionCalling} />
                    {t('llm.models.supportsFunctionCalling')}
                  </label>
                  <label className="flex items-center gap-2 text-body text-muted-foreground/80">
                    <Switch checked={modelSupportsVision} onCheckedChange={setModelSupportsVision} />
                    {t('llm.models.supportsVision')}
                  </label>
                  <label className="flex items-center gap-2 text-body text-muted-foreground/80">
                    <Switch checked={modelSupportsStreaming} onCheckedChange={setModelSupportsStreaming} />
                    {t('llm.models.supportsStreaming')}
                  </label>
                </div>
              )}
            </div>
          </DialogScrollBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleModelDialogClose(false)} disabled={creatingModel}>
              {t('llm.models.cancel')}
            </Button>
            <Button onClick={handleCreateModel} disabled={creatingModel || loading}>
              {creatingModel ? t('llm.models.creating') : editingModelId ? t('llm.models.save') : t('llm.models.create')}
            </Button>
          </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── 删除确认 ── */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => { if (!open) setDeleteConfirm(prev => ({ ...prev, open: false })) }}
        title={
          deleteConfirm.type === 'provider'
            ? t('llm.providers.confirmDeleteTitle')
            : deleteConfirm.type === 'key'
            ? t('llm.providers.keyDeleteTitle')
            : t('llm.models.confirmDeleteTitle')
        }
        description={
          deleteConfirm.type === 'provider'
            ? t('llm.providers.confirmDelete', {
                name: (deleteConfirm.target as OrganizationLlmProvider)?.display_name
                  || (deleteConfirm.target as OrganizationLlmProvider)?.name,
                count: (deleteConfirm.target as OrganizationLlmProvider)?.model_count || 0,
              })
            : deleteConfirm.type === 'key'
            ? t('llm.providers.keyDeleteConfirm', {
                label: (deleteConfirm.target as { label: string })?.label,
              })
            : t('llm.models.confirmDelete', {
                name: (deleteConfirm.target as OrganizationLlmModel)?.display_name
                  || (deleteConfirm.target as OrganizationLlmModel)?.name,
              })
        }
        variant="destructive"
        onConfirm={async () => {
          if (!deleteConfirm.target) return
          if (deleteConfirm.type === 'provider') {
            await executeDeleteProvider(deleteConfirm.target as OrganizationLlmProvider)
          } else if (deleteConfirm.type === 'key') {
            const keyTarget = deleteConfirm.target as { id: string; provider_id: string }
            await handleDeleteKey(keyTarget.id)
          } else {
            await executeDeleteModel(deleteConfirm.target as OrganizationLlmModel)
          }
        }}
      />
    </div>
  )
}
