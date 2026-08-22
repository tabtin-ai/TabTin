import { getApiClient } from '@/api/tabtin-client'
import { AdminPage } from '@/components/admin-page'
import { useCallback, useEffect, useState } from 'react'

const FIELDS = [
  {
    key: 'guard_doom_loop_warn',
    label: 'Doom Loop Warn',
    description: '死循环警告阈值',
  },
  {
    key: 'guard_doom_loop_break',
    label: 'Doom Loop Break',
    description: '死循环中断阈值',
  },
  {
    key: 'guard_tool_output_max_chars',
    label: 'Tool Output Max Chars',
    description: '工具输出最大字符数',
  },
  {
    key: 'guard_max_compaction_attempts',
    label: 'Max Compaction Attempts',
    description: '最大压缩尝试次数',
  },
]

export function GuardPage() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getApiClient()
      .raw<Record<string, unknown>>('GET', '/services/llm/admin/agent-config/guard')
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const result = await getApiClient().raw<Record<string, unknown>>(
        'PUT',
        '/services/llm/admin/agent-config/guard',
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
          <h1 className="text-heading font-bold">安全护栏</h1>
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
                setConfig((c) => ({
                  ...c,
                  [field.key]: Number.parseInt(e.target.value, 10) || 0,
                }))
              }
            />
          </div>
        ))}
      </div>
    </AdminPage>
  )
}
