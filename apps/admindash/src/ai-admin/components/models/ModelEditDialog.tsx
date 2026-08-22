/**
 * `ModelEditDialog` — 编辑模型（宪法 07 §1.3.3）。
 *
 * 与 Create 的差异：
 *
 * - Provider 不能改（避免 capability_domain 漂移）
 * - capability_domain 跟随 provider，运营也不能改
 * - 用 PATCH 半更新（只发改过的字段）；当前实现简化为整体 PATCH（capabilities_config
 *   等大字段全发），后端字段级 audit 自己计算 diff
 * - 提交后调 `onUpdated()` 通知列表 refetch
 *
 * 注意：编辑时 form 通过 `loadFromModel` 反序列化，已存在但未列出的字段会保留在
 * `raw_capabilities_config`，切到「高级 JSON 模式」可继续编辑。
 */

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { LlmAdminModel } from '@/types/llm-admin'
import { useEffect, useMemo, useState } from 'react'
import { modelsApi } from '../../api/models'
import {
  ModelFormBody,
  type ModelFormState,
  buildEmptyForm,
  loadFromModel,
  serializeCapabilitiesConfig,
} from './ModelDialogShared'

interface ModelEditDialogProps {
  open: boolean
  model: LlmAdminModel | null
  onClose: () => void
  onUpdated: () => void
}

export function ModelEditDialog({ open, model, onClose, onUpdated }: ModelEditDialogProps) {
  const [form, setForm] = useState<ModelFormState>(() => buildEmptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && model) {
      setForm(loadFromModel(model))
      setError(null)
      setSubmitting(false)
    }
  }, [open, model])

  const canSubmit = useMemo(() => {
    return (
      !!form.model_name.trim() &&
      !!form.display_name.trim() &&
      !!form.context_window_tokens &&
      !submitting
    )
  }, [form, submitting])

  const handleSubmit = async () => {
    if (!model) return
    setError(null)
    const ctx = Number(form.context_window_tokens)
    if (!Number.isFinite(ctx) || ctx <= 0) {
      setError('Context Window Tokens 必须是正整数')
      return
    }
    const { capabilities_config, custom_billing_config, errors } = serializeCapabilitiesConfig(form)
    if (errors.length > 0) {
      setError(errors.join('；'))
      return
    }

    setSubmitting(true)
    try {
      await modelsApi.updateModel(model.id, {
        model_name: form.model_name.trim(),
        display_name: form.display_name.trim(),
        description: form.description.trim(),
        capability_domain: form.capability_domain,
        base_url: form.base_url.trim() || undefined,
        context_window_tokens: ctx,
        max_input_tokens: form.max_input_tokens.trim() ? Number(form.max_input_tokens) : undefined,
        max_output_tokens: form.max_output_tokens.trim()
          ? Number(form.max_output_tokens)
          : undefined,
        capabilities_config,
        custom_billing_config,
        billing_type: form.billing_type,
        input_price_per_1k: form.input_price_per_1k || '0',
        output_price_per_1k: form.output_price_per_1k || '0',
        price_per_request: form.price_per_request || '0',
        price_per_second: form.price_per_second || '0',
      })
      onUpdated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open || !model) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑模型</DialogTitle>
          <DialogDescription>
            <code>{model.model_name}</code> · {model.provider_display_name || model.provider_name}
          </DialogDescription>
        </DialogHeader>

        <ModelFormBody form={form} setForm={setForm} lockProvider />

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700 whitespace-pre-wrap">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
