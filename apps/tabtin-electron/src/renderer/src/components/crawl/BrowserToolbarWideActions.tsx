import React from 'react';
import { Camera, Crosshair, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToolbarActionTooltip } from '@tabtin/crawlspace-core';
import { cn } from '@utils/cn';
import { BrowserZoomControls } from './BrowserZoomControls';

export interface BrowserToolbarWideActionsProps {
  viewId: string;
  browserAnnotationPicking: boolean;
  browserScreenshotPicking: boolean;
  currentUrlForBookmark: string | null | undefined;
  isCurrentBookmarked: boolean;
  onToggleAnnotation: () => void;
  onCaptureScreenshot: () => void;
  onToggleBookmark: () => void;
}

/** 宽态浏览器工具栏操作；窄态继续由 BrowserToolbarActionsMenu 承载。 */
export const BrowserToolbarWideActions: React.FC<
  BrowserToolbarWideActionsProps
> = ({
  viewId,
  browserAnnotationPicking,
  browserScreenshotPicking,
  currentUrlForBookmark,
  isCurrentBookmarked,
  onToggleAnnotation,
  onCaptureScreenshot,
  onToggleBookmark,
}) => {
  const { t } = useTranslation('crawl');
  const showBookmark = Boolean(
    currentUrlForBookmark && currentUrlForBookmark !== 'about:blank',
  );

  const annotationAriaLabel = browserAnnotationPicking
    ? t('quoteSelection.cancelPickingAction', { defaultValue: '取消网页注释' })
    : t('quoteSelection.pickElementAction', {
        defaultValue: '选择页面元素添加到对话（DOM）',
      });
  const annotationTooltipLabel = browserAnnotationPicking
    ? t('toolbarDescriptions.cancelAnnotationLabel', {
        defaultValue: '取消网页注释',
      })
    : t('toolbarDescriptions.annotationLabel', { defaultValue: '网页注释' });
  const annotationTooltipDescription = browserAnnotationPicking
    ? t('toolbarDescriptions.cancelAnnotation', {
        defaultValue: '退出网页注释模式',
      })
    : t('toolbarDescriptions.annotation', {
        defaultValue: '选择页面内容添加到对话',
      });

  const screenshotAriaLabel = t('quoteSelection.pickElementScreenshotAction', {
    defaultValue: '截取当前网页可视区域添加到对话',
  });
  const bookmarkAriaLabel = isCurrentBookmarked
    ? t('bookmarks.removeAction', { defaultValue: '取消收藏' })
    : t('bookmarks.addAction', { defaultValue: '收藏' });

  return (
    <>
      <BrowserZoomControls viewId={viewId} />

      <ToolbarActionTooltip
        label={annotationTooltipLabel}
        description={annotationTooltipDescription}
      >
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-body text-muted-foreground transition-all',
            browserAnnotationPicking
              ? 'bg-primary/15 text-primary shadow-sm'
              : 'hover:bg-muted',
          )}
          onClick={onToggleAnnotation}
          aria-label={annotationAriaLabel}
          disabled={browserScreenshotPicking}
        >
          <Crosshair className="h-4 w-4" />
          {browserAnnotationPicking ? (
            <span className="whitespace-nowrap">
              {t('quoteSelection.pickingElement', { defaultValue: '正在注释' })}
            </span>
          ) : null}
        </button>
      </ToolbarActionTooltip>

      <ToolbarActionTooltip
        label={t('toolbarDescriptions.screenshotLabel', {
          defaultValue: '截图到对话',
        })}
        description={t('toolbarDescriptions.screenshot', {
          defaultValue: '截取当前网页可视区域添加到对话',
        })}
      >
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-body text-muted-foreground transition-all',
            browserScreenshotPicking
              ? 'bg-primary/15 text-primary shadow-sm'
              : 'hover:bg-muted',
          )}
          onClick={onCaptureScreenshot}
          aria-label={screenshotAriaLabel}
          disabled={browserAnnotationPicking || browserScreenshotPicking}
        >
          <Camera className="h-4 w-4" />
          {browserScreenshotPicking ? (
            <span className="whitespace-nowrap">
              {t('quoteSelection.pickingScreenshot', {
                defaultValue: '正在截图',
              })}
            </span>
          ) : null}
        </button>
      </ToolbarActionTooltip>

      {showBookmark ? (
        <ToolbarActionTooltip
          label={
            isCurrentBookmarked
              ? t('toolbarDescriptions.removeBookmarkLabel', {
                  defaultValue: '取消收藏',
                })
              : t('toolbarDescriptions.bookmarkLabel', {
                  defaultValue: '收藏当前网页',
                })
          }
          description={
            isCurrentBookmarked
              ? t('toolbarDescriptions.removeBookmark', {
                  defaultValue: '从浏览器收藏中移除当前网页',
                })
              : t('toolbarDescriptions.bookmark', {
                  defaultValue: '稍后可从浏览器收藏中打开',
                })
          }
        >
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted"
            onClick={onToggleBookmark}
            aria-label={bookmarkAriaLabel}
          >
            <Star
              className={cn(
                'h-4 w-4',
                isCurrentBookmarked && 'fill-warning text-warning',
              )}
            />
          </button>
        </ToolbarActionTooltip>
      ) : null}
    </>
  );
};

BrowserToolbarWideActions.displayName = 'BrowserToolbarWideActions';
