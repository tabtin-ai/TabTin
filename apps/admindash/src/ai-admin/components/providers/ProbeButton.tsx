/**
 * 探测按钮（v0.1）
 *
 * 单独的可复用按钮组件：
 *   - 调用 providersApi.probe(id) 触发后端 Provider 健康检查
 *   - 探测过程中显示 loading 状态
 *   - 完成后回调 onProbed 让父组件刷新列表
 *
 * 这个组件被 ProvidersPage 单独的"批量探测"或"行内探测"调用方复用。
 */

import { useState } from 'react'
import { providersApi, type ProviderItem } from '../../api/providers'

interface ProbeButtonProps {
  provider: ProviderItem
  variant?: 'inline' | 'pill'
  onProbed: (provider: ProviderItem, probeResult: Record<string, unknown>) => void
  onError?: (message: string) => void
  className?: string
}

export function ProbeButton({
  provider,
  variant = 'inline',
  onProbed,
  onError,
  className = '',
}: ProbeButtonProps) {
  const [busy, setBusy] = useState(false)

  const handleClick = async () => {
    setBusy(true)
    try {
      const result = await providersApi.probe(provider.id)
      onProbed(result.provider, result.probe)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      onError?.(msg)
    } finally {
      setBusy(false)
    }
  }

  const baseCls =
    variant === 'pill'
      ? 'rounded-full border px-3 py-1.5 text-caption font-medium hover:bg-amber-50 dark:hover:bg-amber-900/40 disabled:opacity-50 transition-colors'
      : 'rounded px-2 py-1 text-caption font-medium text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-50'

  return (
    <button
      type="button"
      className={`${baseCls} ${className}`}
      onClick={handleClick}
      disabled={busy}
      title={`探测 Provider ${provider.display_name} 的健康状态`}
    >
      {busy ? '探测中…' : '探测'}
    </button>
  )
}
