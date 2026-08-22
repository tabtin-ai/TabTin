import React, { useEffect } from 'react'
import { AppHostClientProvider } from '@tabtin/app-host-sdk'
import { Toaster } from '@tabtin/smartsheet-ui/toast'
import { AppGlobalEffects } from './AppGlobalEffects'
import { AppErrorToast } from './AppErrorToast'
import { ShellTitleBar } from '@components/platform/shell-title-bar'
import { WINDOW_DRAG_REGION_HEIGHT } from '@components/platform/drag-region'
import { ErrorBoundary } from '@components/common/ErrorBoundary'
import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { useCentrifugoClient } from '@/hooks/useCentrifugoClient'
import { useDetachedThemeSync } from '@/hooks/useDetachedThemeSync'
import { useOrganizationSync } from '@/hooks/useOrganizationSync'
import { useIMProviderClient } from '@/hooks/useIMProviderClient'
import { useIMStore } from '@stores/useIMStore'
import { SHELL_CANVAS_CLASS } from '@components/layout/shellUi'
import { cn } from '@utils/cn'
import { ChatResourcePreviewModal } from '@components/chat/preview/ChatResourcePreviewModal'
import { GlobalSharedSessionFilePreviewHost } from '@components/chat/shared-view/preview'
import { useTranslation } from 'react-i18next'

const TabChatPanel = React.lazy(
  () => import('@components/tabchat/TabChatPanel').then(m => ({ default: m.TabChatPanel })),
)

function IMRealtimeBridge() {
  useCentrifugoClient()
  useIMProviderClient()
  return null
}

export function AppDetachedIM() {
  const { t } = useTranslation('common')
  const sharedHostClient = getSharedAppHostClient()
  const openIM = useIMStore((state) => state.openIM)
  const closeIM = useIMStore((state) => state.closeIM)
  const topBarRightInset = 0

  useDetachedThemeSync()
  // 私信窗口侧：团队切换与主窗口双向同步
  useOrganizationSync()

  useEffect(() => {
    openIM()
    return () => {
      closeIM()
    }
  }, [closeIM, openIM])

  return (
    <AppHostClientProvider value={sharedHostClient}>
      <div className={cn('app relative flex h-screen w-screen flex-col overflow-hidden', SHELL_CANVAS_CLASS)}>
        <ShellTitleBar fallbackDrag />
        <AppGlobalEffects isDetachedChat hasMainWindowHost />
        <IMRealtimeBridge />
        {/* 独立窗没有 ShellTopBar：Win/Linux 靠 ShellTitleBar 浮层拖拽，Mac 靠红绿灯区。
            内容顶距统一按拖拽带高度避让，避免首行控件落入 drag region。 */}
        <div
          className="min-h-0 flex-1 px-2 pb-2"
          style={{ paddingTop: WINDOW_DRAG_REGION_HEIGHT }}
        >
          <ErrorBoundary
            fallback={
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background text-foreground">
                <p className="text-subtitle text-muted-foreground">{t('errorBoundary.message')}</p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="text-body font-medium text-accent transition-colors duration-150 hover:text-accent/80"
                >
                  {t('errorBoundary.refresh')}
                </button>
              </div>
            }
          >
            <React.Suspense fallback={<div className="flex h-full items-center justify-center"><div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /></div>}>
              <TabChatPanel mode="full" surface="card" topBarRightInset={topBarRightInset} />
            </React.Suspense>
          </ErrorBoundary>
        </div>
        <ChatResourcePreviewModal />
        <GlobalSharedSessionFilePreviewHost />
        <Toaster />
        <AppErrorToast />
      </div>
    </AppHostClientProvider>
  )
}
