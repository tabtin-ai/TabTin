/**
 * 共享会话文件预览 Drawer 适配器。
 *
 * 主工作台改走会话 Tab；保留该适配器给没有标签画布的独立窗口。
 */
import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@components/ui'
import { SharedSessionFilePreviewPane } from './SharedSessionFilePreviewPane'
import {
  useSharedSessionPreviewStore,
  type SharedSessionPreviewTarget,
} from './useSharedSessionPreviewStore'

interface SharedSessionFilePreviewDrawerProps {
  target: SharedSessionPreviewTarget
}

export const SharedSessionFilePreviewDrawer: React.FC<SharedSessionFilePreviewDrawerProps> = ({
  target,
}) => {
  const { t } = useTranslation('chat')
  const close = useSharedSessionPreviewStore((state) => state.close)
  const displayTitle = target.title || target.relativePath
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) close()
  }, [close])

  return (
    <Sheet open onOpenChange={handleOpenChange} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        closeable={false}
        container={null}
        className="app-region-no-drag no-drag flex w-[min(94vw,56rem)] flex-col p-0 sm:max-w-none surface-glass-overlay"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        data-testid="shared-session-file-preview-drawer"
      >
        <SheetTitle className="sr-only">{displayTitle}</SheetTitle>
        <SheetDescription className="sr-only">
          {t('sharedPane.previewDrawerDesc', { defaultValue: '共享会话文件预览' })}
        </SheetDescription>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-3">
          <p className="min-w-0 flex-1 truncate text-subtitle">{displayTitle}</p>
          <button
            type="button"
            onClick={close}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-label={t('sharedPane.previewClose', { defaultValue: '关闭预览' })}
            data-testid="shared-session-file-preview-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <SharedSessionFilePreviewPane target={target} />
      </SheetContent>
    </Sheet>
  )
}

SharedSessionFilePreviewDrawer.displayName = 'SharedSessionFilePreviewDrawer'
