/**
 * TerminalDropOverlay - 文件拖放视觉指示遮罩
 *
 * 用户将文件从 Finder 拖入终端时显示，提供明确的视觉反馈。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { FileDown } from 'lucide-react'

export const TerminalDropOverlay: React.FC = () => {
  const { t } = useTranslation('terminal')

  return (
    <div
      role="alert"
      aria-label={t('dragDrop.hint')}
      className="
        absolute inset-0 z-floating
        flex flex-col items-center justify-center gap-2
        bg-accent/10 backdrop-blur-[2px]
        border-2 border-dashed border-accent/60
        rounded-md
        pointer-events-none
        animate-in fade-in duration-150
      "
    >
      <FileDown className="h-8 w-8 text-accent/80" />
      <span className="text-body font-medium text-accent/80">
        {t('dragDrop.hint')}
      </span>
    </div>
  )
}
