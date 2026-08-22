import React, { useEffect, useId, useState } from 'react'
import { Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Organization } from '@tabtin/app-shell'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { cn } from '@utils/cn'
import { OrganizationAppCatalogPanel } from './OrganizationAppCatalogPanel'
import { LocalPluginMarketplacePanel } from './LocalPluginMarketplacePanel'

type AppMarketTab = 'collaborative' | 'local'

/**
 * 统一「应用市场」——把原「应用市场（协作）」+「插件市场（本机）」两个入口收敛为一个面板，
 * 内部分「协作」「本机」两个分区（三态分类中的 collaborative / local）。
 *
 *  - 协作分区：数据源 useOrganizationAppCatalog（后端 app-catalog，按 surface==='collaborative' 归入），
 *    第一方预置、默认全团队可用，蓝底 + 治理标。
 *  - 本机分区：数据源 personalPluginMarketplaceClient（Personal Plugin，如 Cowart，surface==='local'），
 *    个人安装到本机，绿底轻角标。install/enable 分离（启用在工作空间设置）与官方 Release 更新治理机制不变。
 *  - 内置（builtin）不进市场，归「更多应用」总览。
 *  - 技能市场（SkillMarketplace）保持独立层，不在此面板。
 */
interface AppMarketplacePanelProps {
  organization: Organization
  canManageOrganization?: boolean
  showHeader?: boolean
  initialTab?: AppMarketTab
  fillContainer?: boolean
  className?: string
}

export const AppMarketplacePanel: React.FC<AppMarketplacePanelProps> = ({
  organization,
  canManageOrganization = false,
  showHeader = true,
  initialTab = 'collaborative',
  fillContainer = false,
  className,
}) => {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<AppMarketTab>(initialTab)
  const idPrefix = useId()
  const collaborativeTabId = `${idPrefix}-app-marketplace-collaborative-tab`
  const localTabId = `${idPrefix}-app-marketplace-local-tab`
  const tabPanelId = `${idPrefix}-app-marketplace-tabpanel`

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  return (
    <SettingsPanelLayout className={cn(fillContainer ? 'max-w-none' : 'max-w-3xl', className)}>
      {showHeader ? (
        <SettingsPanelHeader
          icon={<Store className="h-4 w-4" />}
          title={t('appMarket.title')}
          subtitle={t('appMarket.subtitle')}
        />
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div
          role="tablist"
          aria-label={t('appMarket.title')}
          className="flex shrink-0 gap-1"
        >
          <button
            id={collaborativeTabId}
            type="button"
            role="tab"
            aria-selected={activeTab === 'collaborative'}
            aria-controls={tabPanelId}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-interactive px-2.5 text-body transition-colors',
              activeTab === 'collaborative'
                ? 'bg-foreground/[0.06] font-medium text-accent-text dark:bg-foreground/[0.08]'
                : 'font-normal text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]',
            )}
            onClick={() => setActiveTab('collaborative')}
          >
            {t('appMarket.collaborativeSection')}
          </button>
          <button
            id={localTabId}
            type="button"
            role="tab"
            aria-selected={activeTab === 'local'}
            aria-controls={tabPanelId}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-interactive px-2.5 text-body transition-colors',
              activeTab === 'local'
                ? 'bg-foreground/[0.06] font-medium text-accent-text dark:bg-foreground/[0.08]'
                : 'font-normal text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]',
            )}
            onClick={() => setActiveTab('local')}
          >
            {t('appMarket.localSection')}
          </button>
        </div>
      </div>

      <div
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={activeTab === 'collaborative' ? collaborativeTabId : localTabId}
        className="min-w-0"
      >
        {activeTab === 'collaborative' ? (
          <OrganizationAppCatalogPanel
            organization={organization}
            canManageOrganization={canManageOrganization}
            showHeader={false}
            embedded
            wideGrid={fillContainer}
          />
        ) : (
          <LocalPluginMarketplacePanel
            organization={organization}
            canManageOrganization={canManageOrganization}
            view="marketplace"
            showHeader={false}
            embedded
            wideGrid={fillContainer}
          />
        )}
      </div>
    </SettingsPanelLayout>
  )
}
