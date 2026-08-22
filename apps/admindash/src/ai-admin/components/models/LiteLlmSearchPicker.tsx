/**
 * `LiteLlmSearchPicker` — 「从 LiteLLM 搜索导入」（宪法 07 §1.3.3）。
 *
 * 工作流：
 *
 * 1. 运营点击「从 LiteLLM 搜索」按钮（Page 顶部）
 * 2. 弹出本对话框，输入关键字（debounced 300ms）
 * 3. 调 `GET /services/llm/admin/search-models?keyword=xxx` 拉 LiteLLM 元数据
 * 4. 选中一项 → 通过 `onPick` 回调把结果回填到 ModelCreateDialog 的 form
 *
 * 设计原则：
 * - 本组件 **不直接打开** 创建对话框——上层 page 接到 `onPick` 后自己开
 * - LiteLLM 返回的 `mode`（chat / embedding / audio_xxx / image_generation 等）
 *   跟 v0.1 的 8 个 capability_domain 不是 1:1，所以这里不做自动 domain 映射，而是把
 *   `mode` 原样回传，让创建对话框基于"当前 Tab 的 domain + provider.capability_domain"
 *   决定字段集合
 * - 输入框提交节流：300ms 内连续打字仅发起一次请求
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { LiteLlmSearchModelItem } from '@/types/llm-admin'
import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { modelsApi } from '../../api/models'

interface LiteLlmSearchPickerProps {
  open: boolean
  onClose: () => void
  onPick: (item: LiteLlmSearchModelItem) => void
}

const SEARCH_DEBOUNCE_MS = 300

export function LiteLlmSearchPicker({ open, onClose, onPick }: LiteLlmSearchPickerProps) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<LiteLlmSearchModelItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!open) {
      setKeyword('')
      setResults([])
      setError(null)
      setLoading(false)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      return
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const trimmed = keyword.trim()
    if (!trimmed) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const seq = ++requestSeqRef.current
      setLoading(true)
      setError(null)
      try {
        const items = await modelsApi.searchLiteLLM(trimmed, 50)
        if (seq !== requestSeqRef.current) return
        setResults(items)
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setResults([])
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false)
        }
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [keyword, open])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>从 LiteLLM 搜索导入</DialogTitle>
          <DialogDescription>
            搜索 LiteLLM 模型元数据库，选中后自动回填新建模型的字段。注意： mode / supports_vision
            是 LiteLLM 第三方 schema，落库时由后端 转换为 capability_domain + capabilities_config。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              // biome-ignore lint/a11y/noAutofocus: 搜索弹窗的预期行为是打开即可输入；不 autofocus 反而要再点一次
              autoFocus
              placeholder="输入模型名 / provider 关键字，如 gpt-4o / qwen / claude / dall-e..."
              className="w-full rounded-md border pl-10 pr-3 py-2 text-body bg-background"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700">
              {error}
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-caption text-muted-foreground">搜索中...</div>
          ) : keyword.trim() && results.length === 0 && !error ? (
            <div className="py-8 text-center text-caption text-muted-foreground">
              未找到匹配的模型
            </div>
          ) : results.length > 0 ? (
            <div className="max-h-[60vh] overflow-y-auto rounded-md border">
              <table className="w-full text-body">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="border-b text-caption">
                    <th className="px-3 py-2 text-left font-medium">模型名</th>
                    <th className="px-3 py-2 text-left font-medium">Provider</th>
                    <th className="px-3 py-2 text-left font-medium">Mode</th>
                    <th className="px-3 py-2 text-center font-medium">Vision</th>
                    <th className="px-3 py-2 text-right font-medium">Context</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((item) => {
                    const mode = item.litellm_mode || item.mode || '-'
                    const supportsVision =
                      item.litellm_supports_vision ?? item.supports_vision ?? false
                    return (
                      <tr
                        key={`${item.provider}/${item.name}`}
                        className="border-b hover:bg-muted/20"
                      >
                        <td className="px-3 py-2 font-mono text-caption">{item.name}</td>
                        <td className="px-3 py-2 text-caption">{item.provider || '-'}</td>
                        <td className="px-3 py-2 text-caption">{mode}</td>
                        <td className="px-3 py-2 text-caption text-center">
                          {supportsVision ? '✓' : '-'}
                        </td>
                        <td className="px-3 py-2 text-caption font-mono text-right">
                          {item.context_window_tokens
                            ? `${Math.round(item.context_window_tokens / 1000)}k`
                            : '-'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            className="rounded bg-primary px-2.5 py-1 text-caption font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                            onClick={() => {
                              onPick(item)
                              onClose()
                            }}
                          >
                            选用
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-caption text-muted-foreground">
              输入关键字开始搜索
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
