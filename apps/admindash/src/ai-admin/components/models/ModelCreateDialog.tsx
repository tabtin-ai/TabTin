/**
 * `ModelCreateDialog` — 新建模型（宪法 07 §1.3.3）。
 *
 * 流程：
 *
 * 1. 顶部「从 LiteLLM 搜索导入」按钮 → 弹出 `LiteLlmSearchPicker`
 * 2. 选中 LiteLLM 项 → 把搜索结果回填到 `form`（applyLiteLlmPick）
 * 3. 运营基于 capability_domain 调整 capabilities_config
 * 4. 提交 → POST /services/llm/admin/models（后端做 capability_domain 一致性 +
 *    capabilities_config 字段集校验，详见 04 §3.2）
 *
 * 失败时：把后端 422 / 400 的 message 显示在底部 banner，让运营看清是哪条规则。
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
import type { LiteLlmSearchModelItem } from '@/types/llm-admin'
import { Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type CapabilityDomain, modelsApi } from '../../api/models'
import { LiteLlmSearchPicker } from './LiteLlmSearchPicker'
import {
  ModelFormBody,
  type ModelFormState,
  type ModelProviderListFilter,
  applyLiteLlmPick,
  buildEmptyForm,
  serializeCapabilitiesConfig,
} from './ModelDialogShared'

interface ModelCreateDialogProps {
  open: boolean
  initialDomain?: CapabilityDomain
  /**
   * 来自 ModelsPage 顶部 LiteLLM 搜索按钮的预填项；打开对话框时立即 applyLiteLlmPick
   * 把字段刷到 form 上。无值则按 initialDomain 建空 form。
   */
  initialLiteLlmPick?: LiteLlmSearchModelItem | null
  /** 组织详情：只允许挂到该组织 BYOK 渠道 */
  providerListFilter?: ModelProviderListFilter
  onClose: () => void
  onCreated: () => void
}

export function ModelCreateDialog({
  open,
  initialDomain,
  initialLiteLlmPick,
  providerListFilter,
  onClose,
  onCreated,
}: ModelCreateDialogProps) {
  const [form, setForm] = useState<ModelFormState>(() => buildEmptyForm(initialDomain || 'chat'))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (open) {
      let next = buildEmptyForm(initialDomain || 'chat')
      if (initialLiteLlmPick) {
        next = applyLiteLlmPick(next, initialLiteLlmPick)
      }
      setForm(next)
      setError(null)
      setSubmitting(false)
    }
  }, [open, initialDomain, initialLiteLlmPick])

  const canSubmit = useMemo(() => {
    return (
      !!form.provider_id &&
      !!form.model_name.trim() &&
      !!form.display_name.trim() &&
      !!form.base_url.trim() &&
      !!form.context_window_tokens &&
      !submitting
    )
  }, [form, submitting])

  const handleSubmit = async () => {
    setError(null)
    if (!form.base_url.trim()) {
      setError('请填写 API 地址')
      return
    }
    const ctx = Number(form.context_window_tokens)
    if (!Number.isFinite(ctx) || ctx <= 0) {
      setError('上下文长度必须是正整数')
      return
    }
    const { capabilities_config, custom_billing_config, errors } = serializeCapabilitiesConfig(form)
    if (errors.length > 0) {
      setError(errors.join('；'))
      return
    }

    setSubmitting(true)
    try {
      await modelsApi.createModel({
        provider_id: form.provider_id,
        model_name: form.model_name.trim(),
        display_name: form.display_name.trim(),
        description: form.description.trim(),
        capability_domain: form.capability_domain,
        base_url: form.base_url.trim(),
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
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose()
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新建模型</DialogTitle>
            <DialogDescription>
              选择已接入的渠道，再填写服务商提供的模型 ID。常用能力已有默认值。
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-end mb-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setPickerOpen(true)}
              className="gap-1.5"
            >
              <Search className="h-3.5 w-3.5" />
              从模型目录自动填写
              <Sparkles className="h-3 w-3 text-amber-500" />
            </Button>
          </div>

          <ModelFormBody
            form={form}
            setForm={setForm}
            initialDomain={initialDomain}
            providerListFilter={providerListFilter}
          />

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
              {submitting ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LiteLlmSearchPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(item) => setForm((prev) => applyLiteLlmPick(prev, item))}
      />
    </>
  )
}
