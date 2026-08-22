/**
 * TabWebCapabilityBanner — 浏览器首页的「让 AI 帮你处理浏览器」介绍区
 *
 * featured 示例卡来自 CLI 生成的 tabweb-capabilities.json（curated NL prompt）；
 * 「查看全部」在当前列表内展示全部 showcase CLI 能力（与 tabtin browser 一一对应，共 46 条）。
 * 产品意图：给一个「逐条回归所有浏览器能力」的统一入口——点一下就让 Agent 跑对应 CLI。
 */

import React, { useCallback } from 'react'
import {
  Camera,
  Cookie,
  Download,
  FileText,
  Film,
  Globe,
  Images,
  LayoutGrid,
  MousePointerClick,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { requestAgentForBrowser } from './requestAgentForBrowser'
import {
  buildAgentPromptForCommand,
  tabWebCapabilitiesManifest,
  type TabWebFeaturedScenario,
} from './tabwebCapabilities'
import { CapabilityBanner } from '../CapabilityBanner'

const COLLAPSE_STORAGE_KEY = 'tabtin:tabweb:capabilityBanner:collapsed'

const FEATURED_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  open: Globe,
  read: FileText,
  observe: MousePointerClick,
  download: Download,
}

const GROUP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  navigate: Globe,
  read: FileText,
  capture: Camera,
  interact: MousePointerClick,
  tab: LayoutGrid,
  session: Cookie,
  resource: Images,
  record: Film,
}

function iconForWebScenario(scenario: TabWebFeaturedScenario): React.ComponentType<{ className?: string }> {
  const featuredIcon = FEATURED_ICONS[scenario.key]
  if (featuredIcon) return featuredIcon

  const command = tabWebCapabilitiesManifest.commands.find(cmd => cmd.name === scenario.commands[0])
  if (command?.name.includes('download')) return Download
  return command ? (GROUP_ICONS[command.group] ?? Globe) : Globe
}

interface TabWebCapabilityBannerProps {
  spaceId: string
  collapsedVariant?: 'bar' | 'fab'
  floating?: boolean
}

export const TabWebCapabilityBanner: React.FC<TabWebCapabilityBannerProps> = ({
  spaceId,
  collapsedVariant = 'fab',
  floating = true,
}) => {
  const { t } = useTranslation('context')

  const featured = tabWebCapabilitiesManifest.featured
  const allScenarios: TabWebFeaturedScenario[] = tabWebCapabilitiesManifest.commands.map(cmd => ({
    key: `cmd:${cmd.name}`,
    commands: [cmd.name],
    title: cmd.short,
    description: cmd.long || cmd.name,
    prompt: buildAgentPromptForCommand(cmd),
  }))

  const handleFeatured = useCallback((scenario: TabWebFeaturedScenario) => {
    if (!spaceId) return
    void requestAgentForBrowser(spaceId, scenario.prompt, {
      source: scenario.key.startsWith('cmd:') ? 'capability-dialog' : 'featured',
      scenarioKey: scenario.key,
      title: scenario.title,
    })
  }, [spaceId])

  const capabilityCount = tabWebCapabilitiesManifest.commands.length

  return (
    <CapabilityBanner
      storageKey={collapsedVariant === 'fab' ? `${COLLAPSE_STORAGE_KEY}:fab` : COLLAPSE_STORAGE_KEY}
      title={t('home.browserCapability.title', { defaultValue: '让 AI 帮你处理浏览器' })}
      viewAllLabel={t('home.browserCapability.viewAll', {
        defaultValue: '查看全部 {{count}} 项浏览器能力',
        count: capabilityCount,
      })}
      scenarios={featured}
      allScenarios={allScenarios}
      iconForScenario={iconForWebScenario}
      onScenarioClick={handleFeatured}
      collapsedVariant={collapsedVariant}
      floating={floating}
    />
  )
}
