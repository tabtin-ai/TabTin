/**
 * TabDocCapabilityBanner — 文档首页的「让 AI 帮你处理文档」介绍区
 *
 * featured 示例卡来自 CLI 生成的 tabdoc-capabilities.json（curated NL prompt）；
 * 「查看全部」在当前列表内展示全部 showcase CLI 能力（help 驱动，与 tabtin doc 一一对应）。
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  FilePlus2,
  FileText,
  Layers,
  BarChart3,
  Blocks,
  Download,
  History,
  Search,
  Share2,
  Upload,
  Users,
  Wand2,
} from 'lucide-react'
import { requestAgentForDoc } from './requestAgentForDoc'
import {
  buildAgentPromptForCommand,
  tabDocCapabilitiesManifest,
  type TabDocFeaturedScenario,
} from './tabdocCapabilities'
import { CapabilityBanner } from '../CapabilityBanner'

const COLLAPSE_STORAGE_KEY = 'tabtin:tabdoc:capabilityBanner:collapsed'

const FEATURED_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  create: FilePlus2,
  summarize: Layers,
  report: BarChart3,
  polish: Wand2,
}

const GROUP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  browse: Search,
  create_edit: FileText,
  blocks: Blocks,
  organize: Archive,
  version: History,
  collab: Users,
  share: Share2,
  import_export: Upload,
}

function iconForDocScenario(scenario: TabDocFeaturedScenario): React.ComponentType<{ className?: string }> {
  const featuredIcon = FEATURED_ICONS[scenario.key]
  if (featuredIcon) return featuredIcon

  const command = tabDocCapabilitiesManifest.commands.find(cmd => cmd.name === scenario.commands[0])
  if (command?.name.includes('export')) return Download
  return command ? (GROUP_ICONS[command.group] ?? FilePlus2) : FilePlus2
}

interface TabDocCapabilityBannerProps {
  spaceId: string
  collapsedVariant?: 'bar' | 'fab'
  floating?: boolean
  onFabPointerDown?: React.PointerEventHandler<HTMLButtonElement>
  onFabClickCapture?: React.MouseEventHandler<HTMLButtonElement>
}

export const TabDocCapabilityBanner: React.FC<TabDocCapabilityBannerProps> = ({
  spaceId,
  collapsedVariant = 'fab',
  floating = true,
  onFabPointerDown,
  onFabClickCapture,
}) => {
  const { t } = useTranslation('context')

  const featured = tabDocCapabilitiesManifest.featured
  const allScenarios: TabDocFeaturedScenario[] = tabDocCapabilitiesManifest.commands.map(cmd => ({
    key: `cmd:${cmd.name}`,
    commands: [cmd.name],
    title: cmd.short,
    description: cmd.long || cmd.name,
    prompt: buildAgentPromptForCommand(cmd),
  }))

  const handleFeatured = useCallback((scenario: TabDocFeaturedScenario) => {
    if (!spaceId) return
    void requestAgentForDoc(spaceId, scenario.prompt)
  }, [spaceId])

  const capabilityCount = tabDocCapabilitiesManifest.commands.length

  return (
    <CapabilityBanner
      storageKey={collapsedVariant === 'fab' ? `${COLLAPSE_STORAGE_KEY}:fab` : COLLAPSE_STORAGE_KEY}
      title={t('home.docCapability.title', { defaultValue: '让 AI 帮你处理文档' })}
      viewAllLabel={t('home.docCapability.viewAll', {
        defaultValue: '查看全部 {{count}} 项文档能力',
        count: capabilityCount,
      })}
      scenarios={featured}
      allScenarios={allScenarios}
      iconForScenario={iconForDocScenario}
      onScenarioClick={handleFeatured}
      collapsedVariant={collapsedVariant}
      floating={floating}
      onFabPointerDown={onFabPointerDown}
      onFabClickCapture={onFabClickCapture}
    />
  )
}
