import { useEffect, useState } from 'react'
import { scenesApi, type ScenePromptData } from '../../api/scenes'

interface PromptDetailProps {
  sceneKey: string
}

type TabKey = 'frontmatter' | 'system' | 'user' | 'preview'

export function PromptDetail({ sceneKey }: PromptDetailProps) {
  const [data, setData] = useState<ScenePromptData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabKey>('frontmatter')
  const [previewVars, setPreviewVars] = useState('{}')
  const [preview, setPreview] = useState<{ rendered_system: string; rendered_user: string } | null>(
    null
  )

  useEffect(() => {
    setLoading(true)
    scenesApi
      .getPrompt(sceneKey)
      .then(setData)
      .finally(() => setLoading(false))
  }, [sceneKey])

  const handlePreview = async () => {
    try {
      const vars = JSON.parse(previewVars)
      const result = await scenesApi.previewPrompt(sceneKey, vars)
      setPreview(result)
    } catch {
      /* ignore */
    }
  }

  if (loading) {
    return <div className="p-4 text-muted-foreground">加载中...</div>
  }

  if (!data) {
    return <div className="p-4 text-muted-foreground">未找到 Prompt Bundle</div>
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'frontmatter', label: 'Frontmatter' },
    { key: 'system', label: 'System' },
    { key: 'user', label: 'User Template' },
    { key: 'preview', label: '调用预览' },
  ]

  return (
    <div>
      <div className="flex gap-1 border-b mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`px-3 py-2 text-body font-medium transition-colors border-b-2 ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'frontmatter' && (
        <pre className="rounded-md bg-muted p-4 text-caption font-mono overflow-auto max-h-96">
          {JSON.stringify(data.frontmatter, null, 2)}
        </pre>
      )}

      {tab === 'system' && (
        <pre className="rounded-md bg-muted p-4 text-caption font-mono overflow-auto max-h-96 whitespace-pre-wrap">
          {data.system_md || '(无 system prompt)'}
        </pre>
      )}

      {tab === 'user' && (
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            {data.variables_detected.map((v) => (
              <span
                key={v}
                className="rounded-full bg-blue-100 px-2 py-0.5 text-caption text-blue-800"
              >
                {`{{ ${v} }}`}
              </span>
            ))}
          </div>
          <pre className="rounded-md bg-muted p-4 text-caption font-mono overflow-auto max-h-96 whitespace-pre-wrap">
            {data.user_template || '(无 user template)'}
          </pre>
        </div>
      )}

      {tab === 'preview' && (
        <div className="space-y-3">
          <textarea
            className="w-full rounded-md border px-3 py-2 text-caption font-mono h-20 bg-background"
            value={previewVars}
            onChange={(e) => setPreviewVars(e.target.value)}
            placeholder='{"variable": "value"}'
          />
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground hover:bg-primary/90"
            onClick={handlePreview}
          >
            渲染预览
          </button>
          {preview && (
            <div className="space-y-2">
              <div>
                <p className="text-caption font-medium mb-1">Rendered System:</p>
                <pre className="rounded-md bg-muted p-3 text-caption font-mono overflow-auto max-h-48 whitespace-pre-wrap">
                  {preview.rendered_system}
                </pre>
              </div>
              <div>
                <p className="text-caption font-medium mb-1">Rendered User:</p>
                <pre className="rounded-md bg-muted p-3 text-caption font-mono overflow-auto max-h-48 whitespace-pre-wrap">
                  {preview.rendered_user}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3 text-caption text-yellow-800">
        Prompt 是产品资产。编辑请走 Git PR：clone 仓库 → 改{' '}
        <code>apps/services/llm/scenes/bundled/{sceneKey}/</code> → 提 PR → 合并后线上自动加载
      </div>
    </div>
  )
}
