import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'
/**
 * Tins Home Section
 *
 * 在首页资源面板中显示已安装的 Tin 摘要。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Puzzle, Sparkles, RefreshCw } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { TINS_LIST_MAX } from '../../constants'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useTinsStore } from '@/stores/useTinsStore'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { openTinsPanel } from '../../../tins/openTinsPanel'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'

const TinsSection: React.FC<HomeSectionProps> = ({ spaceId }) => {
  const { t } = useTranslation('tins')
  const organizationId = useResolvedOrganizationId()
  const instances = useTinsStore((s) => s.instances)
  const activationStates = useTinsStore((s) => s.activationStates)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doLoad = useCallback(async () => {
    if (!organizationId || !spaceId) return
    setLoading(true)
    setError(null)
    try {
      await useTinsStore.getState().loadInstances(organizationId, spaceId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [organizationId, spaceId])

  useEffect(() => {
    void doLoad()
  }, [doLoad])

  const openPanel = useCallback(() => openTinsPanel(spaceId), [spaceId])

  if (loading && instances.length === 0) {
    return <DetailedRowListSkeleton count={3} compact showPreview={false} />
  }

  if (error && instances.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <p className="text-body text-destructive">{t('home.loadError')}</p>
        <Button variant="outline" size="sm" onClick={doLoad}>
          <RefreshCw className="h-3 w-3" />
          {t('home.retry')}
        </Button>
      </div>
    )
  }

  if (instances.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <Puzzle className="h-8 w-8 text-muted-foreground/20" />
        <p className="text-body text-muted-foreground">{t('empty.title')}</p>
        <p className={cn('max-w-[240px]', CANVAS_TEXT_META)}>{t('empty.description')}</p>
        <Button variant="outline" size="sm" className="mt-1" onClick={openPanel}>
          <Sparkles className="h-3 w-3" />
          {t('empty.openPanel')}
        </Button>
      </div>
    )
  }

  const activeCount = activationStates.filter((s) => s.isActive).length

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <button
          onClick={openPanel}
          className="flex items-center gap-1.5 text-body font-medium hover:text-primary transition-colors"
        >
          <Puzzle className="w-4 h-4 text-type-webhook" />
          {t('title')}
          <span className="text-body text-muted-foreground">({instances.length})</span>
        </button>
      </div>

      <div className="grid gap-1">
        {instances.slice(0, TINS_LIST_MAX).map((instance) => {
          const isActive = activationStates.some(
            (s) => s.instanceId === instance.id && s.isActive
          )
          return (
            <button
              key={instance.id}
              onClick={openPanel}
              className="flex items-center gap-2 px-2 py-1 rounded-md text-left hover:bg-accent transition-colors"
            >
              {instance.tin?.icon_url ? (
                <img src={instance.tin.icon_url} alt="" className="w-4 h-4 rounded" />
              ) : (
                <Puzzle className="w-3.5 h-3.5 text-muted-foreground" />
              )}
              <span className="text-body truncate flex-1">{instance.tin?.name ?? instance.id}</span>
              {isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />
              )}
              {!instance.is_enabled && (
                <span className="text-body text-muted-foreground">{t('action.disable')}</span>
              )}
            </button>
          )
        })}
        {instances.length > 5 && (
          <button
            onClick={openPanel}
            className="text-body text-muted-foreground hover:text-primary px-2 py-1"
          >
            {t('home.viewAll', { count: instances.length })}
          </button>
        )}
      </div>

      {activeCount > 0 && (
        <div className="flex items-center gap-1 px-2 text-body text-success">
          <Sparkles className="w-3 h-3" />
          {t('home.activeCount', { count: activeCount })}
        </div>
      )}
    </div>
  )
}

export const tinsHomeSection: HomeSectionHandler = {
  appId: 'tins',
  labelKey: 'home.assetBrowser.tins',
  Component: TinsSection,
}
