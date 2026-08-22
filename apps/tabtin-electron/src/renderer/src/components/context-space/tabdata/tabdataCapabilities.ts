/**
 * TabData CLI 能力总览数据（由 scripts/generate-tabdata-capabilities.py 从 Go CLI 生成）。
 * 勿手改 generated/tabdata-capabilities.json——改 packages/tabtin-cli-go/cmd/table/table_showcase.go 后重新生成。
 */

import rawManifest from './generated/tabdata-capabilities.json'

export interface TabDataCapabilityGroup {
  id: string
  label: string
  order: number
}

export interface TabDataCapabilityCommand {
  name: string
  short: string
  long: string
  risk?: string
  group: string
  group_label: string
}

export interface TabDataFeaturedScenario {
  key: string
  commands: string[]
  title: string
  description: string
  prompt: string
}

export interface TabDataCapabilitiesManifest {
  version: number
  groups: TabDataCapabilityGroup[]
  commands: TabDataCapabilityCommand[]
  featured: TabDataFeaturedScenario[]
}

export const tabDataCapabilitiesManifest = rawManifest as TabDataCapabilitiesManifest

export function groupTabDataCommands(
  manifest: TabDataCapabilitiesManifest = tabDataCapabilitiesManifest,
): Array<{ group: TabDataCapabilityGroup; commands: TabDataCapabilityCommand[] }> {
  const sortedGroups = [...manifest.groups].sort((a, b) => a.order - b.order)
  return sortedGroups.map(group => ({
    group,
    commands: manifest.commands.filter(cmd => cmd.group === group.id),
  }))
}

/** 把 CLI 命令名格式化为用户可见的 tabtin 调用示例 */
export function formatTabDataCliName(name: string): string {
  return `tabtin ${name}`
}

/** 从 help short 生成交给 Agent 的 NL 任务句 */
export function buildAgentPromptForCommand(cmd: TabDataCapabilityCommand): string {
  return `帮我${cmd.short.replace(/[。．]$/, '')}。你可以用 \`${formatTabDataCliName(cmd.name)}\` 完成。`
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
