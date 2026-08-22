import React, { Suspense } from 'react'
import { LoadingSpinner } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSkillLibraryContextSpaceId } from '@components/settings/panels/SkillLibraryPanel'

const CapabilityMarketplacePage = React.lazy(() =>
  import('@components/context-space/capability-marketplace/CapabilityMarketplacePage').then(
    m => ({ default: m.CapabilityMarketplacePage }),
  ),
)
const ProjectMainContent = React.lazy(() =>
  import('./ProjectWorkspacePanel').then(m => ({ default: m.ProjectMainContent })),
)
const TrackerPanel = React.lazy(() =>
  import('@components/tabtracker/TrackerPanel').then(m => ({ default: m.TrackerPanel })),
)
const ExternalImportPanel = React.lazy(() =>
  import('@components/onboarding/external-import/ExternalImportPanel').then((m) => ({
    default: m.ExternalImportPanel,
  })),
)
const ExternalArchiveHub = React.lazy(() =>
  import('@components/onboarding/external-import/ExternalArchiveHub').then((m) => ({
    default: m.ExternalArchiveHub,
  })),
)
const NotificationCenterPage = React.lazy(() =>
  import('@components/notification/NotificationCenterPage').then((m) => ({
    default: m.NotificationCenterPage,
  })),
)

const AppPageEmpty: React.FC<{ title: string }> = ({ title }) => {
  const { t } = useTranslation('chat')
  return (
  <div className="flex h-full items-center justify-center">
    <div className="text-center">
      <p className="text-body font-medium text-foreground">{title}</p>
      <p className="mt-2 text-body text-muted-foreground/60">{t('input.disabled_no_space')}</p>
    </div>
  </div>
  )
}

export const AppFullPageHost: React.FC = () => {
  const { t } = useTranslation(['sidebar', 'context'])
  const activePage = useAppPageStore((s) => s.activePage)
  const activeProjectId = useAppPageStore((s) => s.activeProjectId)
  const skillSpaceId = useSkillLibraryContextSpaceId()
  const automationSpaceId = useSpaceStore((s) => s.selectedSpace?.id ?? null)

  const fallback = (
    <div className="flex h-full w-full items-center justify-center">
      <LoadingSpinner size="sm" />
    </div>
  )

  if (activePage === 'project' && activeProjectId) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <ProjectMainContent surface="detail" />
        </Suspense>
      </div>
    )
  }

  if (activePage === 'collaboration') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <ProjectMainContent surface="gallery" />
        </Suspense>
      </div>
    )
  }

  if (activePage === 'skill') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <CapabilityMarketplacePage spaceId={skillSpaceId} />
        </Suspense>
      </div>
    )
  }

  if (activePage === 'automation') {
    if (!automationSpaceId) {
      return <AppPageEmpty title={t('sidebar:primaryNav.automation', { defaultValue: '自动化' })} />
    }
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <TrackerPanel spaceId={automationSpaceId} detailNavigation="inline" />
        </Suspense>
      </div>
    )
  }

  if (activePage === 'import') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <ExternalImportPanel />
        </Suspense>
      </div>
    )
  }

  if (activePage === 'external-archives') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <ExternalArchiveHub />
        </Suspense>
      </div>
    )
  }

  if (activePage === 'notification') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Suspense fallback={fallback}>
          <NotificationCenterPage />
        </Suspense>
      </div>
    )
  }

  return null
}

export default AppFullPageHost
