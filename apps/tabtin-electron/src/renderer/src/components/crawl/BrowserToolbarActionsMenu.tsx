import React, { useCallback } from 'react'
import { Camera, Crosshair, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useToolbarOverflowRun } from '@tabtin/crawlspace-core'
import { BrowserZoomControls } from './BrowserZoomControls'
import { cn } from '@utils/cn'

const menuItemClass =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body text-foreground/80 transition-colors hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50'

export interface BrowserToolbarActionsMenuProps {
  viewId: string
  browserAnnotationPicking: boolean
  browserScreenshotPicking: boolean
  currentUrlForBookmark: string | null | undefined
  isCurrentBookmarked: boolean
  onToggleAnnotation: () => void
  onCaptureScreenshot: () => void
  onToggleBookmark: () => void
}

/**
 * 浏览器工具栏窄态 `...` 菜单下半段：缩放 + 注释 / 截图 / 收藏。
 * 通过 ToolbarOverflowCloseContext 关菜单并执行；截图/开始注释 defer，避免把浮层拍进去。
 */
export const BrowserToolbarActionsMenu: React.FC<BrowserToolbarActionsMenuProps> = ({
  viewId,
  browserAnnotationPicking,
  browserScreenshotPicking,
  currentUrlForBookmark,
  isCurrentBookmarked,
  onToggleAnnotation,
  onCaptureScreenshot,
  onToggleBookmark,
}) => {
  const { t } = useTranslation('crawl')
  const runOverflowAction = useToolbarOverflowRun()
  const showBookmark = Boolean(currentUrlForBookmark && currentUrlForBookmark !== 'about:blank')

  const handleAnnotationClick = useCallback(() => {
    if (browserAnnotationPicking) {
      runOverflowAction(onToggleAnnotation)
      return
    }
    runOverflowAction(onToggleAnnotation, { defer: true })
  }, [browserAnnotationPicking, onToggleAnnotation, runOverflowAction])

  const handleScreenshotClick = useCallback(() => {
    runOverflowAction(onCaptureScreenshot, { defer: true })
  }, [onCaptureScreenshot, runOverflowAction])

  const handleBookmarkClick = useCallback(() => {
    runOverflowAction(onToggleBookmark)
  }, [onToggleBookmark, runOverflowAction])

  return (
    <div className="flex flex-col" data-testid="browser-toolbar-actions-menu">
      <div className="px-2 py-1.5" data-testid="browser-toolbar-actions-menu-zoom">
        <BrowserZoomControls viewId={viewId} />
      </div>

      <button
        type="button"
        className={cn(
          menuItemClass,
          browserAnnotationPicking && 'bg-primary/15 text-primary',
        )}
        onClick={handleAnnotationClick}
        disabled={browserScreenshotPicking}
        aria-label={
          browserAnnotationPicking
            ? t('quoteSelection.cancelPickingAction', { defaultValue: '取消网页注释' })
            : t('quoteSelection.pickElementAction', {
                defaultValue: '选择页面元素添加到对话（DOM）',
              })
        }
      >
        <Crosshair className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {browserAnnotationPicking
            ? t('quoteSelection.pickingElement', { defaultValue: '正在注释' })
            : t('toolbarOverflow.annotate', { defaultValue: '网页注释' })}
        </span>
      </button>

      <button
        type="button"
        className={cn(
          menuItemClass,
          browserScreenshotPicking && 'bg-primary/15 text-primary',
        )}
        onClick={handleScreenshotClick}
        disabled={browserAnnotationPicking || browserScreenshotPicking}
        aria-label={t('quoteSelection.pickElementScreenshotAction', {
          defaultValue: '截取当前网页可视区域添加到对话',
        })}
      >
        <Camera className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {browserScreenshotPicking
            ? t('quoteSelection.pickingScreenshot', { defaultValue: '正在截图' })
            : t('toolbarOverflow.screenshot', { defaultValue: '截图到对话' })}
        </span>
      </button>

      {showBookmark ? (
        <button
          type="button"
          className={menuItemClass}
          onClick={handleBookmarkClick}
          aria-label={
            isCurrentBookmarked
              ? t('bookmarks.removeAction', { defaultValue: '取消收藏' })
              : t('bookmarks.addAction', { defaultValue: '收藏' })
          }
        >
          <Star
            className={cn(
              'h-4 w-4 shrink-0',
              isCurrentBookmarked && 'fill-warning text-warning',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {isCurrentBookmarked
              ? t('bookmarks.removeAction', { defaultValue: '取消收藏' })
              : t('bookmarks.addAction', { defaultValue: '收藏' })}
          </span>
        </button>
      ) : null}
    </div>
  )
}

BrowserToolbarActionsMenu.displayName = 'BrowserToolbarActionsMenu'
