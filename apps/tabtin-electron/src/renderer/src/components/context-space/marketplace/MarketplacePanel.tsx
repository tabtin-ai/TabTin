import React, { useMemo, useState } from 'react'
import { LayoutGrid, Sparkles, Store } from 'lucide-react'
import { Button } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { canManageOrganization as canManageOrganizationFn } from '@/hooks/useCanManageOrganization'
import { useSpaceContextActions } from '@components/context-space/SpaceContextAreaContext'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { ContextPageHeader } from '../ContextPageHeader'
import { CONTEXT_PAGE_HEADER_GAP, CONTEXT_PAGE_SHELL_FILL } from '../constants'
import { SkillMarketplace } from '../skills/SkillMarketplace'
import { AppMarketplacePanel } from '@components/settings/panels/AppMarketplacePanel'

type MarketplaceTab = 'skills' | 'apps'

interface MarketplacePanelProps {
  spaceId?: string | null
}

export const MarketplacePanel: React.FC<MarketplacePanelProps> = ({ spaceId }) => {
  const { t } = useTranslation('context')
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('skills')
  const { onOpenAppHome } = useSpaceContextActions()

  const space = useSpaceStore(state =>
    spaceId ? state.spaces.find(s => s.id === spaceId) ?? null : null,
  )
  const organizations = useOrganizationStore(state => state.organizations)
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const currentUserRole = useOrganizationStore(state => state.currentUserRole)
  const user = useAuthStore(state => state.user)

  const organization = useMemo(() => {
    if (space?.organization_id) {
      return organizations.find(w => w.id === space.organization_id) ?? null
    }
    return spaceId ? null : selectedOrganization ?? null
  }, [selectedOrganization, space?.organization_id, spaceId, organizations])
  const isOwner = Boolean(user && organization && user.id === organization.owner_id)
  const roleForTargetOrganization = selectedOrganization?.id === organization?.id ? currentUserRole : null
  const canInstallToSpace = canManageOrganizationFn(roleForTargetOrganization ?? (isOwner ? 'owner' : null))
  const installDisabledReason = !spaceId
    ? t('marketplace.skills.noSpaceInstall')
    : !canInstallToSpace
      ? t('marketplace.skills.noPermissionInstall')
      : undefined

  const tabs: Array<{ id: MarketplaceTab; label: string; icon: React.ReactNode }> = [
    {
      id: 'skills',
      label: t('marketplace.tabs.skills'),
      icon: <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-500" />,
    },
    {
      id: 'apps',
      label: t('marketplace.tabs.apps'),
      icon: <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-primary/80" />,
    },
  ]

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className={CONTEXT_PAGE_SHELL_FILL}>
        <ContextPageHeader
          icon={<Store className="h-7 w-7" />}
          title={t('marketplace.title')}
          description={t('marketplace.subtitle')}
          actions={space ? (
            <span className={cn('shrink-0', 'rounded-full', 'bg-foreground/[0.04]', 'px-2', 'py-1', CANVAS_TEXT_META)}>
              {t('marketplace.currentSpace', { name: space.name })}
            </span>
          ) : null}
        />

        <div className={cn(CONTEXT_PAGE_HEADER_GAP, 'flex shrink-0 gap-1')}>
          {tabs.map(tab => (
            <Button
              key={tab.id}
              type="button"
              variant={activeTab === tab.id ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                'h-7 gap-1.5 px-2 text-body',
                activeTab === tab.id && 'text-foreground',
              )}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              {tab.label}
            </Button>
          ))}
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-hidden">
          {activeTab === 'skills' ? (
            <SkillMarketplace
              spaceId={spaceId ?? undefined}
              fillPanel
              canInstall={canInstallToSpace}
              installDisabledReason={installDisabledReason}
              onManageInstalled={(skill) => {
                const key = skill.skill_key || skill.skill_id
                onOpenAppHome('skill', key ? { skillKey: key, focusAt: Date.now() } : undefined)
              }}
            />
          ) : organization ? (
            <AppMarketplacePanel
              organization={organization}
              canManageOrganization={canInstallToSpace}
              showHeader={false}
              fillContainer
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full min-h-0 items-center justify-center">
              <div className="max-w-md rounded-interactive border border-border/50 bg-muted/10 p-5 text-center">
                <LayoutGrid className="mx-auto h-8 w-8 text-primary/80" />
                <h3 className="mt-3 text-subtitle font-semibold">{t('marketplace.apps.title')}</h3>
                <p className="mt-2 text-body text-muted-foreground/80">
                  {t('marketplace.apps.noOrganization')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
