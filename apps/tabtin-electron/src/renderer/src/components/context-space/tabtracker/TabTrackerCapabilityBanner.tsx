/**
 * TabTrackerCapabilityBanner — 自动化首页的「让 AI 帮你处理自动化」介绍区
 *
 * featured 示例卡来自 CLI 生成的 tracker-capabilities.json（curated NL prompt）；
 * 「查看全部」在当前列表内展示全部 showcase CLI 能力（与 tabtin tracker 一一对应，共 12 条）。
 * 产品意图：给一个「让 Agent 帮你建 / 看 / 控制自动化」的统一入口——点一下就让 Agent 跑对应 CLI。
 */

import React, { useCallback } from 'react'
import {
  CalendarPlus,
  ListChecks,
  Pause,
  PlayCircle,
  Trash2,
  FlaskConical,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { requestAgentForTracker } from './requestAgentForTracker'
import {
  buildAgentPromptForCommand,
  trackerCapabilitiesManifest,
  type TrackerFeaturedScenario,
} from './trackerCapabilities'
import { CapabilityBanner } from '../CapabilityBanner'

const COLLAPSE_STORAGE_KEY = 'tabtin:tabtracker:capabilityBanner:collapsed'

const FEATURED_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  create: CalendarPlus,
  inspect: ListChecks,
  control: Pause,
  verify: FlaskConical,
}

const GROUP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  create: CalendarPlus,
  inspect: ListChecks,
  control: Pause,
  verify: FlaskConical,
}

function iconForTrackerScenario(scenario: TrackerFeaturedScenario): React.ComponentType<{ className?: string }> {
  const featuredIcon = FEATURED_ICONS[scenario.key]
  if (featuredIcon) return featuredIcon

  const command = trackerCapabilitiesManifest.commands.find(cmd => cmd.name === scenario.commands[0])
  if (command?.name.includes('run')) return PlayCircle
  if (command?.name.includes('delete')) return Trash2
  return command ? (GROUP_ICONS[command.group] ?? CalendarPlus) : CalendarPlus
}

interface TabTrackerCapabilityBannerProps {
  spaceId: string
  collapsedVariant?: 'bar' | 'fab'
  floating?: boolean
}

export const TabTrackerCapabilityBanner: React.FC<TabTrackerCapabilityBannerProps> = ({
  spaceId,
  collapsedVariant = 'fab',
  floating = true,
}) => {
  const { t } = useTranslation('context')

  const featured = trackerCapabilitiesManifest.featured
  const allScenarios: TrackerFeaturedScenario[] = trackerCapabilitiesManifest.commands.map(cmd => ({
    key: `cmd:${cmd.name}`,
    commands: [cmd.name],
    title: cmd.short,
    description: cmd.long || cmd.name,
    prompt: buildAgentPromptForCommand(cmd),
  }))

  const handleFeatured = useCallback((scenario: TrackerFeaturedScenario) => {
    if (!spaceId) return
    void requestAgentForTracker(spaceId, scenario.prompt)
  }, [spaceId])

  const capabilityCount = trackerCapabilitiesManifest.commands.length

  return (
    <CapabilityBanner
      storageKey={collapsedVariant === 'fab' ? `${COLLAPSE_STORAGE_KEY}:fab` : COLLAPSE_STORAGE_KEY}
      title={t('home.trackerCapability.title', { defaultValue: '让 AI 帮你处理自动化任务' })}
      viewAllLabel={t('home.trackerCapability.viewAll', {
        defaultValue: '查看全部 {{count}} 项自动化能力',
        count: capabilityCount,
      })}
      scenarios={featured}
      allScenarios={allScenarios}
      iconForScenario={iconForTrackerScenario}
      onScenarioClick={handleFeatured}
      collapsedVariant={collapsedVariant}
      floating={floating}
    />
  )
}
