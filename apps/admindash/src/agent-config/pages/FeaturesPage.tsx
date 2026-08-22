import { getApiClient } from '@/api/tabtin-client'
import { AdminPage } from '@/components/admin-page'
import { useCallback, useEffect, useState } from 'react'

const FIELDS = [
  {
    key: 'feat_parallel_tool_execution',
    label: 'Parallel Tool Execution',
    type: 'boolean' as const,
    description: '并行工具执行',
  },
  {
    key: 'feat_tool_cache_enabled',
    label: 'Tool Cache Enabled',
    type: 'boolean' as const,
    description: '工具缓存开关',
  },
  {
    key: 'feat_tool_cache_max_entries',
    label: 'Tool Cache Max Entries',
    type: 'number' as const,
    description: '工具缓存最大条数',
  },
]

export function FeaturesPage() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getApiClient()
      .raw<Record<string, unknown>>('GET', '/services/llm/admin/agent-config/features')
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const result = await getApiClient().raw<Record<string, unknown>>(
        'PUT',
        '/services/llm/admin/agent-config/features',
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
          <h1 className="text-heading font-bold">特性开关</h1>
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
            {field.type === 'boolean' ? (
              <button
                type="button"
                className={`relative h-6 w-11 rounded-full transition-colors ${config[field.key] ? 'bg-primary' : 'bg-muted'}`}
                onClick={() => setConfig((c) => ({ ...c, [field.key]: !c[field.key] }))}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${config[field.key] ? 'translate-x-5' : ''}`}
                />
              </button>
            ) : (
              <input
                type="number"
                className="w-28 rounded-md border px-2 py-1 text-body text-right bg-background"
                value={(config[field.key] as number) || ''}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    [field.key]: Number.parseInt(e.target.value, 10) || 0,
                  }))
                }
              />
            )}
          </div>
        ))}
      </div>
    </AdminPage>
  )
}
