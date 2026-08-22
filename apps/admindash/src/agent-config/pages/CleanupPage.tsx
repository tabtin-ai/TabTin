import { getApiClient } from '@/api/tabtin-client'
import { AdminPage } from '@/components/admin-page'
import { useCallback, useEffect, useState } from 'react'

const FIELDS = [
  {
    key: 'cleanup_trace_retention_days',
    label: 'Trace Retention (天)',
    description: 'Trace 保留天数',
  },
  {
    key: 'cleanup_stale_subagent_minutes',
    label: 'Stale SubAgent (分钟)',
    description: '过期子 Agent 清理阈值',
  },
  {
    key: 'cleanup_blocks_retention_hours',
    label: 'Blocks Retention (小时)',
    description: 'Blocks 保留小时数',
  },
]

export function CleanupPage() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getApiClient()
      .raw<Record<string, unknown>>('GET', '/services/llm/admin/agent-config/cleanup')
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const result = await getApiClient().raw<Record<string, unknown>>(
        'PUT',
        '/services/llm/admin/agent-config/cleanup',
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
          <h1 className="text-heading font-bold">后台清理</h1>
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
              className="w-28 rounded-md border px-2 py-1 text-body text-right bg-background"
              value={(config[field.key] as number) || ''}
              onChange={(e) =>
                setConfig((c) => ({ ...c, [field.key]: Number.parseInt(e.target.value, 10) || 0 }))
              }
            />
          </div>
        ))}
      </div>
    </AdminPage>
  )
}
