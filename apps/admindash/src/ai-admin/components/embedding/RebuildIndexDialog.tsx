import { ApiError } from '@tabtin/api-client'
import { useEffect, useMemo, useState } from 'react'
import { llmAdminApi } from '@/api/llm-admin'
import { embeddingApi } from '../../api/embedding'
import type { EmbeddingSceneItem } from '../../api/embedding'

interface ModelOption {
  id: string
  display_name: string
  model_name: string
  dimensions: number
}

interface RebuildIndexDialogProps {
  open: boolean
  scenes: EmbeddingSceneItem[]
  onClose: () => void
}

const REQUIRED_DIMENSIONS = 1024

/**
 * Tab 3：重建索引 — v0.1 stub UI。
 *
 *
 *   - v0.1 没有真实数据需要 rebuild
 *   - dimensions 强约束 1024（pgvector 列定义）
 *   - 提交按钮永远会触发后端 422 + FEATURE_NOT_IMPLEMENTED
 *   - 前端要做：选 scene → 选 model（dimensions=1024 校验）→ 二次确认（输入 scene_key）
 *     → 提交后 catch 422 显示 toast banner "重建索引功能未在 v0.1 启用，请等待 v0.2"
 */
export function RebuildIndexDialog({
  open,
  scenes,
  onClose,
}: RebuildIndexDialogProps) {
  const [sceneKey, setSceneKey] = useState('')
  const [newModelId, setNewModelId] = useState('')
  const [confirmInput, setConfirmInput] = useState('')
  const [reason, setReason] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [resultBanner, setResultBanner] = useState<{
    kind: 'info' | 'error'
    title: string
    message: string
  } | null>(null)

  // 加载所有 embedding 模型，前端按 dimensions=1024 过滤展示
  useEffect(() => {
    if (!open) return
    setModelsLoading(true)
    llmAdminApi
      .listModels({ providerScope: 'global', includeInactive: false })
      .then((data) => {
        const filtered: ModelOption[] = data.models
          .filter((m) => m.capability_domain === 'embedding')
          .map((m) => {
            const cfg = (m.capabilities_config || {}) as Record<string, unknown>
            const embedding = (cfg.embedding || {}) as Record<string, unknown>
            const dims = Number(embedding.dimensions ?? cfg.embedding_dimensions ?? 0)
            return {
              id: m.id,
              display_name: m.display_name,
              model_name: m.model_name,
              dimensions: dims,
            }
          })
        setModels(filtered)
      })
      .catch(() => {
        setModels([])
      })
      .finally(() => setModelsLoading(false))
  }, [open])

  // 关闭时重置状态
  useEffect(() => {
    if (!open) {
      setSceneKey('')
      setNewModelId('')
      setConfirmInput('')
      setReason('')
      setResultBanner(null)
      setSubmitting(false)
    }
  }, [open])

  const selectedModel = useMemo(
    () => models.find((m) => m.id === newModelId),
    [models, newModelId]
  )

  const dimensionsOk =
    !!selectedModel && selectedModel.dimensions === REQUIRED_DIMENSIONS

  const confirmOk = sceneKey !== '' && confirmInput.trim() === sceneKey

  // 宪法 §5.6：reason 必填（用于 audit）；前端先校验避免提交后被后端 400
  const reasonOk = reason.trim() !== ''

  const canSubmit =
    sceneKey !== '' &&
    newModelId !== '' &&
    dimensionsOk &&
    confirmOk &&
    reasonOk &&
    !submitting

  if (!open) return null

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setResultBanner(null)
    try {
      await embeddingApi.rebuild(sceneKey, {
        new_model_id: newModelId,
        confirm_scene_key: confirmInput.trim(),
        reason: reason.trim(),
      })
      // 理论上 v0.1 不会走到这里（永远 422）；万一后端实装了，提示成功
      setResultBanner({
        kind: 'info',
        title: '重建任务已提交',
        message: '后端已接受 rebuild 请求，可在"索引状态"Tab 跟踪进度。',
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'FEATURE_NOT_IMPLEMENTED') {
        setResultBanner({
          kind: 'info',
          title: '重建索引功能未在 v0.1 启用',
          message:
            '请等待 v0.2 — 宪法 v0.1 §1.5.3 决议：产品上线前没有真实数据需要重建，' +
            'rebuild 任务推迟到 v0.2 实施。',
        })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setResultBanner({
          kind: 'error',
          title: '提交失败',
          message: msg,
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-subtitle font-semibold">重建 Embedding 索引</h2>
            <p className="text-caption text-muted-foreground mt-1">
              v0.1 stub UI — 提交后会被后端 422 拒绝（FEATURE_NOT_IMPLEMENTED）
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-muted"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 mb-4 text-caption text-yellow-900">
          <div className="font-medium mb-1">⚠️ 危险操作</div>
          <div>
            重建索引会临时关闭检索能力。v0.1 没有真实数据，提交也会被后端 stub 拒绝；
            真实重建任务推迟到 v0.2。
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="rebuild-scene-key" className="text-body font-medium">
              选择 Scene
            </label>
            <select
              id="rebuild-scene-key"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={sceneKey}
              onChange={(e) => {
                setSceneKey(e.target.value)
                setConfirmInput('')
              }}
            >
              <option value="">请选择 embedding scene...</option>
              {scenes.map((s) => (
                <option key={s.scene_key} value={s.scene_key}>
                  {s.display_name} ({s.scene_key})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="rebuild-new-model" className="text-body font-medium">
              新 Embedding Model
            </label>
            <select
              id="rebuild-new-model"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              disabled={modelsLoading || models.length === 0}
            >
              <option value="">
                {modelsLoading
                  ? '加载中...'
                  : models.length === 0
                    ? '没有可用的 embedding 模型'
                    : '请选择新模型...'}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} ({m.model_name}) — {m.dimensions} 维
                </option>
              ))}
            </select>
            {selectedModel && (
              <div
                className={`text-caption ${dimensionsOk ? 'text-green-700' : 'text-red-700'}`}
              >
                {dimensionsOk
                  ? `✓ dimensions=${selectedModel.dimensions} 与 pgvector 1024 强约束匹配`
                  : `✗ dimensions=${selectedModel.dimensions} 不匹配（必须等于 ${REQUIRED_DIMENSIONS}）— pgvector 列定义编译期固定`}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="rebuild-reason" className="text-body font-medium">
              重建原因（写入 audit log，必填）
            </label>
            <textarea
              id="rebuild-reason"
              className="w-full rounded-md border px-3 py-2 text-body bg-background h-20"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：原模型已下线 / 切换 provider / 召回率优化..."
            />
            {reason && !reasonOk && (
              <div className="text-caption text-red-700">✗ reason 不能为空白</div>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="rebuild-confirm-input" className="text-body font-medium">
              二次确认
            </label>
            <p className="text-caption text-muted-foreground">
              请在下方完整输入 scene_key{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-caption font-mono">
                {sceneKey || '（请先选 scene）'}
              </code>{' '}
              以解锁提交按钮。
            </p>
            <input
              id="rebuild-confirm-input"
              type="text"
              className="w-full rounded-md border px-3 py-2 text-body bg-background font-mono"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              disabled={!sceneKey}
              placeholder={sceneKey || '请先选 scene'}
            />
            {sceneKey && confirmInput && !confirmOk && (
              <div className="text-caption text-red-700">✗ 与 scene_key 不一致</div>
            )}
          </div>

          {resultBanner && (
            <div
              className={`rounded-md border px-3 py-3 text-caption ${
                resultBanner.kind === 'info'
                  ? 'border-blue-300 bg-blue-50 text-blue-900'
                  : 'border-red-300 bg-red-50 text-red-900'
              }`}
            >
              <div className="font-medium mb-1">{resultBanner.title}</div>
              <div>{resultBanner.message}</div>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-body font-medium hover:bg-muted transition-colors"
            onClick={onClose}
          >
            关闭
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={
              canSubmit
                ? '提交（v0.1 stub 会被后端拒绝）'
                : '请先完成所有必填项'
            }
          >
            {submitting ? '提交中...' : '提交重建任务'}
          </button>
        </div>
      </div>
    </div>
  )
}
