import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { multimodalApi } from '../../api/multimodal'
import type { VisionSubPageData } from '../../api/multimodal'

/**
 * Tab 2：Vision — 宪法 §1.6 Vision 子 Tab。
 *
 * 包含：
 *   - VLM 当前 SceneBinding（vision_parse_document）
 *   - model 的 capability 校验状态
 */
export function VisionSubPage() {
  const [data, setData] = useState<VisionSubPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    multimodalApi
      .vision()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">加载中...</div>
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-body text-red-900">
        加载失败：{error}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-subtitle font-semibold">Vision (VLM)</h3>
          <p className="text-caption text-muted-foreground">
            {data.scenes.length} 个 scene · {data.available_models.length} 个支持 vision 的模型
          </p>
        </div>
        <Link
          to="/ai/providers?domain=vision"
          className="text-caption text-primary hover:underline"
        >
          管理 Vision Provider →
        </Link>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-4 py-3 text-left font-medium">Scene</th>
              <th className="px-4 py-3 text-left font-medium">显示名</th>
              <th className="px-4 py-3 text-left font-medium">Primary Model</th>
              <th className="px-4 py-3 text-center font-medium">校验</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.scenes.map((scene) => (
              <tr key={scene.scene_key} className="border-b hover:bg-muted/20">
                <td className="px-4 py-3">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                    {scene.scene_key}
                  </code>
                </td>
                <td className="px-4 py-3" title={scene.description}>
                  {scene.display_name}
                </td>
                <td className="px-4 py-3">
                  {scene.binding ? (
                    <div>
                      <div className="font-medium">{scene.binding.primary_model.display_name}</div>
                      <div className="text-caption text-muted-foreground font-mono">
                        {scene.binding.primary_model.model_name} ·{' '}
                        {scene.binding.primary_model.provider_display_name ||
                          scene.binding.primary_model.provider_name}
                      </div>
                    </div>
                  ) : (
                    <span className="text-red-500">未绑定</span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  {scene.capability_validation === 'satisfied' && scene.binding !== null ? (
                    <span className="text-green-600">✓</span>
                  ) : (
                    <span
                      className="text-red-600"
                      title={
                        scene.capability_issues.length > 0
                          ? scene.capability_issues.join(', ')
                          : 'binding 未配置'
                      }
                    >
                      ✗
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to={`/ai/scenes?scene_key=${encodeURIComponent(scene.scene_key)}`}
                    className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                  >
                    编辑绑定
                  </Link>
                </td>
              </tr>
            ))}
            {data.scenes.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  没有 vision scene 注册。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border p-3">
        <div className="text-body font-medium mb-2">支持 Vision 的可用模型</div>
        {data.available_models.length === 0 ? (
          <div className="text-caption text-muted-foreground">
            没有任何 capability_domain=vision 的可用模型。请到{' '}
            <Link to="/ai/models" className="text-primary hover:underline">
              /ai/models
            </Link>{' '}
            创建。
          </div>
        ) : (
          <ul className="space-y-1">
            {data.available_models.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-caption">
                <code className="rounded bg-muted px-1 py-0.5 font-mono">{m.model_name}</code>
                <span>{m.display_name}</span>
                <span className="text-muted-foreground">
                  · {m.provider_display_name || m.provider_name}
                </span>
                {m.supports_vision === false && (
                  <span className="text-yellow-700">
                    ⚠ capabilities_config.supports_vision=false
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
