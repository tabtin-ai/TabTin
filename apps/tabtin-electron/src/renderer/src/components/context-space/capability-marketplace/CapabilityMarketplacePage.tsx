import { Activity, useState } from 'react'
import { BookText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ROLE_LEVELS } from '@tabtin/app-shell'

import { cn } from '@utils/cn'
import { McpPanel } from '@components/space-settings/McpPanel'
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { SkillPanel } from '../skills/SkillPanel'

type CapabilityTab = 'skills' | 'connectors'

const TABS: CapabilityTab[] = ['skills', 'connectors']

export function CapabilityMarketplacePage({ spaceId }: { spaceId?: string | null }) {
  const { t } = useTranslation('context')
  const [activeTab, setActiveTab] = useState<CapabilityTab>('skills')
  const currentUserRole = useOrganizationStore(state => state.currentUserRole)
  const organizationId = useSpaceStore(state =>
    spaceId ? state.spaces.find(space => space.id === spaceId)?.organization_id ?? null : null,
  )
  // 与后端 create_org_connection（editor+）对齐；viewer 不展示「共享给组织」等写操作。
  const canManageConnectors = Boolean(
    currentUserRole && ROLE_LEVELS[currentUserRole] >= ROLE_LEVELS.editor,
  )
  return (
    <StandaloneModulePage
      icon={
        <BookText className="h-7 w-7" strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
      }
      title={t('skills.marketplace.title')}
      titleAs="h1"
      description={t('skills.marketplace.description')}
      descriptionClassName="whitespace-normal"
      testId="capability-marketplace-page"
    >
      <div className="mr-3 flex min-h-0 flex-1 flex-col overflow-y-auto pb-10 pr-4">
        <div
          className="mb-4 flex shrink-0 items-center border-b border-border/80"
          role="tablist"
          aria-label={t('skills.marketplace.tabsLabel')}
        >
          {TABS.map(tab => {
            const selected = activeTab === tab
            return (
              <button
                key={tab}
                id={`capability-tab-${tab}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`capability-panel-${tab}`}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'relative h-9 px-3.5 text-body font-medium transition-colors',
                  selected ? 'font-medium text-foreground' : 'text-muted-foreground/60 hover:text-foreground',
                )}
              >
                {t(`skills.marketplace.tabs.${tab}`)}
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-x-3.5 bottom-[-1px] h-0.5 rounded-full bg-foreground transition-opacity',
                    selected ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </button>
            )
          })}
        </div>

        <div className="min-w-0">
          <Activity mode={activeTab === 'skills' ? 'visible' : 'hidden'}>
            <section
              id="capability-panel-skills"
              role="tabpanel"
              aria-labelledby="capability-tab-skills"
              className="min-w-0"
            >
              <SkillPanel
                spaceId={spaceId}
                marketplaceMode
                catalogActive={activeTab === 'skills'}
                contentShell="bleed"
                hidePageHeader
              />
            </section>
          </Activity>

          <Activity mode={activeTab === 'connectors' ? 'visible' : 'hidden'}>
            <section
              id="capability-panel-connectors"
              role="tabpanel"
              aria-labelledby="capability-tab-connectors"
              className="min-w-0"
            >
              <McpPanel
                embedded
                organizationId={organizationId}
                canManage={canManageConnectors}
                liveCatalog
                catalogActive={activeTab === 'connectors'}
              />
            </section>
          </Activity>
        </div>
      </div>
    </StandaloneModulePage>
  )
}
