import { getApiClient } from '@/api/tabtin-client'
import { AdminPage } from '@/components/admin-page'
import { useCallback, useEffect, useState } from 'react'

//  第三波：三档阈值经 prompt.forward 下发宿主 EngineConfig.pressureThresholds
// （云端 > env 旋钮 > runtime 默认）。字段必须满足 high <= trigger < critical。
const FIELDS = [
  {
    key: 'ctx_default_window_tokens',
    label: 'Default Window Tokens',
    type: 'number' as const,
    description: '默认上下文窗口 token 数',
  },
  {
    key: 'ctx_pressure_high',
    label: 'Micro Compact Start',
    type: 'float' as const,
    description: '微压缩档起点（压力占比，默认 0.75）',
  },
  {
    key: 'ctx_summary_trigger_fraction',
    label: 'Summary Start',
    type: 'float' as const,
    description: 'LLM 摘要档起点（压力占比，默认 0.85）',
  },
  {
    key: 'ctx_pressure_critical',
    label: 'Emergency Start',
    type: 'float' as const,
    description: '紧急硬截断档起点（压力占比，默认 0.95）',
  },
]

export function ContextPage() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getApiClient()
      .raw<Record<string, unknown>>('GET', '/services/llm/admin/agent-config/context')
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const result = await getApiClient().raw<Record<string, unknown>>(
        'PUT',
        '/services/llm/admin/agent-config/context',
        { body: config }
      )
      setConfig(result)
    } catch {
      /* ignore */
    } finally {
      setSaving(false)
    }
  }, [config])

  if (loading) return <AdminPage className="text-center text-muted-foreground">加载中...</AdminPage>

  return (
    <AdminPage>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-heading font-bold">上下文管理</h1>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
      <div className="rounded-lg border divide-y">
        {FIELDS.map((field) => (
          <div key={field.key} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-body font-medium">{field.label}</p>
              <p className="text-caption text-muted-foreground">{field.description}</p>
            </div>
            <input
              type="number"
              step={field.type === 'float' ? '0.01' : '1'}
              className="w-28 rounded-md border px-2 py-1 text-body text-right bg-background"
              value={(config[field.key] as number) || ''}
              onChange={(e) =>
                setConfig((c) => ({ ...c, [field.key]: Number.parseFloat(e.target.value) || 0 }))
              }
            />
          </div>
        ))}
      </div>
    </AdminPage>
  )
}
