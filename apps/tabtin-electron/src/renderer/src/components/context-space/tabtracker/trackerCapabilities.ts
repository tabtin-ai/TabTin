/**
 * Tracker CLI 能力总览数据（由 scripts/generate-tracker-capabilities.py 从 Go CLI 生成）。
 * 勿手改 generated/tracker-capabilities.json——改 packages/tabtin-cli-go/cmd/tracker_showcase.go 后重新生成。
 */

import rawManifest from './generated/tracker-capabilities.json'

export interface TrackerCapabilityGroup {
  id: string
  label: string
  order: number
}

export interface TrackerCapabilityCommand {
  name: string
  short: string
  long: string
  risk?: string
  group: string
  group_label: string
}

export interface TrackerFeaturedScenario {
  key: string
  commands: string[]
  title: string
  description: string
  prompt: string
}

export interface TrackerCapabilitiesManifest {
  version: number
  groups: TrackerCapabilityGroup[]
  commands: TrackerCapabilityCommand[]
  featured: TrackerFeaturedScenario[]
}

export const trackerCapabilitiesManifest = rawManifest as TrackerCapabilitiesManifest

export function groupTrackerCommands(
  manifest: TrackerCapabilitiesManifest = trackerCapabilitiesManifest,
): Array<{ group: TrackerCapabilityGroup; commands: TrackerCapabilityCommand[] }> {
  const sortedGroups = [...manifest.groups].sort((a, b) => a.order - b.order)
  return sortedGroups.map(group => ({
    group,
    commands: manifest.commands.filter(cmd => cmd.group === group.id),
  }))
}

/** 把 CLI 命令名格式化为用户可见的 tabtin 调用示例 */
export function formatTrackerCliName(name: string): string {
  return `tabtin ${name}`
}

/** 从 help short 生成交给 Agent 的 NL 任务句 */
export function buildAgentPromptForCommand(cmd: TrackerCapabilityCommand): string {
  return `帮我${cmd.short.replace(/[。．]$/, '')}。你可以用 \`${formatTrackerCliName(cmd.name)}\` 完成。`
}

export function riskLabel(risk?: string): string | null {
  switch (risk) {
    case 'write':
      return '写入'
    case 'high-risk-write':
      return '不可逆'
    default:
      return null
  }
}
