import React, { useState, useEffect, useRef } from 'react'
import { Lock, Globe, Copy, Check } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { handleIPCError } from './utils/ipc-error-handler'

interface AddressBarProps {
  url: string
  onNavigate: (url: string) => void
  className?: string
  status?: 'idle' | 'loading' | 'error'
  message?: string | null
  onClearMessage?: () => void
}

export const AddressBar: React.FC<AddressBarProps> = ({
  url,
  onNavigate,
  className,
  status = 'idle',
  message,
  onClearMessage
}) => {
  const { t } = useTranslation('crawl')
  const [inputValue, setInputValue] = useState(url)
  const [isFocused, setIsFocused] = useState(false)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 同步外部 URL 变化
  useEffect(() => {
    if (!isFocused) {
      setInputValue(url)
    }
  }, [url, isFocused])

  // 处理导航
  const handleNavigate = () => {
    if (inputValue.trim()) {
      let finalUrl = inputValue.trim()

      const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(finalUrl)
      if (hasProtocol) {
        if (!/^https?:\/\//i.test(finalUrl)) return
      } else {
        finalUrl = 'https://' + finalUrl
      }

      onClearMessage?.()
      onNavigate(finalUrl)
      inputRef.current?.blur()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onClearMessage?.()
      handleNavigate()
    } else if (e.key === 'Escape') {
      setInputValue(url)
      inputRef.current?.blur()
    }
  }

  // 复制 URL
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      handleIPCError(error, { source: 'AddressBar', action: 'copyUrl' })
    }
  }

  // 判断是否是安全连接
  const isSecure = url.startsWith('https://')

  // 聚焦时选中全部文本
  const handleFocus = () => {
    setIsFocused(true)
    onClearMessage?.()
    inputRef.current?.select()
  }

  const handleBlur = () => {
    setIsFocused(false)
    // 如果没有修改，恢复原始 URL
    if (inputValue !== url) {
      setInputValue(url)
    }
  }

  const isError = status === 'error'
  const isLoading = status === 'loading'

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 bg-background border border-border rounded-md transition-colors focus-within:border-primary',
        isError && 'border-destructive/80 focus-within:border-destructive text-destructive',
        isLoading && 'border-primary/60',
        className
      )}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      {/* 安全图标 */}
      <div className="flex-shrink-0">
        {isSecure ? (
          <Lock className="h-4 w-4 text-success" aria-label={t('addressBar.secureTitle')} />
        ) : (
          <Globe className="h-4 w-4 text-muted-foreground" aria-label={t('addressBar.insecureTitle')} />
        )}
      </div>

      {/* URL 输入框 */}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={t('addressBar.placeholder')}
        className={cn(
          'flex-1 bg-transparent outline-none text-body',
          'placeholder:text-muted-foreground',
          'focus:text-foreground',
          'border-0 focus:border-0 focus:ring-0 focus:shadow-none',
          !isFocused && 'text-muted-foreground truncate'
        )}
      />

      {/* 复制按钮 */}
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'flex-shrink-0 p-1 rounded hover:bg-accent transition-colors',
          'text-muted-foreground hover:text-foreground'
        )}
        title={copied ? t('addressBar.copied') : t('addressBar.copy')}
      >
        {copied ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>

      {message && (
        <span className="sr-only">{message}</span>
      )}
    </div>
  )
}
