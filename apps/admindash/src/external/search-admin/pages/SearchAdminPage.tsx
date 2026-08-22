import {
  BarChart3,
  Coins,
  Edit3,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  type BillingEvent,
  type PricingRule,
  type SearchBillingOverviewData,
  type SearchConfigData,
  type SearchProviderItem,
  searchAdminApi,
} from '@/api/search-admin'
import { AdminPage } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'

type TabType = 'providers' | 'pricing' | 'billing'

type ProviderFormState = {
  provider_type: string
  provider_key: string
  display_name: string
  base_url: string
  api_key: string
  api_key_env_name: string
  request_timeout_sec: string
  priority: string
  is_active: boolean
}

type PricingFormState = {
  scope: 'global' | 'organization'
  organization_id: string
  provider_key: string
  unit_price: string
  priority: string
  is_active: boolean
}

const tabs: Array<{ key: TabType; label: string; icon: typeof Settings2 }> = [
  { key: 'providers', label: '接口配置', icon: Settings2 },
  { key: 'pricing', label: '成本配置', icon: Coins },
  { key: 'billing', label: '账单查看', icon: BarChart3 },
]

const freshnessOptions = [
  { value: 'noLimit', label: '不限时间' },
  { value: 'oneDay', label: '一天内' },
  { value: 'oneWeek', label: '一周内' },
  { value: 'oneMonth', label: '一个月内' },
  { value: 'oneYear', label: '一年内' },
]

const billingDayOptions = ['7', '30', '90', '180']

const providerTypePresets: Record<
  string,
  Pick<ProviderFormState, 'provider_key' | 'display_name' | 'base_url' | 'api_key_env_name'>
> = {
  qianfan: {
    provider_key: 'qianfan',
    display_name: '千帆百度搜索',
    base_url: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
    api_key_env_name: 'QIANFAN_API_KEY',
  },
  bocha: {
    provider_key: 'bocha',
    display_name: '博查搜索',
    base_url: 'https://api.bocha.cn/v1/web-search',
    api_key_env_name: 'BOCHA_API_KEY',
  },
  doubao: {
    provider_key: 'doubao',
    display_name: '豆包搜索 Custom 版',
    base_url: 'https://open.feedcoopapi.com/search_api/web_search',
    api_key_env_name: 'DOUBAO_SEARCH_API_KEY',
  },
}

const defaultProviderForm = (): ProviderFormState => ({
  provider_type: 'qianfan',
  ...providerTypePresets.qianfan,
  api_key: '',
  request_timeout_sec: '30',
  priority: '100',
  is_active: true,
})

const defaultPricingForm = (): PricingFormState => ({
  scope: 'global',
  organization_id: '',
  provider_key: 'qianfan',
  unit_price: '0',
  priority: '100',
  is_active: true,
})

function toNumber(value: string | number | null | undefined, fractionDigits = 4): string {
  const num = Number(value || 0)
  return Number.isFinite(num) ? num.toFixed(fractionDigits) : '0.0000'
}

function buildStartTime(days: string): string {
  const parsed = Number.parseInt(days, 10)
  const now = Date.now()
  return new Date(now - Math.max(parsed, 1) * 24 * 60 * 60 * 1000).toISOString()
}

export function SearchAdminPage() {
  const [activeTab, setActiveTab] = useState<TabType>('providers')
  const [providers, setProviders] = useState<SearchProviderItem[]>([])
  const [configDraft, setConfigDraft] = useState<SearchConfigData>({
    default_provider_key: 'qianfan',
    default_count: 8,
    default_summary_enabled: true,
    default_freshness: 'noLimit',
  })
  const [providerForm, setProviderForm] = useState<ProviderFormState>(defaultProviderForm())
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerDeleteTarget, setProviderDeleteTarget] = useState<SearchProviderItem | null>(null)

  const [pricingRules, setPricingRules] = useState<PricingRule[]>([])
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingForm, setPricingForm] = useState<PricingFormState>(defaultPricingForm())
  const [editingPricingId, setEditingPricingId] = useState<string | null>(null)
  const [pricingDeleteTarget, setPricingDeleteTarget] = useState<PricingRule | null>(null)
  const [sensitiveLoading, setSensitiveLoading] = useState(false)

  const [billingDays, setBillingDays] = useState('30')
  const [billingLoading, setBillingLoading] = useState(false)
  const [billingOverview, setBillingOverview] = useState<SearchBillingOverviewData | null>(null)
  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([])

  const { show: showToast, element: toastEl } = useSimpleToast()

  const activeProviderOptions = useMemo(
    () => providers.filter((provider) => provider.is_active),
    [providers]
  )

  const loadProvidersAndConfig = useCallback(async () => {
    setProviderLoading(true)
    try {
      const [providerResp, configResp] = await Promise.all([
        searchAdminApi.listProviders(),
        searchAdminApi.getConfig(),
      ])
      setProviders(providerResp.providers || [])
      setConfigDraft(configResp)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载搜索接口配置失败', 'error')
    } finally {
      setProviderLoading(false)
    }
  }, [showToast])

  const loadPricingRules = useCallback(async () => {
    setPricingLoading(true)
    try {
      const data = await searchAdminApi.listPricingRules({ page_size: 100, order_by: '-priority' })
      setPricingRules(data.pricing_rules || [])
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载成本规则失败', 'error')
    } finally {
      setPricingLoading(false)
    }
  }, [showToast])

  const loadBillingData = useCallback(async () => {
    setBillingLoading(true)
    try {
      const startTime = buildStartTime(billingDays)
      const [overviewResp, eventsResp] = await Promise.all([
        searchAdminApi.getBillingOverview(Number.parseInt(billingDays, 10) || 30),
        searchAdminApi.listBillingEvents({
          page_size: 20,
          start_time: startTime,
        }),
      ])
      setBillingOverview(overviewResp)
      setBillingEvents(eventsResp.events || [])
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载搜索账单失败', 'error')
    } finally {
      setBillingLoading(false)
    }
  }, [billingDays, showToast])

  useEffect(() => {
    if (activeTab === 'providers') {
      void loadProvidersAndConfig()
    } else if (activeTab === 'pricing') {
      void loadPricingRules()
    } else if (activeTab === 'billing') {
      void loadBillingData()
    }
  }, [activeTab, loadBillingData, loadPricingRules, loadProvidersAndConfig])

  const resetProviderForm = () => {
    setProviderForm(defaultProviderForm())
    setEditingProviderId(null)
  }

  const resetPricingForm = () => {
    setPricingForm(defaultPricingForm())
    setEditingPricingId(null)
  }

  const handleSaveConfig = async () => {
    try {
      const next = await searchAdminApi.updateConfig({
        default_provider_key: configDraft.default_provider_key,
        default_count: Number(configDraft.default_count) || 8,
        default_summary_enabled: configDraft.default_summary_enabled,
        default_freshness: configDraft.default_freshness,
      })
      setConfigDraft(next)
      showToast('默认搜索配置已更新')
      await loadProvidersAndConfig()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '更新默认搜索配置失败', 'error')
    }
  }

  const handleEditProvider = (provider: SearchProviderItem) => {
    const preset = providerTypePresets[provider.provider_type]
    setEditingProviderId(provider.id)
    setProviderForm({
      provider_type: provider.provider_type,
      provider_key: provider.provider_key,
      display_name: provider.display_name,
      base_url: provider.base_url,
      api_key: '',
      api_key_env_name: provider.api_key_source.startsWith('env:')
        ? provider.api_key_source.replace(/^env:/, '')
        : (preset?.api_key_env_name ?? 'QIANFAN_API_KEY'),
      request_timeout_sec: String(provider.request_timeout_sec),
      priority: String(provider.priority),
      is_active: provider.is_active,
    })
  }

  const handleSaveProvider = async () => {
    if (!providerForm.display_name.trim()) {
      showToast('请填写显示名称', 'error')
      return
    }
    if (!providerForm.provider_key.trim()) {
      showToast('请填写 provider_key', 'error')
      return
    }

    try {
      if (editingProviderId) {
        await searchAdminApi.updateProvider(editingProviderId, {
          provider_type: providerForm.provider_type,
          provider_key: providerForm.provider_key.trim(),
          display_name: providerForm.display_name.trim(),
          base_url: providerForm.base_url.trim(),
          api_key: providerForm.api_key.trim() || undefined,
          api_key_env_name: providerForm.api_key_env_name.trim(),
          request_timeout_sec: Number(providerForm.request_timeout_sec) || 30,
          priority: Number(providerForm.priority) || 0,
          is_active: providerForm.is_active,
        })
        showToast('搜索 provider 已更新')
      } else {
        await searchAdminApi.createProvider({
          provider_type: providerForm.provider_type,
          provider_key: providerForm.provider_key.trim(),
          display_name: providerForm.display_name.trim(),
          base_url: providerForm.base_url.trim(),
          api_key: providerForm.api_key.trim() || undefined,
          api_key_env_name: providerForm.api_key_env_name.trim(),
          request_timeout_sec: Number(providerForm.request_timeout_sec) || 30,
          priority: Number(providerForm.priority) || 0,
          is_active: providerForm.is_active,
        })
        showToast('搜索 provider 已创建')
      }
      resetProviderForm()
      await loadProvidersAndConfig()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存 provider 失败', 'error')
    }
  }

  const handleSetDefaultProvider = async (providerKey: string) => {
    try {
      const next = await searchAdminApi.updateConfig({ default_provider_key: providerKey })
      setConfigDraft((prev) => ({ ...prev, default_provider_key: next.default_provider_key }))
      showToast(`默认搜索接口已切换为 ${providerKey}`)
      await loadProvidersAndConfig()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '切换默认接口失败', 'error')
    }
  }

  const handleDeleteProvider = async (payload: { reason: string; ticket_id: string }) => {
    if (!providerDeleteTarget) return
    if (providerDeleteTarget.id.startsWith('fallback-')) {
      showToast('回退 provider 不能删除', 'error')
      return
    }
    setSensitiveLoading(true)
    try {
      await searchAdminApi.deleteProvider(providerDeleteTarget.id, payload)
      showToast('搜索 provider 已删除')
      setProviderDeleteTarget(null)
      await loadProvidersAndConfig()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除 provider 失败', 'error')
    } finally {
      setSensitiveLoading(false)
    }
  }

  const handleEditPricing = (rule: PricingRule) => {
    setEditingPricingId(rule.id)
    setPricingForm({
      scope: (rule.scope as 'global' | 'organization') || 'global',
      organization_id: rule.organization_id || '',
      provider_key: rule.provider_key || '',
      unit_price: rule.unit_price || '0',
      priority: String(rule.priority || 0),
      is_active: rule.is_active,
    })
  }

  const handleSavePricing = async () => {
    if (!pricingForm.unit_price.trim()) {
      showToast('请填写单价', 'error')
      return
    }
    if (pricingForm.scope === 'organization' && !pricingForm.organization_id.trim()) {
      showToast('organization 级规则必须填写 organization_id', 'error')
      return
    }

    try {
      const payload = {
        scope: pricingForm.scope,
        organization_id: pricingForm.scope === 'organization' ? pricingForm.organization_id.trim() : '',
        provider_key: pricingForm.provider_key.trim(),
        unit_price: pricingForm.unit_price.trim(),
        priority: Number(pricingForm.priority) || 0,
        is_active: pricingForm.is_active,
      } as const

      if (editingPricingId) {
        await searchAdminApi.updatePricingRule(editingPricingId, payload)
        showToast('成本规则已更新')
      } else {
        await searchAdminApi.createPricingRule(payload)
        showToast('成本规则已创建')
      }
      resetPricingForm()
      await loadPricingRules()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存成本规则失败', 'error')
    }
  }

  const handleDeletePricing = async (payload: { reason: string; ticket_id: string }) => {
    if (!pricingDeleteTarget) return
    setSensitiveLoading(true)
    try {
      await searchAdminApi.deletePricingRule(pricingDeleteTarget.id, payload)
      showToast('成本规则已删除')
      setPricingDeleteTarget(null)
      await loadPricingRules()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除成本规则失败', 'error')
    } finally {
      setSensitiveLoading(false)
    }
  }

  return (
    <>
      <AdminPage>
        {toastEl}

        <div>
          <h1 className="text-heading font-bold tracking-tight">搜索服务管理</h1>
        </div>

        <div className="flex gap-1 border-b">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-body font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            )
          })}
        </div>

        {activeTab === 'providers' && (
          <div className="space-y-6">
            <div className="rounded-lg border p-4 bg-background">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-title font-semibold">默认搜索策略</h3>
                  <p className="text-body text-muted-foreground">
                    Agent `web_search` 默认会使用这里配置的接口和返回策略
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadProvidersAndConfig()}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  刷新
                </Button>
              </div>

              {providerLoading ? (
                <div className="flex items-center py-12 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载搜索配置中...
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">默认 Provider</div>
                    <Select
                      value={configDraft.default_provider_key}
                      onValueChange={(value) =>
                        setConfigDraft((prev) => ({ ...prev, default_provider_key: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {activeProviderOptions.map((provider) => (
                          <SelectItem key={provider.provider_key} value={provider.provider_key}>
                            {provider.display_name} ({provider.provider_key})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">默认结果数</div>
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={configDraft.default_count}
                      onChange={(event) =>
                        setConfigDraft((prev) => ({
                          ...prev,
                          default_count: Number(event.target.value) || 8,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">默认时间范围</div>
                    <Select
                      value={configDraft.default_freshness}
                      onValueChange={(value) =>
                        setConfigDraft((prev) => ({ ...prev, default_freshness: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {freshnessOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-3">
                    <label className="flex items-center gap-2 text-body">
                      <input
                        type="checkbox"
                        checked={configDraft.default_summary_enabled}
                        onChange={(event) =>
                          setConfigDraft((prev) => ({
                            ...prev,
                            default_summary_enabled: event.target.checked,
                          }))
                        }
                      />
                      默认开启摘要
                    </label>
                  </div>
                </div>
              )}

              <div className="mt-4">
                <Button onClick={() => void handleSaveConfig()} disabled={providerLoading}>
                  <Save className="mr-1 h-3.5 w-3.5" />
                  保存默认配置
                </Button>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
              <div className="rounded-lg border p-4 bg-background">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-title font-semibold">
                      {editingProviderId ? '编辑 Provider' : '新增 Provider'}
                    </h3>
                  </div>
                  {editingProviderId && (
                    <Button variant="ghost" size="sm" onClick={resetProviderForm}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">Provider 类型</div>
                    <Select
                      value={providerForm.provider_type}
                      onValueChange={(value) =>
                        setProviderForm((prev) => {
                          const preset = providerTypePresets[value]
                          if (!preset || editingProviderId) {
                            return { ...prev, provider_type: value }
                          }
                          return {
                            ...prev,
                            provider_type: value,
                            ...preset,
                            api_key: value === 'doubao' ? '' : prev.api_key,
                          }
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="qianfan">qianfan（千帆百度搜索）</SelectItem>
                        <SelectItem value="bocha">bocha（博查搜索）</SelectItem>
                        <SelectItem value="doubao">doubao（豆包搜索 Custom 版）</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">provider_key</div>
                    <Input
                      value={providerForm.provider_key}
                      onChange={(event) =>
                        setProviderForm((prev) => ({ ...prev, provider_key: event.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">显示名称</div>
                    <Input
                      value={providerForm.display_name}
                      onChange={(event) =>
                        setProviderForm((prev) => ({ ...prev, display_name: event.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">Base URL</div>
                    <Input
                      value={providerForm.base_url}
                      onChange={(event) =>
                        setProviderForm((prev) => ({ ...prev, base_url: event.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">API Key 环境变量</div>
                    <Input
                      value={providerForm.api_key_env_name}
                      onChange={(event) =>
                        setProviderForm((prev) => ({
                          ...prev,
                          api_key_env_name: event.target.value,
                        }))
                      }
                    />
                    {providerForm.provider_type === 'doubao' && (
                      <p className="mt-1 text-caption text-muted-foreground">
                        豆包搜索 Custom 版仅从服务端环境变量 DOUBAO_SEARCH_API_KEY 读取密钥，不允许保存到数据库。
                      </p>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">
                      {providerForm.provider_type === 'doubao'
                        ? 'API Key 覆盖值（豆包仅支持环境变量）'
                        : 'API Key 覆盖值（可选）'}
                    </div>
                    <Input
                      value={providerForm.api_key}
                      placeholder={
                        providerForm.provider_type === 'doubao'
                          ? '请在部署环境配置 DOUBAO_SEARCH_API_KEY'
                          : '留空则使用环境变量'
                      }
                      disabled={providerForm.provider_type === 'doubao'}
                      onChange={(event) =>
                        setProviderForm((prev) => ({ ...prev, api_key: event.target.value }))
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="mb-1 text-body text-muted-foreground">超时(秒)</div>
                      <Input
                        type="number"
                        value={providerForm.request_timeout_sec}
                        onChange={(event) =>
                          setProviderForm((prev) => ({
                            ...prev,
                            request_timeout_sec: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <div className="mb-1 text-body text-muted-foreground">优先级</div>
                      <Input
                        type="number"
                        value={providerForm.priority}
                        onChange={(event) =>
                          setProviderForm((prev) => ({ ...prev, priority: event.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-body">
                    <input
                      type="checkbox"
                      checked={providerForm.is_active}
                      onChange={(event) =>
                        setProviderForm((prev) => ({ ...prev, is_active: event.target.checked }))
                      }
                    />
                    启用该 Provider
                  </label>
                  <Button onClick={() => void handleSaveProvider()} className="w-full">
                    {editingProviderId ? (
                      <>
                        <Save className="mr-1 h-3.5 w-3.5" />
                        保存 Provider
                      </>
                    ) : (
                      <>
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        新增 Provider
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border overflow-hidden bg-background">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div>
                    <h3 className="font-semibold">Provider 列表</h3>
                    <p className="text-body text-muted-foreground">
                      可查看默认接口、API Key 来源、启用状态与优先级
                    </p>
                  </div>
                  <Badge variant="outline">{providers.length} 个 provider</Badge>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-body">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-4 py-2.5 text-left font-medium">Provider</th>
                        <th className="px-4 py-2.5 text-left font-medium">接口</th>
                        <th className="px-4 py-2.5 text-left font-medium">鉴权</th>
                        <th className="px-4 py-2.5 text-center font-medium">状态</th>
                        <th className="px-4 py-2.5 text-center font-medium">优先级</th>
                        <th className="px-4 py-2.5 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providers.map((provider) => (
                        <tr key={provider.id} className="border-t align-top hover:bg-muted/20">
                          <td className="px-4 py-3">
                            <div className="font-medium">{provider.display_name}</div>
                            <div className="font-mono text-body text-muted-foreground">
                              {provider.provider_key}
                            </div>
                            <div className="mt-1 flex gap-2">
                              <Badge variant="outline">{provider.provider_type}</Badge>
                              {provider.is_default && <Badge>默认</Badge>}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="max-w-[320px] break-all text-body">
                              {provider.base_url}
                            </div>
                            <div className="mt-1 text-body text-muted-foreground">
                              超时 {provider.request_timeout_sec}s
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-mono text-body">{provider.api_key_masked}</div>
                            <div className="mt-1 text-body text-muted-foreground">
                              {provider.api_key_source}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Badge variant={provider.is_active ? 'success' : 'secondary'}>
                              {provider.is_active ? '启用' : '停用'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-center">{provider.priority}</td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              {!provider.is_default && provider.is_active && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    void handleSetDefaultProvider(provider.provider_key)
                                  }
                                >
                                  设为默认
                                </Button>
                              )}
                              {!provider.id.startsWith('fallback-') && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleEditProvider(provider)}
                                  >
                                    <Edit3 className="h-3.5 w-3.5" />
                                  </Button>
                                  <PermissionGate
                                    permission={ADMIN_PERMISSION.SEARCH_PROVIDER_DELETE}
                                  >
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setProviderDeleteTarget(provider)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                    </Button>
                                  </PermissionGate>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {providers.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                            暂无搜索 provider
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'pricing' && (
          <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
            <div className="rounded-lg border p-4 bg-background">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-title font-semibold">
                    {editingPricingId ? '编辑成本规则' : '新增成本规则'}
                  </h3>
                  <p className="text-body text-muted-foreground">
                    搜索目前按单次请求计费，计量项固定为 `search.web.request`
                  </p>
                </div>
                {editingPricingId && (
                  <Button variant="ghost" size="sm" onClick={resetPricingForm}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-body text-muted-foreground">作用域</div>
                  <Select
                    value={pricingForm.scope}
                    onValueChange={(value) =>
                      setPricingForm((prev) => ({ ...prev, scope: value as 'global' | 'organization' }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">global</SelectItem>
                      <SelectItem value="organization">organization</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {pricingForm.scope === 'organization' && (
                  <div>
                    <div className="mb-1 text-body text-muted-foreground">organization_id</div>
                    <Input
                      value={pricingForm.organization_id}
                      onChange={(event) =>
                        setPricingForm((prev) => ({ ...prev, organization_id: event.target.value }))
                      }
                    />
                  </div>
                )}
                <div>
                  <div className="mb-1 text-body text-muted-foreground">provider_key（可选）</div>
                  <Input
                    value={pricingForm.provider_key}
                    onChange={(event) =>
                      setPricingForm((prev) => ({ ...prev, provider_key: event.target.value }))
                    }
                  />
                </div>
                <div>
                  <div className="mb-1 text-body text-muted-foreground">
                    单次请求单价（CREDITS）
                  </div>
                  <Input
                    value={pricingForm.unit_price}
                    onChange={(event) =>
                      setPricingForm((prev) => ({ ...prev, unit_price: event.target.value }))
                    }
                  />
                </div>
                <div>
                  <div className="mb-1 text-body text-muted-foreground">优先级</div>
                  <Input
                    type="number"
                    value={pricingForm.priority}
                    onChange={(event) =>
                      setPricingForm((prev) => ({ ...prev, priority: event.target.value }))
                    }
                  />
                </div>
                <label className="flex items-center gap-2 text-body">
                  <input
                    type="checkbox"
                    checked={pricingForm.is_active}
                    onChange={(event) =>
                      setPricingForm((prev) => ({ ...prev, is_active: event.target.checked }))
                    }
                  />
                  启用该规则
                </label>
                <Button onClick={() => void handleSavePricing()} className="w-full">
                  {editingPricingId ? (
                    <>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      保存规则
                    </>
                  ) : (
                    <>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      新增规则
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border overflow-hidden bg-background">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div>
                  <h3 className="font-semibold">搜索成本规则</h3>
                  <p className="text-body text-muted-foreground">
                    可按 provider_key 或 organization 细分覆盖价格
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadPricingRules()}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  刷新
                </Button>
              </div>

              {pricingLoading ? (
                <div className="flex items-center px-4 py-12 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载成本规则中...
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-body">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-4 py-2.5 text-left font-medium">规则</th>
                        <th className="px-4 py-2.5 text-left font-medium">作用域</th>
                        <th className="px-4 py-2.5 text-right font-medium">单价</th>
                        <th className="px-4 py-2.5 text-center font-medium">优先级</th>
                        <th className="px-4 py-2.5 text-center font-medium">状态</th>
                        <th className="px-4 py-2.5 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pricingRules.map((rule) => (
                        <tr key={rule.id} className="border-t hover:bg-muted/20">
                          <td className="px-4 py-3">
                            <div className="font-mono text-body">{rule.meter_key}</div>
                            <div className="mt-1 text-body text-muted-foreground">
                              provider={rule.provider_key || '*'} / organization=
                              {rule.organization_id || '*'}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline">{rule.scope}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            {rule.unit_price} {rule.currency}
                          </td>
                          <td className="px-4 py-3 text-center">{rule.priority}</td>
                          <td className="px-4 py-3 text-center">
                            <Badge variant={rule.is_active ? 'success' : 'secondary'}>
                              {rule.is_active ? '启用' : '停用'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleEditPricing(rule)}
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </Button>
                              <PermissionGate permission={ADMIN_PERMISSION.PRICING_RULE_UPDATE}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setPricingDeleteTarget(rule)}
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                </Button>
                              </PermissionGate>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {pricingRules.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                            暂无搜索成本规则，可以先创建一条 `search.web.request` 规则
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'billing' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-title font-semibold">搜索账单概览</h3>
                <p className="text-body text-muted-foreground">
                  展示 `search.web.request` 计量项在最近一段时间内的实际计费记录
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={billingDays} onValueChange={setBillingDays}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {billingDayOptions.map((value) => (
                      <SelectItem key={value} value={value}>
                        最近 {value} 天
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => void loadBillingData()}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  刷新
                </Button>
              </div>
            </div>

            {billingLoading ? (
              <div className="flex items-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                加载搜索账单中...
              </div>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-lg border p-4 bg-background">
                    <div className="flex items-center gap-2 text-body text-muted-foreground">
                      <Search className="h-4 w-4" />
                      总请求数
                    </div>
                    <div className="mt-2 text-heading font-semibold">
                      {billingOverview?.summary.total_requests ?? 0}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4 bg-background">
                    <div className="flex items-center gap-2 text-body text-muted-foreground">
                      <Coins className="h-4 w-4" />
                      总费用
                    </div>
                    <div className="mt-2 text-heading font-semibold">
                      {toNumber(billingOverview?.summary.total_amount, 4)}{' '}
                      {billingOverview?.summary.currency || 'CREDITS'}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4 bg-background">
                    <div className="flex items-center gap-2 text-body text-muted-foreground">
                      <Globe className="h-4 w-4" />
                      活跃 Provider
                    </div>
                    <div className="mt-2 text-heading font-semibold">
                      {billingOverview?.by_provider.length ?? 0}
                    </div>
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
                  <div className="rounded-lg border p-4 bg-background">
                    <h4 className="font-semibold">按 Provider 分布</h4>
                    <div className="mt-3 space-y-3">
                      {(billingOverview?.by_provider || []).map((row) => (
                        <div key={row.provider_key} className="rounded-md border p-3">
                          <div className="flex items-center justify-between">
                            <Badge variant="outline">{row.provider_key}</Badge>
                            <span className="text-body text-muted-foreground">
                              {row.requests} 次
                            </span>
                          </div>
                          <div className="mt-2 font-mono text-body">
                            {toNumber(row.amount, 4)} CREDITS
                          </div>
                        </div>
                      ))}
                      {(billingOverview?.by_provider.length || 0) === 0 && (
                        <div className="py-6 text-body text-muted-foreground">
                          当前时间范围内暂无搜索账单
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border overflow-hidden bg-background">
                    <div className="border-b px-4 py-3">
                      <h4 className="font-semibold">每日趋势</h4>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-body">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-4 py-2.5 text-left font-medium">日期</th>
                            <th className="px-4 py-2.5 text-right font-medium">请求数</th>
                            <th className="px-4 py-2.5 text-right font-medium">金额</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(billingOverview?.daily || []).map((row) => (
                            <tr key={row.date} className="border-t hover:bg-muted/20">
                              <td className="px-4 py-3">{row.date}</td>
                              <td className="px-4 py-3 text-right">{row.requests}</td>
                              <td className="px-4 py-3 text-right font-mono">
                                {toNumber(row.amount, 4)} CREDITS
                              </td>
                            </tr>
                          ))}
                          {(billingOverview?.daily.length || 0) === 0 && (
                            <tr>
                              <td
                                colSpan={3}
                                className="px-4 py-12 text-center text-muted-foreground"
                              >
                                当前区间暂无账单数据
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border overflow-hidden bg-background">
                  <div className="border-b px-4 py-3">
                    <h4 className="font-semibold">最近账单事件</h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-body">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-medium">时间</th>
                          <th className="px-4 py-2.5 text-left font-medium">Provider</th>
                          <th className="px-4 py-2.5 text-left font-medium">组织</th>
                          <th className="px-4 py-2.5 text-right font-medium">数量</th>
                          <th className="px-4 py-2.5 text-right font-medium">单价</th>
                          <th className="px-4 py-2.5 text-right font-medium">金额</th>
                          <th className="px-4 py-2.5 text-left font-medium">业务类型</th>
                        </tr>
                      </thead>
                      <tbody>
                        {billingEvents.map((event) => (
                          <tr key={event.id} className="border-t hover:bg-muted/20">
                            <td className="px-4 py-3">{formatDateTime(event.occurred_at)}</td>
                            <td className="px-4 py-3">
                              <Badge variant="outline">{event.provider_key || '-'}</Badge>
                            </td>
                            <td className="px-4 py-3 font-mono text-body">
                              {event.organization_id || '-'}
                            </td>
                            <td className="px-4 py-3 text-right">{event.quantity}</td>
                            <td className="px-4 py-3 text-right font-mono">{event.unit_price}</td>
                            <td className="px-4 py-3 text-right font-mono">{event.amount}</td>
                            <td className="px-4 py-3">{event.biz_type || '-'}</td>
                          </tr>
                        ))}
                        {billingEvents.length === 0 && (
                          <tr>
                            <td
                              colSpan={7}
                              className="px-4 py-12 text-center text-muted-foreground"
                            >
                              当前区间暂无搜索计费事件
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </AdminPage>
      <SensitiveActionConfirmDialog
        open={Boolean(providerDeleteTarget)}
        title="删除搜索 Provider"
        targetLabel={providerDeleteTarget?.display_name ?? ''}
        impact="删除后该搜索接口将不可再被默认策略和账单规则引用。"
        confirmText="删除"
        loading={sensitiveLoading}
        onCancel={() => setProviderDeleteTarget(null)}
        onConfirm={(payload) => void handleDeleteProvider(payload)}
      />
      <SensitiveActionConfirmDialog
        open={Boolean(pricingDeleteTarget)}
        title="删除搜索定价规则"
        targetLabel={pricingDeleteTarget?.id ?? ''}
        impact="删除后请求将回落到其他匹配规则，实时影响搜索计费。"
        confirmText="删除规则"
        loading={sensitiveLoading}
        onCancel={() => setPricingDeleteTarget(null)}
        onConfirm={(payload) => void handleDeletePricing(payload)}
      />
    </>
  )
}
