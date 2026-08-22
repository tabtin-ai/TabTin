import { AdminPage } from '@/components/admin-page'
import { useEffect, useState } from 'react'
import { type PromptItem, promptsApi } from '../api/prompts'
import { PromptDetail } from '../components/prompts/PromptDetail'

export function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    promptsApi
      .list()
      .then((data) => setPrompts(data.prompts))
      .finally(() => setLoading(false))
  }, [])

  return (
    <AdminPage>
      <div>
        <h1 className="text-heading font-bold">提示词资产</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 overflow-y-auto max-h-[calc(100vh-200px)]">
          {loading ? (
            <div className="py-8 text-center text-muted-foreground">加载中...</div>
          ) : (
            <div className="space-y-1">
              {prompts.map((p) => (
                <button
                  key={p.scene_key}
                  type="button"
                  className={`w-full text-left rounded-md px-3 py-2.5 transition-colors ${
                    selected === p.scene_key
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted'
                  }`}
                  onClick={() => setSelected(p.scene_key)}
                >
                  <p className="text-body font-medium">{p.scene_key}</p>
                  <p
                    className={`text-caption ${selected === p.scene_key ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}
                  >
                    {p.capability_domain} · {p.system_char_count} 字符
                    {p.template_variables.length > 0 && ` · ${p.template_variables.length} 变量`}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <div className="rounded-lg border p-4">
              <PromptDetail sceneKey={selected} />
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              选择左侧场景查看提示词组合
            </div>
          )}
        </div>
      </div>
    </AdminPage>
  )
}
