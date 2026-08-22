/** 新建 Provider：保存账号、密钥和新模型默认端点；模型仍可独立覆盖 endpoint。 */

import { useEffect, useMemo, useState } from 'react'
import {
  type CapabilityDomain,
  type CreateProviderPayload,
  type ProviderScope,
  type ProviderTypeItem,
  providersApi,
} from '../../api/providers'
import {
  PROVIDER_CAPABILITY_DOMAINS,
  resolveProviderTypeCapabilities,
} from './providerCapabilities'

interface ProviderCreateDialogProps {
  open: boolean
  initialDomain: CapabilityDomain
  onClose: () => void
  onCreated: () => void
  /** 组织详情等场景：锁定 scope，隐藏 scope / user 选择 */
  lockedScope?: ProviderScope
  /** 与 lockedScope=organization 联用：预填并锁定 organization_id */
  lockedOrganizationId?: string
}

const SCOPES: { value: ProviderScope; label: string }[] = [
  { value: 'global', label: '平台公用（推荐）' },
  { value: 'organization', label: '指定组织自有密钥' },
  { value: 'user', label: '指定用户自有密钥' },
]

interface FormState {
  display_name: string
  provider_key: string
  capability_domains: CapabilityDomain[]
  name: string
  base_url: string
  api_key: string
  scope: ProviderScope
  organization_id: string
  user_id: string
  priority: string
  rate_limit: string
  routing_enabled: boolean
}

const initialForm = (
  domain: CapabilityDomain,
  lockedScope?: ProviderScope,
  lockedOrganizationId?: string
): FormState => ({
  display_name: '',
  provider_key: '',
  capability_domains: [domain],
  name: '',
  base_url: '',
  api_key: '',
  scope: lockedScope ?? 'global',
  organization_id: lockedOrganizationId ?? '',
  user_id: '',
  priority: '0',
  rate_limit: '60',
  routing_enabled: true,
})

/**
 * 红色 BYOK banner（scope=organization / user 时显示）
 *
 * 文案：
 *   - 解释路线 B 含义
 *   - 列举 13+ 个走平台计费的辅助场景
 *   - 链接到完整边界文档
 */
function ByokDisclaimerBanner() {
  return (
    <div
      role="alert"
      data-testid="byok-disclaimer-banner"
      className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-caption text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
    >
      <div className="flex items-start gap-2">
        <span className="text-base leading-none">⚠️</span>
        <div className="space-y-1.5">
          <p className="font-bold">关于 BYOK Provider 的边界说明（路线 B）</p>
          <p>
            此渠道（scope ={' '}
            <code className="rounded bg-red-100 px-1 dark:bg-red-900/40">workteam</code> /{' '}
            <code className="rounded bg-red-100 px-1 dark:bg-red-900/40">user</code>）将作为 BYOK
            凭据，
            <strong className="font-semibold">仅在主对话生命周期内生效</strong>—— 即用户在聊天窗口与
            Agent 对话时，Agent 调用大模型生成回复的那部分。
          </p>
          <p>
            平台 13+ 个辅助 AI 场景（标题生成、邮件 AI、记忆抽取、用户画像、Skill 演化、
            文档视觉解析、Embedding、ASR、TTS、媒体生成等）由平台统一管理，
            <strong className="font-semibold">
              强制走 global scope provider 并按标准计价从团队钱包扣费
            </strong>
            ， 不会被这个 BYOK provider 覆盖。
          </p>
          <p>
            <a
              href="/docs/byok-scope"
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium underline hover:no-underline"
            >
              如需查看完整边界 → 03 BYOK 边界 v0.1 ↗
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}

function GlobalScopeBanner() {
  return (
    <div
      role="note"
      data-testid="global-scope-banner"
      className="rounded-md border border-blue-300 bg-blue-50 p-3 text-caption text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200"
    >
      <div className="flex items-start gap-2">
        <span className="text-base leading-none">ℹ️</span>
        <div className="space-y-1">
          <p className="font-semibold">平台公用渠道</p>
          <p>所有组织都可使用这个渠道；系统会按路由规则选择主模型或备用模型，并从团队钱包扣费。</p>
        </div>
      </div>
    </div>
  )
}

export function ProviderCreateDialog({
  open,
  initialDomain,
  onClose,
  onCreated,
  lockedScope,
  lockedOrganizationId,
}: ProviderCreateDialogProps) {
  const [form, setForm] = useState<FormState>(() =>
    initialForm(initialDomain, lockedScope, lockedOrganizationId)
  )
  const [providerTypes, setProviderTypes] = useState<ProviderTypeItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [providerTypesError, setProviderTypesError] = useState('')

  const isByokScope = form.scope === 'organization' || form.scope === 'user'
  const scopeLocked = Boolean(lockedScope)

  useEffect(() => {
    if (!open) return
    setForm(initialForm(initialDomain, lockedScope, lockedOrganizationId))
    setError('')
    setProviderTypesError('')

    providersApi
      .getProviderTypes()
      .then((data) => {
        setProviderTypes(data.provider_types)
        if (data.provider_types.length > 0) {
          const firstType = data.provider_types[0]
          const recommendedCapabilities = resolveProviderTypeCapabilities(firstType)
          setForm((prev) => ({
            ...prev,
            name: firstType.name,
            base_url: firstType.default_base_url || '',
            capability_domains:
              recommendedCapabilities.length > 0
                ? recommendedCapabilities
                : prev.capability_domains,
            scope: lockedScope ?? prev.scope,
            organization_id: lockedOrganizationId ?? prev.organization_id,
          }))
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setProviderTypesError(`provider 类型列表加载失败：${msg}`)
      })
  }, [open, initialDomain, lockedScope, lockedOrganizationId])

  const selectedType = useMemo(
    () => providerTypes.find((t) => t.name === form.name) || null,
    [providerTypes, form.name]
  )

  const handleTypeChange = (name: string) => {
    const providerType = providerTypes.find((item) => item.name === name)
    const recommendedCapabilities = resolveProviderTypeCapabilities(providerType)
    setForm((prev) => ({
      ...prev,
      name,
      base_url: providerType?.default_base_url || '',
      capability_domains:
        recommendedCapabilities.length > 0 ? recommendedCapabilities : prev.capability_domains,
    }))
  }

  const handleSubmit = async () => {
    setError('')
    if (!form.display_name.trim()) {
      setError('请填写渠道名称')
      return
    }
    if (!form.name.trim()) {
      setError('请选择服务类型')
      return
    }
    if (!form.api_key.trim()) {
      setError('请填写 API 密钥')
      return
    }
    if (!form.base_url.trim()) {
      setError('请填写 API 地址')
      return
    }
    if (form.capability_domains.length === 0) {
      setError('请至少选择 1 个能力域')
      return
    }
    if (form.scope === 'organization' && !form.organization_id.trim()) {
      setError('scope=organization 必填 organization_id')
      return
    }
    if (form.scope === 'user' && !form.user_id.trim()) {
      setError('scope=user 必填 user_id')
      return
    }

    const payload: CreateProviderPayload = {
      name: form.name.trim(),
      provider_key: form.provider_key.trim() || undefined,
      display_name: form.display_name.trim(),
      base_url: form.base_url.trim(),
      api_key: form.api_key.trim(),
      capability_domains: form.capability_domains,
      scope: form.scope,
      organization_id: form.scope === 'organization' ? form.organization_id.trim() : undefined,
      user_id: form.scope === 'user' ? form.user_id.trim() : undefined,
      routing_enabled: form.routing_enabled,
      priority: Number(form.priority) || 0,
      rate_limit: Number(form.rate_limit) || 60,
    }

    setSubmitting(true)
    try {
      await providersApi.create(payload)
      onCreated()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-subtitle font-semibold">接入模型渠道</h2>
          <p className="text-caption text-muted-foreground mt-1">
            先连接官方平台或中转站，创建后再添加该渠道提供的具体模型。
          </p>
        </div>

        {/* BYOK / global banner — 顶部固定 */}
        <div className="mb-4">{isByokScope ? <ByokDisclaimerBanner /> : <GlobalScopeBanner />}</div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-create-display-name">
                渠道名称
              </label>
              <input
                id="provider-create-display-name"
                type="text"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                placeholder="例如：OpenAI 主线"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-create-provider-key">
                渠道标识（高级、可选）
              </label>
              <input
                id="provider-create-provider-key"
                type="text"
                className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
                placeholder="一般留空即可"
                value={form.provider_key}
                onChange={(e) => setForm({ ...form, provider_key: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-create-provider-type">
              服务类型 <span className="text-red-500">*</span>
            </label>
            <select
              id="provider-create-provider-type"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={form.name}
              onChange={(e) => handleTypeChange(e.target.value)}
            >
              <option value="" disabled>
                请选择模型所属的平台...
              </option>
              {providerTypes.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.display_name}
                </option>
              ))}
            </select>
            {providerTypesError && <p className="text-[10px] text-red-600">{providerTypesError}</p>}
          </div>

          <div className="space-y-1.5">
            <span className="text-body font-medium">
              渠道能力 <span className="text-red-500">*</span>
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                （已按服务类型自动选择，可调整）
              </span>
            </span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md border px-3 py-2 bg-background">
              {PROVIDER_CAPABILITY_DOMAINS.map((domain) => {
                const checked = form.capability_domains.includes(domain.value)
                return (
                  <label
                    key={domain.value}
                    className="inline-flex items-center gap-1.5 text-body cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={checked}
                      onChange={(event) => {
                        setForm((prev) => {
                          const selected = new Set(prev.capability_domains)
                          if (event.target.checked) selected.add(domain.value)
                          else selected.delete(domain.value)
                          return {
                            ...prev,
                            capability_domains: PROVIDER_CAPABILITY_DOMAINS.map(
                              (item) => item.value
                            ).filter((value) => selected.has(value)),
                          }
                        })
                      }}
                    />
                    <span>{domain.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-caption text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            使用中转站时，仍按它承载的模型选择类型：Qwen 选「Qwen」，DeepSeek
            选「DeepSeek」。只有通用 OpenAI-compatible 中转站才选「OpenAI」；除非明确支持 Responses
            API，否则不要选「OpenAI Codex」。
          </div>

          {selectedType?.api_style && (
            <p className="text-[11px] text-muted-foreground">
              API 风格：<span className="font-medium">{selectedType.api_style}</span>
              {selectedType.notes.length > 0 && ` · ${selectedType.notes[0]}`}
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-create-base-url">
              API 地址 <span className="text-red-500">*</span>
            </label>
            <input
              id="provider-create-base-url"
              type="url"
              className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
              placeholder="https://api.openai.com/v1"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            />
            <p className="text-[10px] text-muted-foreground">
              从服务商或中转站的 API 文档复制，通常以 /v1 结尾。后续每个模型也可单独修改。
              同一使用范围内，相同服务类型和 API
              地址只能创建一个渠道；多个密钥请在创建后的“密钥”页添加。
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-create-api-key">
              API 密钥 <span className="text-red-500">*</span>
            </label>
            <input
              id="provider-create-api-key"
              type="password"
              autoComplete="off"
              className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
              placeholder="sk-..."
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
            <p className="text-[10px] text-muted-foreground">
              密钥保存后仅显示前缀和后 4 位，不可读取明文
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium" htmlFor="provider-create-scope">
              使用范围
            </label>
            <select
              id="provider-create-scope"
              className="w-full rounded-md border px-3 py-2 text-body bg-background disabled:opacity-60"
              value={form.scope}
              disabled={scopeLocked}
              onChange={(e) => setForm({ ...form, scope: e.target.value as ProviderScope })}
            >
              {(scopeLocked ? SCOPES.filter((s) => s.value === form.scope) : SCOPES).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            {scopeLocked ? (
              <p className="text-[10px] text-muted-foreground">
                已锁定为当前组织的 BYOK 渠道（不展示 user-scope）
              </p>
            ) : null}
          </div>

          {form.scope === 'organization' && (
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-create-organization-id">
                组织 ID <span className="text-red-500">*</span>
              </label>
              <input
                id="provider-create-organization-id"
                type="text"
                className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background disabled:opacity-60"
                placeholder="organization-xxxxxxxx"
                value={form.organization_id}
                disabled={Boolean(lockedOrganizationId)}
                onChange={(e) => setForm({ ...form, organization_id: e.target.value })}
              />
            </div>
          )}

          {form.scope === 'user' && !scopeLocked && (
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-create-user-id">
                用户 ID <span className="text-red-500">*</span>
              </label>
              <input
                id="provider-create-user-id"
                type="text"
                className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
                placeholder="user-xxxxxxxx"
                value={form.user_id}
                onChange={(e) => setForm({ ...form, user_id: e.target.value })}
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-create-priority">
                优先级
              </label>
              <input
                id="provider-create-priority"
                type="number"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-body font-medium" htmlFor="provider-create-rate-limit">
                每分钟请求上限
              </label>
              <input
                id="provider-create-rate-limit"
                type="number"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.rate_limit}
                onChange={(e) => setForm({ ...form, rate_limit: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 flex flex-col">
              <span className="text-body font-medium">启用这个渠道</span>
              <label className="inline-flex items-center gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={form.routing_enabled}
                  onChange={(e) => setForm({ ...form, routing_enabled: e.target.checked })}
                  className="rounded"
                />
                <span className="text-caption text-muted-foreground">可被系统选中</span>
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
            {submitting ? '创建中…' : '创建渠道'}
          </button>
        </div>
      </div>
    </div>
  )
}
