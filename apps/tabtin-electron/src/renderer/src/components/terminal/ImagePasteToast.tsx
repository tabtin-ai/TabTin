/**
 * ImagePasteToast - 图片粘贴 / 文件拖放反馈浮层
 *
 * 在终端右下角短暂显示保存状态和路径。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Image, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'

interface ImagePasteToastProps {
  status: 'saving' | 'saved' | 'error'
  path: string
  message?: string
}

export const ImagePasteToast: React.FC<ImagePasteToastProps> = ({ status, path, message }) => {
  const { t } = useTranslation('terminal')

  const statusConfig = {
    saving: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-info" />,
      text: t('imagePaste.saving'),
      bg: 'bg-info/15 border-info/30',
    },
    saved: {
      icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
      text: t('imagePaste.saved'),
      bg: 'bg-success/15 border-success/30',
    },
    error: {
      icon: <AlertCircle className="h-3.5 w-3.5 text-destructive" />,
      text: message || t('imagePaste.failed'),
      bg: 'bg-destructive/15 border-destructive/30',
    },
  }

  const config = statusConfig[status]

  const displayName = status === 'saved' && path
    ? path.split(/[/\\]/).pop()
    : config.text

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`
        absolute bottom-3 right-3 z-floating
        flex items-center gap-2 px-3 py-2
        rounded-lg border backdrop-blur-sm
        text-body font-mono
        text-foreground/90
        shadow-lg
        animate-in fade-in slide-in-from-bottom-2 duration-200
        ${config.bg}
      `}
    >
      <Image className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      {config.icon}
      <span className="truncate max-w-[240px]">
        {displayName}
      </span>
    </div>
  )
}
