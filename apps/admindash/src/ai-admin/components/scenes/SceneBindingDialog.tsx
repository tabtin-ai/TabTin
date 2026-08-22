import { useCallback, useEffect, useState } from 'react'
import { llmAdminApi } from '@/api/llm-admin'
import { scenesApi, type SceneItem } from '../../api/scenes'

interface SceneBindingDialogProps {
  scene: SceneItem | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}

export function SceneBindingDialog({ scene, open, onClose, onSaved }: SceneBindingDialogProps) {
  const [modelId, setModelId] = useState('')
  const [models, setModels] = useState<
    Array<{ id: string; display_name: string; model_name: string; capability_domain?: string; provider_scope?: string }>
  >([])
  const [defaultParams, setDefaultParams] = useState('{}')
  const [timeoutSec, setTimeoutSec] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !scene) return
    setModelId(scene.binding?.primary_model?.id || '')
    setDefaultParams(JSON.stringify(scene.binding?.default_params || {}, null, 2))
    setTimeoutSec(scene.binding?.timeout_sec?.toString() || '')
    setError('')

    llmAdminApi
      .listModels({ includeInactive: false, providerScope: 'global' })
      .then((data) => {
        const filtered = data.models.filter(
          (m) => m.capability_domain === scene.capability_domain
        )
        setModels(
          filtered.map((m) => ({
            id: m.id,
            display_name: m.display_name,
            model_name: m.model_name,
            capability_domain: m.capability_domain,
            provider_scope: m.provider_scope,
          }))
        )
      })
      .catch(() => {})
  }, [open, scene])

  const handleSave = useCallback(async () => {
    if (!scene) return
    setSaving(true)
    setError('')
    try {
      let parsedParams: Record<string, unknown> = {}
      try {
        parsedParams = JSON.parse(defaultParams)
      } catch {
        setError('default_params JSON 格式错误')
        setSaving(false)
        return
      }

      await scenesApi.updateBinding(scene.scene_key, {
        primary_model_id: modelId || undefined,
        default_params: parsedParams,
        timeout_sec: timeoutSec ? parseInt(timeoutSec, 10) : undefined,
      })
      onSaved()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSaving(false)
    }
  }, [scene, modelId, defaultParams, timeoutSec, onSaved, onClose])

  if (!open || !scene) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-subtitle font-semibold mb-1">编辑 Scene 绑定</h2>
        <p className="text-caption text-muted-foreground mb-4">
          <code>{scene.scene_key}</code> — {scene.display_name}
        </p>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-caption text-muted-foreground">
              Domain: <span className="font-medium text-foreground">{scene.capability_domain}</span>
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium">Primary Model</label>
            <select
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">未绑定</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} ({m.model_name})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium">Default Params (JSON)</label>
            <textarea
              className="w-full rounded-md border px-3 py-2 text-caption font-mono h-24 bg-background"
              value={defaultParams}
              onChange={(e) => setDefaultParams(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-body font-medium">Timeout (秒)</label>
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              placeholder="留空则按 latency_class 推导"
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-body font-medium hover:bg-muted transition-colors"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
