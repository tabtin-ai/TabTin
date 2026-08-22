import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { AlertTriangle, Loader2, RefreshCw, Save, Settings2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// AdminDash 使用 BrowserRouter，不能用 useBlocker（仅 data router 可用，否则整页白屏）。
// 未保存离开仅靠 beforeunload；站内跳转暂不拦截。见 。
import { useNavigate } from 'react-router-dom'
import { formatDateTime } from '@/lib/utils'
import {
  type BillingRuntimeConfig,
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../api/billing-admin'

type ConfigKey = keyof Omit<BillingRuntimeConfig, 'updated_at' | 'updated_by'>

interface FieldDef {
  key: ConfigKey
  label: string
  hint: string
  type: 'number' | 'decimal' | 'json' | 'boolean'
  min?: number
  max?: number
}

const FIELD_GROUPS: { title: string; description: string; fields: FieldDef[] }[] = [
  {
    title: '换算比例',
    description: '影响冻结金额预估和前端费用展示。',
    fields: [
      {
        key: 'credits_per_yuan',
        label: 'credits/元换算比例',
        hint: '1 元 = N credits',
        type: 'number',
        min: 1,
        max: 100000,
      },
    ],
  },
  {
    title: '冻结参数',
    description: '控制 LLM 调用前的冻结金额预估逻辑。',
    fields: [
      {
        key: 'freeze_fallback_credits',
        label: '冻结保底金额（credits）',
        hint: '首轮或无法估算时的保底冻结金额',
        type: 'decimal',
        min: 0,
      },
      {
        key: 'freeze_est_input_tokens',
        label: '首轮预估输入 tokens',
        hint: '首轮冻结预估输入 token 数',
        type: 'number',
        min: 0,
        max: 1000000,
      },
      {
        key: 'freeze_est_output_tokens',
        label: '首轮预估输出 tokens',
        hint: '首轮冻结预估输出 token 数',
        type: 'number',
        min: 0,
        max: 1000000,
      },
    ],
  },
  {
    title: '预检参数',
    description: '余额预检和 fail-open 降级机制。',
    fields: [
      {
        key: 'min_balance_threshold',
        label: '余额放行最低阈值（credits）',
        hint: '组织可用余额低于此值时阻断 LLM 调用',
        type: 'decimal',
        min: 0,
      },
      {
        key: 'precheck_fail_threshold',
        label: 'Fail-open 连续异常阈值',
        hint: '预检连续异常超过此次数后切换为 fail-closed',
        type: 'number',
        min: 1,
        max: 1000,
      },
      {
        key: 'failopen_max_credits',
        label: 'Fail-open 累计上限（credits）',
        hint: 'fail-open 期间允许的最大累计放行金额',
        type: 'decimal',
        min: 0,
      },
      {
        key: 'precheck_fail_window',
        label: '异常窗口（秒）',
        hint: '超过此秒数无新异常时自动重置计数器',
        type: 'number',
        min: 1,
        max: 86400,
      },
    ],
  },
  {
    title: '运行时参数',
    description: '余额复检、冻结清理和缓存控制。',
    fields: [
      {
        key: 'balance_recheck_interval',
        label: '余额复检间隔（每 N 轮）',
        hint: 'Agent 运行中每 N 轮 LLM 调用复检一次余额',
        type: 'number',
        min: 1,
        max: 100,
      },
      {
        key: 'stale_freeze_threshold_minutes',
        label: '冻结超时阈值（分钟）',
        hint: '超过此时长未结算/释放的冻结将被定时清理',
        type: 'number',
        min: 1,
        max: 10080,
      },
      {
        key: 'pricing_cache_ttl',
        label: '定价缓存 TTL（秒）',
        hint: 'MeterPricing 查询结果的 Redis 缓存有效期',
        type: 'number',
        min: 1,
        max: 86400,
      },
    ],
  },
  {
    title: 'Provider 缓存折扣',
    description: '格式: {"anthropic": {"cache_read_ratio": 0.1, "cache_write_ratio": 1.25}, ...}',
    fields: [
      {
        key: 'cache_discount_config',
        label: '缓存折扣率配置',
        hint: 'JSON 格式，按 provider 配置 cache_read_ratio 和 cache_write_ratio',
        type: 'json',
      },
    ],
  },
  {
    title: '前端展示',
    description: '控制计费信息在客户端的展示行为。',
    fields: [
      {
        key: 'show_per_message_cost',
        label: '展示每条消息费用',
        hint: '开启后，assistant 消息底部显示本条消耗的 credits 数。关闭可减轻成员费用焦虑。',
        type: 'boolean',
      },
    ],
  },
  {
    title: '计费策略阈值',
    description: '控制同步/异步分流、fail-open 阻断、内部 LLM 调用守护和大额审核等核心策略参数。',
    fields: [
      {
        key: 'sync_charge_threshold_credits',
        label: '同步扣款阈值（credits）',
        hint: '单次预期金额 ≥ 此值走同步扣款，否则进入异步聚合',
        type: 'number',
        min: 1,
        max: 100000,
      },
      {
        key: 'fail_open_24h_block_threshold',
        label: 'Fail-open 24h 阻断阈值',
        hint: '单 organization 24 小时内 fail-open 累计超过此次数后自动冻结服务',
        type: 'number',
        min: 1,
        max: 10000,
      },
      {
        key: 'internal_llm_call_balance_guard_pct',
        label: '内部 LLM 调用余额守护（%）',
        hint: '一小时累计成本超过 max(余额×此百分比, 下限) 时强制阻断',
        type: 'number',
        min: 1,
        max: 100,
      },
      {
        key: 'internal_llm_call_balance_guard_floor',
        label: '内部 LLM 调用余额守护下限（credits）',
        hint: '与百分比取 max，避免低余额时误杀基础记忆功能',
        type: 'number',
        min: 0,
        max: 100000,
      },
      {
        key: 'large_charge_review_threshold_credits',
        label: '大额扣费审核阈值（credits）',
        hint: '单次扣费超过此值进入待审核，不直接扣款',
        type: 'number',
        min: 1,
        max: 1000000,
      },
    ],
  },
]


function ConfigField({
  def,
  value,
  onChange,
}: {
  def: FieldDef
  value: string
  onChange: (value: string) => void
}) {
  const id = `config-${def.key}`

  return (
    <div>
      <label className="text-body font-medium" htmlFor={id}>
        {def.label}
      </label>
      {def.type === 'boolean' ? (
        <div className="mt-1 flex items-center gap-2">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          />
          <span className="text-body text-muted-foreground">
            {value === 'true' ? '已开启' : '已关闭'}
          </span>
        </div>
      ) : def.type === 'json' ? (
        <textarea
          id={id}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-body font-mono focus:outline-none focus:ring-2 focus:ring-ring"
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          className="mt-1"
          type={def.type === 'number' || def.type === 'decimal' ? 'number' : 'text'}
          step={def.type === 'decimal' ? '0.01' : undefined}
          min={def.min}
          max={def.max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="mt-1 text-body text-muted-foreground">{def.hint}</p>
    </div>
  )
}

function configToForm(c: BillingRuntimeConfig): Record<string, string> {
  const result: Record<string, string> = {}
  for (const group of FIELD_GROUPS) {
    for (const field of group.fields) {
      const raw = c[field.key]
      result[field.key] = field.type === 'json' ? JSON.stringify(raw, null, 2) : String(raw ?? '')
    }
  }
  return result
}

export function RuntimeConfigPage({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [config, setConfig] = useState<BillingRuntimeConfig | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const loadVersionRef = useRef(0)

  const changedFields = useMemo(() => {
    if (!config) return []
    const original = configToForm(config)
    return FIELD_GROUPS.flatMap((g) => g.fields)
      .filter((f) => form[f.key] !== original[f.key])
      .map((f) => ({
        key: f.key,
        label: f.label,
        oldValue: original[f.key],
        newValue: form[f.key],
      }))
  }, [config, form])

  const dirty = changedFields.length > 0

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const validateForm = (): string | null => {
    for (const group of FIELD_GROUPS) {
      for (const field of group.fields) {
        const raw = form[field.key]
        if (field.type === 'number' || field.type === 'decimal') {
          const n = Number(raw)
          if (!Number.isFinite(n)) return `${field.label} 必须为有效数值`
          if (field.min != null && n < field.min) return `${field.label} 不能小于 ${field.min}`
          if (field.max != null && n > field.max) return `${field.label} 不能大于 ${field.max}`
        }
        if (field.type === 'json') {
          try {
            JSON.parse(raw || '{}')
          } catch {
            return `${field.label} JSON 格式错误`
          }
        }
      }
    }
    return null
  }

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const data = await getRuntimeConfig()
      if (loadVersionRef.current !== version) return
      setConfig(data)
      setForm(configToForm(data))
    } catch {
      if (loadVersionRef.current !== version) return
      setLoadError(true)
      showToast('加载配置失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const handleFieldChange = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleReset = () => {
    if (config) {
      setForm(configToForm(config))
    }
  }

  const handleSaveClick = () => {
    const error = validateForm()
    if (error) {
      showToast(error, 'error')
      return
    }
    if (changedFields.length === 0) return
    setShowConfirmDialog(true)
  }

  const executeSave = async () => {
    setSaving(true)
    try {
      const allFields = FIELD_GROUPS.flatMap((g) => g.fields)
      const fieldByKey = new Map(allFields.map((f) => [f.key, f]))
      const payload: Record<string, unknown> = {}
      for (const changed of changedFields) {
        const def = fieldByKey.get(changed.key)
        if (!def) continue
        const raw = changed.newValue
        if (def.type === 'json') {
          payload[def.key] = JSON.parse(raw || '{}')
        } else if (def.type === 'number') {
          payload[def.key] = Number(raw)
        } else if (def.type === 'boolean') {
          payload[def.key] = raw === 'true'
        } else {
          payload[def.key] = raw
        }
      }

      const updated = await updateRuntimeConfig(payload as Partial<BillingRuntimeConfig>)
      setConfig(updated)
      setForm(configToForm(updated))
      setShowConfirmDialog(false)
      showToast('配置已保存', 'success')
    } catch (error) {
      if (error instanceof SyntaxError) {
        showToast('JSON 格式错误，请检查缓存折扣配置', 'error')
      } else {
        showToast(error instanceof Error ? error.message : '保存失败', 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <AdminPage className={embedded ? 'space-y-4' : undefined}>
      {toastEl}

      <AdminPageHeader
        title="计费运行时配置"
        icon={Settings2}
        back={
          embedded
            ? undefined
            : {
                label: '返回商品与定价',
                onClick: () => navigate('/billing/products'),
              }
        }
        badges={
          config ? (
            <>
              <Badge variant="outline">最后更新：{formatDateTime(config.updated_at)}</Badge>
              {config.updated_by && <Badge variant="outline">更新人：{config.updated_by}</Badge>}
            </>
          ) : null
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        }
      />

      {loading && !config ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-body text-muted-foreground">配置加载失败，请检查网络后重试。</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : (
        <>
          {FIELD_GROUPS.map((group) => (
            <AdminListCard
              key={group.title}
              title={group.title}
              description={group.description}
              contentClassName="space-y-4"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {group.fields.map((field) =>
                  field.type === 'json' ? null : (
                    <ConfigField
                      key={field.key}
                      def={field}
                      value={form[field.key] ?? ''}
                      onChange={(v) => handleFieldChange(field.key, v)}
                    />
                  )
                )}
              </div>
              {group.fields
                .filter((f) => f.type === 'json')
                .map((field) => (
                  <ConfigField
                    key={field.key}
                    def={field}
                    value={form[field.key] ?? '{}'}
                    onChange={(v) => handleFieldChange(field.key, v)}
                  />
                ))}
            </AdminListCard>
          ))}

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={handleSaveClick} disabled={saving || !dirty}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {saving ? '保存中...' : '保存配置'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleReset} disabled={!dirty}>
              <Undo2 className="mr-2 h-4 w-4" />
              重置修改
            </Button>
            {dirty && <span className="text-body text-muted-foreground">有未保存的修改</span>}
          </div>
        </>
      )}

      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认保存配置</DialogTitle>
            <DialogDescription>请仔细检查以下变更，确认后将提交保存。</DialogDescription>
          </DialogHeader>

          <div className="max-h-60 space-y-2 overflow-y-auto">
            {changedFields.map((f) => (
              <div key={f.key} className="rounded-md border px-3 py-2">
                <p className="text-body font-medium">{f.label}</p>
                <p className="text-caption text-muted-foreground">
                  <span className="text-destructive line-through">{f.oldValue}</span>
                  {' → '}
                  <span className="text-emerald-600 dark:text-emerald-400">{f.newValue}</span>
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 dark:bg-amber-950/20">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-caption text-amber-700 dark:text-amber-400">
                此操作将影响所有组织的计费行为
              </p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-caption text-muted-foreground">配置将在约 30 秒内全局生效</p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowConfirmDialog(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button size="sm" onClick={() => void executeSave()} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  保存中...
                </>
              ) : (
                '确认保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
