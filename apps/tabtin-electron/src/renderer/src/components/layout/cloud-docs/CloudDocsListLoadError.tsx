/**
 * 云文档侧栏列表加载失败态 — 文案 + 手动重新加载。
 */
import React from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META_BASE } from '@components/layout/canvasUi'

interface CloudDocsListLoadErrorProps {
  /** 已本地化的提示；裸 Network/ENOTFOUND 等技术串会被忽略，改走 i18n */
  message?: string
  onRetry: () => void
  className?: string
}

/** 诊断/底层错误，不应直接进 UI */
export function isRawTechnicalLoadErrorMessage(message: string): boolean {
  const lower = message.trim().toLowerCase()
  if (!lower) return true
  return (
    lower.startsWith('network error')
    || lower.includes('getaddrinfo')
    || lower.includes('enotfound')
    || lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('etimedout')
    || lower.includes('eai_again')
    || lower.includes('enetunreach')
    || lower.includes('ehostunreach')
    || lower.includes('failed to fetch')
    || lower.includes('net::err_')
    || lower.includes('socket hang up')
  )
}

export const CloudDocsListLoadError: React.FC<CloudDocsListLoadErrorProps> = ({
  message,
  onRetry,
  className,
}) => {
  const { t } = useTranslation('context')
  const fallback = t('home.source.sharedLoadError', { defaultValue: '加载失败，请重试' })
  const displayMessage = (
    message && !isRawTechnicalLoadErrorMessage(message)
      ? message
      : fallback
  )
  return (
    <div
      className={cn(
        // 与「最近 / 分享给我」同款：列表顶区水平居中，不拉满竖向居中
        'flex flex-col items-center gap-3 px-2.5 py-6 text-center',
        className,
      )}
      role="alert"
    >
      <p className={cn('text-destructive', CANVAS_TEXT_META_BASE)}>
        {displayMessage}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        data-testid="cloud-docs-list-reload"
      >
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        {t('home.source.reload', { defaultValue: '重新加载' })}
      </Button>
    </div>
  )
}

CloudDocsListLoadError.displayName = 'CloudDocsListLoadError'
