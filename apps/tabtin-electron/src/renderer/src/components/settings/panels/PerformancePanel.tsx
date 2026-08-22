import React from 'react'
import { Gauge, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { ResourceMonitorPanelContent } from '@components/resource-monitor/ResourceMonitorPanel'
import { useResourceMonitorController } from '@components/resource-monitor/useResourceMonitorController'
import { cn } from '@utils/cn'
import { SETTINGS_HINT } from '../settingsUi'

export const PerformancePanel: React.FC = () => {
  const { t } = useTranslation('settings')
  const monitor = useResourceMonitorController('interactive')

  return (
    <SettingsPanelLayout className="space-y-6">
      <SettingsPanelHeader
        icon={<Gauge className="h-4 w-4" />}
        title={t('performance.title')}
        subtitle={t('performance.description')}
      />

      {monitor.isLoading && !monitor.viewModel.overview.collectedAt ? (
        <div className="flex items-center justify-center gap-2 rounded-[12px] bg-muted/10 py-16 text-body text-muted-foreground/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('performance.loading')}</span>
        </div>
      ) : (
        <SettingsSectionCard flat className="overflow-hidden rounded-[12px] bg-muted/10">
          <ResourceMonitorPanelContent
            variant="embedded"
            viewModel={monitor.viewModel}
            isLoading={monitor.isLoading}
            isRefreshing={monitor.isRefreshing}
            error={monitor.error}
            governanceEvents={monitor.recentGovernanceEvents}
            rankedSpaces={monitor.rankedSpaces}
            spaceNameById={monitor.spaceNameById}
            onRefresh={monitor.onRefresh}
            onNavigateToSpace={monitor.onNavigateToSpace}
            onNavigateToItem={monitor.onNavigateToItem}
            onNavigateToDataRuntime={monitor.onNavigateToDataRuntime}
            onNavigateToDocRuntime={monitor.onNavigateToDocRuntime}
            onCloseGovernanceItems={monitor.onCloseGovernanceItems}
            onSuggestionAction={monitor.onSuggestionAction}
          />
        </SettingsSectionCard>
      )}

      <p className={cn('max-w-2xl', SETTINGS_HINT)}>
        {t('performance.footerHint')}
      </p>
    </SettingsPanelLayout>
  )
}
