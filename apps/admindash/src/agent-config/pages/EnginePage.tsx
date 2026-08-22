import { getApiClient } from '@/api/tabtin-client'
import { AdminPage } from '@/components/admin-page'
import { useCallback, useEffect, useState } from 'react'

interface ConfigField {
  key: string
  label: string
  type: 'number' | 'boolean'
  description: string
}

const FIELDS: ConfigField[] = [
  {
    key: 'engine_max_iterations',
    label: 'Max Iterations',
    type: 'number',
    description: '主 Agent 最大迭代轮次',
  },
  {
    key: 'engine_task_max_iterations',
    label: 'Task Max Iterations',
    type: 'number',
    description: '子任务最大迭代轮次',
  },
  {
    key: 'engine_max_tool_calls',
    label: 'Max Tool Calls',
    type: 'number',
    description: '单轮最大工具调用数',
  },
  {
    key: 'engine_task_timeout',
    label: 'Task Timeout (s)',
    type: 'number',
    description: '任务超时（秒）',
  },
  {
    key: 'engine_subagent_timeout',
    label: 'SubAgent Timeout (s)',
    type: 'number',
    description: '子 Agent 超时（秒）',
  },
  {
    key: 'engine_max_plan_steps',
    label: 'Max Plan Steps',
    type: 'number',
    description: '最大计划步骤数',
  },
  {
    key: 'engine_allow_clarification',
    label: 'Allow Clarification',
    type: 'boolean',
    description: '允许 Agent 反向提问',
  },
  {
    key: 'subagent_max_active',
    label: 'SubAgent Max Active',
    type: 'number',
    description: '最大并行子 Agent 数',
  },
  {
    key: 'subagent_queue_limit',
    label: 'SubAgent Queue Limit',
    type: 'number',
    description: '每会话子 Agent 队列上限',
  },
  {
    key: 'subagent_global_queue_limit',
    label: 'Global Queue Limit',
    type: 'number',
    description: '全局子 Agent 队列上限',
  },
]

export function EnginePage() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getApiClient()
      .raw<Record<string, unknown>>('GET', '/services/llm/admin/agent-config/engine')
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const result = await getApiClient().raw<Record<string, unknown>>(
        'PUT',
        '/services/llm/admin/agent-config/engine',
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
          <h1 className="text-heading font-bold">Engine 参数</h1>
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
                className={`relative h-6 w-11 rounded-full transition-colors ${
                  config[field.key] ? 'bg-primary' : 'bg-muted'
                }`}
                onClick={() => setConfig((c) => ({ ...c, [field.key]: !c[field.key] }))}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    config[field.key] ? 'translate-x-5' : ''
                  }`}
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
