/**
 * TabDataCapabilityBanner — 多维表首页的「让 AI 帮你处理表格」介绍区
 *
 * featured 示例卡来自 CLI 生成的 tabdata-capabilities.json（curated NL prompt）；
 * 「查看全部」在当前列表内展示全部 showcase CLI 能力（与 tabtin table 一一对应）。
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Columns3,
  Database,
  Eye,
  FolderOpen,
  History,
  Link2,
  Rows3,
  Search,
  Share2,
  Table2,
  Upload,
  BarChart3,
  Workflow,
} from 'lucide-react'
import { requestAgentForTable } from './requestAgentForTable'
import {
  buildAgentPromptForCommand,
  tabDataCapabilitiesManifest,
  type TabDataFeaturedScenario,
} from './tabdataCapabilities'
import { CapabilityBanner } from '../CapabilityBanner'

const COLLAPSE_STORAGE_KEY = 'tabtin:tabdata:capabilityBanner:collapsed'

const FEATURED_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  build: Table2,
  import: Upload,
  analyze: BarChart3,
  model: Workflow,
}

const GROUP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  tables: Table2,
  records: Rows3,
  fields: Columns3,
  views: Eye,
  sql: Database,
  relations: Link2,
  import_export: Upload,
  version_history: History,
  organize: FolderOpen,
  share: Share2,
}

function iconForDataScenario(scenario: TabDataFeaturedScenario): React.ComponentType<{ className?: string }> {
  const featuredIcon = FEATURED_ICONS[scenario.key]
  if (featuredIcon) return featuredIcon

  const command = tabDataCapabilitiesManifest.commands.find(cmd => cmd.name === scenario.commands[0])
  if (command?.name.includes('search')) return Search
  return command ? (GROUP_ICONS[command.group] ?? Table2) : Table2
}

interface TabDataCapabilityBannerProps {
  spaceId: string
  collapsedVariant?: 'bar' | 'fab'
  floating?: boolean
  onFabPointerDown?: React.PointerEventHandler<HTMLButtonElement>
  onFabClickCapture?: React.MouseEventHandler<HTMLButtonElement>
}

export const TabDataCapabilityBanner: React.FC<TabDataCapabilityBannerProps> = ({
  spaceId,
  collapsedVariant = 'fab',
  floating = true,
  onFabPointerDown,
  onFabClickCapture,
}) => {
  const { t } = useTranslation('context')

  const featured = tabDataCapabilitiesManifest.featured
  const allScenarios: TabDataFeaturedScenario[] = tabDataCapabilitiesManifest.commands.map(cmd => ({
    key: `cmd:${cmd.name}`,
    commands: [cmd.name],
    title: cmd.short,
    description: cmd.long || cmd.name,
    prompt: buildAgentPromptForCommand(cmd),
  }))

  const handleFeatured = useCallback((scenario: TabDataFeaturedScenario) => {
    if (!spaceId) return
    void requestAgentForTable(spaceId, scenario.prompt)
  }, [spaceId])

  const capabilityCount = tabDataCapabilitiesManifest.commands.length

  return (
    <CapabilityBanner
      storageKey={collapsedVariant === 'fab' ? `${COLLAPSE_STORAGE_KEY}:fab` : COLLAPSE_STORAGE_KEY}
      title={t('home.tableCapability.title', { defaultValue: '让 AI 帮你处理表格' })}
      viewAllLabel={t('home.tableCapability.viewAll', {
        defaultValue: '查看全部 {{count}} 项表格能力',
        count: capabilityCount,
      })}
      scenarios={featured}
      allScenarios={allScenarios}
      iconForScenario={iconForDataScenario}
      onScenarioClick={handleFeatured}
      collapsedVariant={collapsedVariant}
      floating={floating}
      onFabPointerDown={onFabPointerDown}
      onFabClickCapture={onFabClickCapture}
    />
  )
}
