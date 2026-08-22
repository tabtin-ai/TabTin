/**
 * 编辑 Provider Modal（v0.1.x）
 *
 * v0.1.x 改动：
 *   - capability_domains 改为可编辑多选（scope 仍不可改）
 *   - 移除能力域时后端会校验：下属 LLMModel.capability_domain 必须仍落在新集合内
 *   - api_key 留空 = 不更新；填则覆盖
 *   - 显示当前 BYOK 状态（scope!='global' 顶部加红色提醒）
 */

import { useEffect, useState } from 'react'
import {
  type CapabilityDomain,
  type ProviderItem,
  type ProviderTypeItem,
  type UpdateProviderPayload,
  providersApi,
} from '../../api/providers'
import { PROVIDER_CAPABILITY_DOMAINS } from './providerCapabilities'

interface ProviderEditDialogProps {
  provider: ProviderItem | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}

const SCOPE_LABELS: Record<ProviderItem['scope'], string> = {
  global: '平台公用',
  organization: '组织专用',
  user: '用户专用',
}

interface FormState {
  provider_key: string
  display_name: string
  base_url: string
  api_key: string
  capability_domains: CapabilityDomain[]
  priority: string
  rate_limit: string
  routing_enabled: boolean
}

const initialForm = (p: ProviderItem | null): FormState => ({
  provider_key: p?.provider_key ?? '',
  display_name: p?.display_name ?? '',
  base_url: p?.base_url ?? '',
  api_key: '',
  capability_domains: [...(p?.capability_domains ?? [])],
  priority: p ? String(p.priority) : '0',
  rate_limit: p ? String(p.rate_limit) : '60',
  routing_enabled: p?.routing_enabled ?? true,
})

export function ProviderEditDialog({ provider, open, onClose, onSaved }: ProviderEditDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(provider))
  const [providerTypes, setProviderTypes] = useState<ProviderTypeItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setForm(initialForm(provider))
      setError('')
      providersApi
        .getProviderTypes()
        .then((data) => setProviderTypes(data.provider_types))
        .catch(() => setProviderTypes([]))
    }
  }, [open, provider])

  if (!open || !provider) return null

  const isByokScope = provider.scope !== 'global'
  const providerType = providerTypes.find((item) => item.name === provider.name)
  const providerTypeLabel =
    providerType && providerType.display_name !== provider.name
      ? `${providerType.display_name}（${provider.name}）`
      : provider.name

  const handleSubmit = async () => {
    setError('')
    if (!form.display_name.trim()) {
      setError('渠道名称不能为空')
      return
    }
    if (form.capability_domains.length === 0) {
      setError('请至少选择一项渠道能力')
      return
    }

    const originalDomains = [...(provider?.capability_domains ?? [])].sort()
    const currentDomains = [...form.capability_domains].sort()
    const domainsChanged =
      originalDomains.length !== currentDomains.length ||
      originalDomains.some((v, i) => v !== currentDomains[i])

    const payload: UpdateProviderPayload = {
      provider_key: form.provider_key.trim() || undefined,
      display_name: form.display_name.trim(),
      base_url: form.base_url.trim() || undefined,
      api_key: form.api_key.trim() || undefined,
      capability_domains: domainsChanged ? form.capability_domains : undefined,
      priority: Number(form.priority) || 0,
      rate_limit: Number(form.rate_limit) || 60,
      routing_enabled: form.routing_enabled,
    }

    setSubmitting(true)
    try {
      await providersApi.update(provider.id, payload)
      onSaved()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="w-full max-w-xl rounded-lg bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-subtitle font-semibold">编辑模型渠道</h2>
            <p className="text-caption text-muted-foreground mt-1">
              <code>{provider.provider_key}</code> · {SCOPE_LABELS[provider.scope]} ·{' '}
              <span className="font-medium">
                {(provider.capability_domains ?? [])
                  .map(
                    (domain) =>
                      PROVIDER_CAPABILITY_DOMAINS.find((item) => item.value === domain)?.label ??
                      domain
                  )
                  .join('、') || '—'}
              </span>
            </p>
          </div>
          {isByokScope && (
            <span
              data-testid="byok-edit-badge"
              className="rounded bg-amber-100 px-2 py-0.5 text-caption font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              BYOK
            </span>
          )}
        </div>

        {isByokScope && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-caption text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            <p>
              ⚠️ 此渠道的使用范围为{' '}
              <code className="rounded bg-amber-100 px-1">{SCOPE_LABELS[provider.scope]}</code>
              ，作为 BYOK 凭据
              <strong className="font-semibold">仅在主对话生命周期内生效</strong>
              （路线 B）。其他辅助 AI 场景仍使用平台公用渠道并按标准计价。
            </p>
            <p className="mt-1">
              <a
                href="/docs/byok-scope"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium underline hover:no-underline"
              >
                查看完整边界 → 03 BYOK 边界 v0.1 ↗
              </a>
            </p>
          </div>
        )}
        <p className={`${isByokScope ? '-mt-2' : ''} mb-3 text-[10px] text-muted-foreground`}>
          说明：使用范围不可修改；渠道能力可多选。移除某项能力时，系统会检查该渠道下的模型是否仍符合配置。
        </p>
        <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-caption text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200">
          默认 API 地址仅用于后续新建模型，不会覆盖已有模型的 API 地址。
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-edit-display-name">
                渠道名称
              </label>
              <input
                id="provider-edit-display-name"
                type="text"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-edit-provider-key">
                渠道标识（provider_key）
              </label>
              <input
                id="provider-edit-provider-key"
                type="text"
                className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
                value={form.provider_key}
                onChange={(e) => setForm({ ...form, provider_key: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-edit-service-type">
              服务类型
            </label>
            <input
              id="provider-edit-service-type"
              type="text"
              className="w-full rounded-md border px-3 py-2 text-body bg-muted text-muted-foreground"
              value={providerTypeLabel}
              disabled
            />
            <p className="text-[10px] text-muted-foreground">
              服务类型决定后端使用的模型适配器，创建后不可修改。
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-edit-base-url">
              默认 API 地址
            </label>
            <input
              id="provider-edit-base-url"
              type="url"
              className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-body font-medium">
              渠道能力 <span className="text-red-500">*</span>
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                （可多选；移除某域会校验下属模型）
              </span>
            </span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md border px-3 py-2 bg-background">
              {PROVIDER_CAPABILITY_DOMAINS.map((d) => {
                const checked = form.capability_domains.includes(d.value)
                return (
                  <label
                    key={d.value}
                    className="inline-flex items-center gap-1.5 text-body cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={checked}
                      onChange={(e) => {
                        setForm((prev) => {
                          const set = new Set(prev.capability_domains)
                          if (e.target.checked) set.add(d.value)
                          else set.delete(d.value)
                          return {
                            ...prev,
                            capability_domains: PROVIDER_CAPABILITY_DOMAINS.map(
                              (x) => x.value
                            ).filter((v) => set.has(v)),
                          }
                        })
                      }}
                    />
                    <span>{d.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-edit-api-key">
              API 密钥（留空则保留原值）
            </label>
            <input
              id="provider-edit-api-key"
              type="password"
              autoComplete="off"
              className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
              placeholder={provider.api_key_masked}
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-edit-priority">
                优先级
              </label>
              <input
                id="provider-edit-priority"
                type="number"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-edit-rate-limit">
                限速（RPM）
              </label>
              <input
                id="provider-edit-rate-limit"
                type="number"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.rate_limit}
                onChange={(e) => setForm({ ...form, rate_limit: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-body font-medium">渠道状态</span>
              <label className="inline-flex items-center gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={form.routing_enabled}
                  onChange={(e) => setForm({ ...form, routing_enabled: e.target.checked })}
                  className="rounded"
                />
                <span className="text-caption text-muted-foreground">参与模型路由</span>
              </label>
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700 dark:bg-red-950/40 dark:border-red-900/60 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-body font-medium hover:bg-muted transition-colors"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
