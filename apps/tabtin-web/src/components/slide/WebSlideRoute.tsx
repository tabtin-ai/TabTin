import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutTemplate, MonitorPlay, PanelsTopLeft } from 'lucide-react'
import {
  type BackendProjectDetail,
  convertBackendToPresentation,
  SlideRenderer,
  type SlidePresentation,
} from '@tabtin/tabslide/viewer'
import { getApiClient } from '@/services/api-client'
import { useSlideLaunchContext } from '@/features/slide/useSlideLaunchContext'
import { useWebPresentation } from '@/components/layout/WebPresentationContext'

const formatDateTime = (value: string | null | undefined, locale: string): string | null => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const SlidePreview = ({
  presentation,
  pageIndex,
  scale,
  thumbnail = false,
}: {
  presentation: SlidePresentation
  pageIndex: number
  scale: number
  thumbnail?: boolean
}) => {
  const page = presentation.pages[pageIndex]
  if (!page) return null

  return (
    <SlideRenderer
      page={page}
      theme={presentation.theme}
      scale={scale}
      canvasWidth={presentation.canvasWidth}
      canvasHeight={presentation.canvasHeight}
      thumbnail={thumbnail}
    />
  )
}

export function WebSlideRoute() {
  const { slideId, buildHomePath } = useSlideLaunchContext()
  const { t, i18n } = useTranslation('common')
  const [presentation, setPresentation] = useState<SlidePresentation | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePageIndex, setActivePageIndex] = useState(0)
  const previewHostRef = useRef<HTMLDivElement | null>(null)
  const [fitScale, setFitScale] = useState(1)
  const { isEmbedded } = useWebPresentation()

  useEffect(() => {
    if (!slideId) {
      setPresentation(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    void (async () => {
      try {
        const response = await getApiClient().raw<BackendProjectDetail>('GET', `/tabslide/projects/${slideId}/`)
        if (cancelled) return

        const nextPresentation = convertBackendToPresentation({
          id: response.id,
          name: response.name,
          preset: response.preset,
          canvas_width: response.canvas_width,
          canvas_height: response.canvas_height,
          page_count: response.page_count,
          pages: response.pages,
          theme: response.theme,
          thumbnail: response.thumbnail,
          created_at: response.created_at ?? undefined,
          updated_at: response.updated_at ?? undefined,
        })

        setPresentation(nextPresentation)
        setActivePageIndex(0)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('webModules.slide.loadFailedDesc'))
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [slideId, t])

  useEffect(() => {
    if (!presentation || !previewHostRef.current) return

    const node = previewHostRef.current
    const updateScale = () => {
      const availableWidth = Math.max(node.clientWidth - 32, 320)
      setFitScale(Math.min(1, availableWidth / presentation.canvasWidth))
    }

    updateScale()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateScale)
      return () => window.removeEventListener('resize', updateScale)
    }

    const observer = new ResizeObserver(() => updateScale())
    observer.observe(node)
    return () => observer.disconnect()
  }, [presentation])

  const updatedAtLabel = useMemo(
    () => formatDateTime(presentation?.updatedAt ?? null, i18n.language),
    [i18n.language, presentation],
  )

  if (!slideId) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-sm">
          <div className="text-title font-semibold text-foreground">
            {t('webModules.slide.invalidIdTitle')}
          </div>
          <div className="mt-2 text-body text-muted-foreground">
            {t('webModules.slide.invalidIdDesc')}
          </div>
          <Link className="mt-4 inline-flex text-body text-primary hover:underline" to={buildHomePath()}>
            {t('webModules.backToSpace')}
          </Link>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-sm">
          <div className="text-body text-muted-foreground">{t('loadingEllipsis')}</div>
        </div>
      </div>
    )
  }

  if (error || !presentation) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-sm">
          <div className="text-title font-semibold text-foreground">
            {t('webModules.slide.loadFailedTitle')}
          </div>
          <div className="mt-2 text-body text-muted-foreground">
            {error || t('webModules.slide.loadFailedDesc')}
          </div>
          <Link className="mt-4 inline-flex text-body text-primary hover:underline" to={buildHomePath()}>
            {t('webModules.backToSpace')}
          </Link>
        </div>
      </div>
    )
  }

  const safeActiveIndex = Math.min(activePageIndex, Math.max(presentation.pages.length - 1, 0))
  const thumbWidth = isEmbedded ? 96 : 144
  const thumbScale = thumbWidth / presentation.canvasWidth
  const thumbHeight = presentation.canvasHeight * thumbScale

  return (
    <div className={isEmbedded ? 'h-full overflow-hidden p-2' : 'h-full overflow-hidden px-6 py-6'}>
      <div className={isEmbedded
        ? 'mx-auto flex h-full w-full max-w-[1440px] flex-col gap-2'
        : 'mx-auto flex h-full w-full max-w-[1440px] flex-col gap-6'}>
        {!isEmbedded && <section className="rounded-3xl border border-border bg-background px-6 py-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-3">
              <div className="inline-flex items-center rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-body font-medium text-primary">
                {t('webModules.previewBadge')}
              </div>
              <div className="flex items-start gap-3">
                <div className="mt-1 rounded-2xl bg-muted p-2 text-muted-foreground">
                  <MonitorPlay className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="break-words text-heading font-semibold text-foreground">
                    {presentation.name || t('webModules.slide.untitled')}
                  </h1>
                  <p className="mt-2 max-w-2xl text-body text-muted-foreground">
                    {t('webModules.slide.readonlyHint')}
                  </p>
                </div>
              </div>
            </div>

            <Link
              className="inline-flex items-center rounded-full border border-border px-4 py-2 text-body text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              to={buildHomePath()}
            >
              {t('webModules.backToSpace')}
            </Link>
          </div>

          <div className="mt-5 flex flex-wrap gap-3 text-body text-muted-foreground">
            <div className="inline-flex items-center gap-2 rounded-full bg-muted/60 px-3 py-1.5">
              <PanelsTopLeft className="h-4 w-4" />
              <span>{t('webModules.slide.pageCountLabel', { count: presentation.pages.length })}</span>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-muted/60 px-3 py-1.5">
              <LayoutTemplate className="h-4 w-4" />
              <span>
                {t('webModules.slide.canvasSizeLabel', {
                  width: presentation.canvasWidth,
                  height: presentation.canvasHeight,
                })}
              </span>
            </div>
            {updatedAtLabel ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-muted/60 px-3 py-1.5">
                <span>{t('webModules.slide.updatedAtLabel', { value: updatedAtLabel })}</span>
              </div>
            ) : null}
          </div>
        </section>}

        <section className={isEmbedded
          ? 'min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background shadow-sm'
          : 'min-h-0 flex-1 overflow-hidden rounded-3xl border border-border bg-background shadow-sm'}>
          {presentation.pages.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-body text-muted-foreground">
              {t('webModules.slide.noPages')}
            </div>
          ) : (
            <div className={isEmbedded ? 'flex h-full min-h-0 flex-col' : 'flex h-full min-h-0'}>
              <aside className={isEmbedded
                ? 'h-[132px] w-full shrink-0 border-b border-border bg-muted/20 p-2'
                : 'w-[240px] shrink-0 border-r border-border bg-muted/20 p-4'}>
                <div className={isEmbedded ? 'sr-only' : 'mb-3 text-body font-medium text-foreground'}>
                  {t('webModules.slide.pageListTitle')}
                </div>
                <div className={isEmbedded
                  ? 'flex h-full gap-2 overflow-x-auto overflow-y-hidden pb-1'
                  : 'flex h-full flex-col gap-3 overflow-auto pr-1'}>
                  {presentation.pages.map((page, index) => (
                    <button
                      key={page.id || index}
                      type="button"
                      onClick={() => setActivePageIndex(index)}
                      className={`${isEmbedded ? 'shrink-0 rounded-xl border p-1.5' : 'rounded-2xl border p-3'} text-left transition-colors ${
                        index === safeActiveIndex
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-background hover:bg-muted/40'
                      }`}
                    >
                      <div className={isEmbedded ? 'mb-1 flex items-center gap-1' : 'mb-2 flex items-center justify-between gap-2'}>
                        <span className="text-body font-medium text-muted-foreground">
                          {t('webModules.slide.pageLabel', { index: index + 1 })}
                        </span>
                        {!isEmbedded && index === safeActiveIndex ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-caption font-medium text-primary">
                            {t('webModules.slide.currentPage')}
                          </span>
                        ) : null}
                      </div>
                      <div
                        className={isEmbedded ? 'overflow-hidden rounded-lg bg-canvas' : 'overflow-hidden rounded-xl bg-canvas'}
                        style={{ width: thumbWidth, height: thumbHeight }}
                      >
                        <SlidePreview
                          presentation={presentation}
                          pageIndex={index}
                          scale={thumbScale}
                          thumbnail
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </aside>

              <div ref={previewHostRef} className={isEmbedded ? 'flex-1 overflow-auto p-2' : 'flex-1 overflow-auto p-6'}>
                <div className="flex min-w-max justify-center">
                  <div
                    style={{
                      width: presentation.canvasWidth * fitScale,
                      height: presentation.canvasHeight * fitScale,
                    }}
                  >
                    <SlidePreview
                      presentation={presentation}
                      pageIndex={safeActiveIndex}
                      scale={fitScale}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
