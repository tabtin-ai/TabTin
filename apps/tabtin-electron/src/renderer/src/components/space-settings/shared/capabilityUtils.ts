import type { HostRuntimeSnapshot } from '@tabtin/shared'
import type { RuntimeToolGroup } from './types'

export const MAX_CHIPS = 10

export const RUNTIME_TOOL_GROUP_RULES: Array<{ label: string; test: (tool: string) => boolean }> = [
  {
    label: 'Code & Files',
    test: tool => /^(read_file|write_file|edit_file|delete_file|grep_search|glob_search|git_)/.test(tool),
  },
  {
    label: 'Terminal',
    test: tool => /(terminal|pty|shell|command)/.test(tool),
  },
  {
    label: 'Browser & Crawl',
    test: tool => /(browser|tab|snapshot|observe|capture|extract|resource|stream|record|replay|cookie|route|network|console|markdown|pdf|download|m3u8|crawl)/.test(tool),
  },
  {
    label: 'Platform Apps',
    test: tool => /(table|doc|design|slide|video|goal|mail|memo|canvas|context|space)/.test(tool),
  },
]

export function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

export function uniqById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    if (seen.has(value.id)) continue
    seen.add(value.id)
    result.push(value)
  }
  return result
}

export function groupRuntimeTools(tools: string[]): RuntimeToolGroup[] {
  const buckets = new Map<string, string[]>()
  const unmatched: string[] = []

  for (const tool of uniqStrings(tools)) {
    const rule = RUNTIME_TOOL_GROUP_RULES.find(candidate => candidate.test(tool))
    if (!rule) {
      unmatched.push(tool)
      continue
    }
    const existing = buckets.get(rule.label) ?? []
    existing.push(tool)
    buckets.set(rule.label, existing)
  }

  const groups: RuntimeToolGroup[] = Array.from(buckets.entries()).map(([label, groupTools]) => ({
    label,
    tools: groupTools,
  }))

  if (unmatched.length > 0) {
    groups.push({ label: 'Other', tools: unmatched })
  }

  return groups
}

export function formatToolName(name: string): string {
  return name.replace(/^tabtin_/, '')
}

export function buildChipItems(items: string[]): { visible: string[]; remaining: number } {
  return {
    visible: items.slice(0, MAX_CHIPS),
    remaining: Math.max(0, items.length - MAX_CHIPS),
  }
}

export function snapshotToolNames(snapshot: HostRuntimeSnapshot | null | undefined): string[] {
  return uniqStrings(
    Array.isArray(snapshot?.runtime_tools)
      ? snapshot.runtime_tools
        .map(item => item?.name)
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
  )
}

export function snapshotMcpToolNames(snapshot: HostRuntimeSnapshot | null | undefined): string[] {
  const tools = snapshot?.mcp_server?.tools
  return uniqStrings(
    Array.isArray(tools)
      ? tools
        .map(item => item?.name)
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
  )
}

export function hasMatchingTool(tools: string[], pattern: RegExp): boolean {
  return tools.some(tool => pattern.test(tool))
}

export function getFreshnessTone(state: string | undefined): 'default' | 'danger' | 'muted' {
  if (state === 'expired') return 'danger'
  if (state === 'stale' || state === 'unknown') return 'muted'
  return 'default'
}

export function getFreshnessLabel(state: string | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (state) {
    case 'fresh':
      return t('toolsCli.execution.fresh', { defaultValue: '执行快照新鲜' })
    case 'stale':
      return t('toolsCli.execution.stale', { defaultValue: '执行快照偏旧' })
    case 'expired':
      return t('toolsCli.execution.expired', { defaultValue: '执行快照已过期' })
    default:
      return t('toolsCli.execution.unknown', { defaultValue: '执行快照未知' })
  }
}
