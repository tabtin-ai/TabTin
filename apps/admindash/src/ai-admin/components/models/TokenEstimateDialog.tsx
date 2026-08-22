/**
 * `TokenEstimateDialog` — 模型 Token 估算（宪法 07 §5.4 estimateTokens）。
 *
 * 让运营在创建 / 选模型前，对一段示例对话估算 input/output token 数与成本。
 *
 * - 后端走 `POST /services/llm/admin/estimate-tokens`
 * - 计费类型 ≠ token 时，后端只返回 token 数，不返回 cost（cost_unavailable_reason
 *   会有原因）—— 前端把这个透出
 *
 * 用例：运营对比"短问答 vs 长上下文"在不同模型上的成本差异。
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
import { useEffect, useState } from 'react'
import { type TokenEstimateResponse, modelsApi } from '../../api/models'

interface TokenEstimateDialogProps {
  open: boolean
  model: LlmAdminModel | null
  onClose: () => void
}

const DEFAULT_MESSAGES = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: '你好，请简要介绍 TabTin 平台的核心理念。' },
]

export function TokenEstimateDialog({ open, model, onClose }: TokenEstimateDialogProps) {
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_MESSAGES[0].content)
  const [userPrompt, setUserPrompt] = useState(DEFAULT_MESSAGES[1].content)
  const [preferProviderApi, setPreferProviderApi] = useState(true)
  const [result, setResult] = useState<TokenEstimateResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setSystemPrompt(DEFAULT_MESSAGES[0].content)
      setUserPrompt(DEFAULT_MESSAGES[1].content)
      setResult(null)
      setError(null)
      setLoading(false)
    }
  }, [open])

  const handleEstimate = async () => {
    if (!model) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const messages = []
      if (systemPrompt.trim()) {
        messages.push({ role: 'system' as const, content: systemPrompt })
      }
      if (userPrompt.trim()) {
        messages.push({ role: 'user' as const, content: userPrompt })
      }
      if (messages.length === 0) {
        setError('至少填一条 system 或 user 消息')
        setLoading(false)
        return
      }
      const data = await modelsApi.estimateTokens({
        model_id: model.id,
        messages,
        prefer_provider_api: preferProviderApi,
      })
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Token 估算</DialogTitle>
          <DialogDescription>
            <code>{model.model_name}</code> · {model.provider_display_name || model.provider_name}
            {' · '}
            <span className="font-mono">{model.billing_type}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-caption font-medium">System Prompt</div>
            <textarea
              className="w-full rounded-md border px-3 py-2 text-caption font-mono bg-background min-h-[60px]"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-caption font-medium">User Message</div>
            <textarea
              className="w-full rounded-md border px-3 py-2 text-caption font-mono bg-background min-h-[100px]"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={preferProviderApi}
              onChange={(e) => setPreferProviderApi(e.target.checked)}
            />
            优先使用 provider 原生估算接口（更准但慢）
          </label>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="grid grid-cols-3 gap-3 text-caption">
                <Stat label="Input Tokens" value={result.estimate.input_tokens} />
                <Stat label="Output Tokens" value={result.estimate.output_tokens} />
                <Stat label="Total Tokens" value={result.estimate.total_tokens} />
              </div>
              <div className="text-caption text-muted-foreground">
                来源：<span className="font-mono">{result.estimate.source}</span>
                {result.estimate.provider_error && (
                  <span className="ml-2 text-red-600">
                    （provider error: {result.estimate.provider_error}）
                  </span>
                )}
              </div>
              {result.estimated_cost ? (
                <div className="grid grid-cols-3 gap-3 text-caption">
                  <Stat
                    label="Input Cost"
                    value={`$${result.estimated_cost.input_cost.toFixed(6)}`}
                  />
                  <Stat
                    label="Output Cost"
                    value={`$${result.estimated_cost.output_cost.toFixed(6)}`}
                  />
                  <Stat
                    label="Total Cost"
                    value={`$${result.estimated_cost.total_cost.toFixed(6)}`}
                  />
                </div>
              ) : (
                <div className="text-caption text-muted-foreground italic">
                  {result.cost_unavailable_reason || `${result.billing_type} 计费不支持估算`}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            关闭
          </Button>
          <Button type="button" onClick={handleEstimate} disabled={loading}>
            {loading ? '估算中...' : '开始估算'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border bg-background p-2 text-center">
      <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
      <div className="font-mono text-body font-semibold">{value}</div>
    </div>
  )
}
