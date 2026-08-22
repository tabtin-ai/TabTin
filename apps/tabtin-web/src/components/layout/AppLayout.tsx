import { useEffect, useState } from 'react'
import { Menu, X } from 'lucide-react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@tabtin/smartsheet-ui'
import { WebSidebar } from '@/components/sidebar/WebSidebar'
import { useWebPresentation } from './WebPresentationContext'
import { shouldUseMobileNavigation } from './mobileNavigationPolicy'

export function AppLayout() {
  const presentation = useWebPresentation()
  const location = useLocation()
  const { t } = useTranslation('sidebar')
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const showMobileNavigation = shouldUseMobileNavigation(presentation)

  useEffect(() => {
    setMobileNavigationOpen(false)
  }, [location.pathname, location.search, showMobileNavigation])

  return (
    <div
      className="flex h-screen overflow-hidden"
      data-web-shell={presentation.shell}
      data-web-client={presentation.client}
      data-web-layout={presentation.layout}
      data-web-input={presentation.input}
      data-web-orientation={presentation.orientation}
      data-web-host-platform={presentation.mobileHost?.platform}
      data-web-host-form-factor={presentation.mobileHost?.formFactor}
      style={{ background: 'hsl(var(--canvas))', height: '100dvh' }}
    >
      {!presentation.isEmbedded && !showMobileNavigation && <WebSidebar />}

      {showMobileNavigation ? (
        <Sheet open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
          <SheetContent
            side="left"
            closeable={false}
            className="flex w-60 max-w-[calc(100vw-3rem)] flex-col gap-0 rounded-none p-0 sm:max-w-60"
            style={{ paddingLeft: 'env(safe-area-inset-left)' }}
          >
            <div
              className="flex min-h-12 shrink-0 items-center justify-between border-b border-border/30 px-3 py-1"
              style={{ paddingTop: 'max(0.25rem, env(safe-area-inset-top))' }}
            >
              <SheetTitle className="text-body font-medium">{t('mobile.navigation')}</SheetTitle>
              <SheetClose asChild>
                <button
                  type="button"
                  className="flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-muted"
                  aria-label={t('mobile.closeNavigation')}
                >
                  <X className="size-5" />
                </button>
              </SheetClose>
            </div>
            <div className="min-h-0 flex-1">
              <WebSidebar />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {showMobileNavigation ? (
          <div
            className="flex h-12 shrink-0 items-center border-b border-border/40 bg-background px-2"
            style={{
              paddingTop: 'env(safe-area-inset-top)',
              paddingLeft: 'max(0.5rem, env(safe-area-inset-left))',
              paddingRight: 'max(0.5rem, env(safe-area-inset-right))',
            }}
          >
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-xl text-foreground transition-colors active:bg-muted"
              onClick={() => setMobileNavigationOpen(true)}
              aria-label={t('mobile.openNavigation')}
              aria-expanded={mobileNavigationOpen}
            >
              <Menu className="size-5" />
            </button>
            <span className="ml-1 text-body font-medium text-foreground">TabTin</span>
          </div>
        ) : null}
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
