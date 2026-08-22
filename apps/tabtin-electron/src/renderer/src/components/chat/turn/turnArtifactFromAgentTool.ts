/**
 * 从父 `agent` tool_result 解析子代理交付物。
 *
 * 协议与 `@tabtin/agent-host/delivery` 的 `CHILD_DELIVERABLES_TAG` /
 * `ChildDeliverable` 对齐；前端自持常量，避免 renderer 硬依赖 runtime 实现细节。
 */
import {
  canonicalizeArtifactRelativePath,
  diffFileHref,
  isDeliverableRelativePath,
} from './turnArtifactPathOps'
import { mapResourceTypeToKind } from './turnArtifactFromRich'
import type { TurnArtifact } from './turnArtifactTypes'

/** 与 runtime `CHILD_DELIVERABLES_TAG` 字节对齐。 */
export const CHILD_DELIVERABLES_TAG = 'tabtin-subagent-deliverables'

export type AgentToolDeliverable =
  | {
      artifact_kind: 'local_file'
      relative_path: string
      filename: string
      file_size?: number
    }
  | {
      artifact_kind: 'oss_file'
      file_id?: string
      filename: string
      url: string
      file_size?: number
    }
  | {
      artifact_kind: 'platform_resource'
      resource_type: string
      resource_id: string
      resource_name: string
      url: string
      space_id?: string
    }
  | {
      kind: 'widget'
      widget_id: string
      title: string
    }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isAgentToolDeliverable(value: unknown): value is AgentToolDeliverable {
  const rec = asRecord(value)
  if (!rec) return false
  if (typeof rec.artifact_kind === 'string') {
    return rec.artifact_kind === 'local_file'
      || rec.artifact_kind === 'oss_file'
      || rec.artifact_kind === 'platform_resource'
  }
  return rec.kind === 'widget' && typeof rec.widget_id === 'string'
}

/** 从 agent tool_result 文本解析 `<tabtin-subagent-deliverables>` JSON（支持 wait 多段）。 */
export function parseDeliverablesFromAgentToolContent(content: string): AgentToolDeliverable[] {
  const open = `<${CHILD_DELIVERABLES_TAG}>`
  const close = `</${CHILD_DELIVERABLES_TAG}>`
  const out: AgentToolDeliverable[] = []
  const seen = new Set<string>()
  let cursor = 0
  while (cursor < content.length) {
    const start = content.indexOf(open, cursor)
    if (start < 0) break
    const jsonStart = start + open.length
    const end = content.indexOf(close, jsonStart)
    if (end < 0) break
    cursor = end + close.length
    try {
      const parsed = JSON.parse(content.slice(jsonStart, end).trim()) as unknown
      if (!Array.isArray(parsed)) continue
      for (const item of parsed) {
        if (!isAgentToolDeliverable(item)) continue
        const key = 'artifact_kind' in item
          ? (item.artifact_kind === 'local_file'
            ? `local:${item.relative_path.toLowerCase()}`
            : item.artifact_kind === 'oss_file'
              ? `oss:${item.url}`
              : `platform:${item.url}`)
          : `widget:${item.widget_id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
    } catch {
      // skip malformed segment
    }
  }
  return out
}

function widgetChatHref(widgetId: string): string {
  return `tabtin://chat/widget/${encodeURIComponent(widgetId)}`
}

/**
 * 子代理来源显示名：与详情 header 对齐（role → label → description）。
 * 不用 task（完整 prompt）。
 */
export function resolveSubagentSourceDisplayName(input: {
  role?: string | null
  label?: string | null
  description?: string | null
}): string | undefined {
  const role = typeof input.role === 'string' ? input.role.trim() : ''
  if (role) return role
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (label) return label
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description) return description
  return undefined
}

/**
 * 子交付物 → TurnArtifact（不含 subtitleKey；由 pushArtifact 补）。
 * toolCallId / index 用于稳定 id（派发轮归属）。
 */
export function agentToolDeliverableToArtifact(
  deliverable: AgentToolDeliverable,
  toolCallId: string,
  index: number,
  sourceSubagentName?: string,
): Omit<TurnArtifact, 'subtitleKey'> | null {
  const source = sourceSubagentName?.trim()
    ? { sourceSubagentName: sourceSubagentName.trim() }
    : {}
  if ('artifact_kind' in deliverable) {
    if (deliverable.artifact_kind === 'local_file') {
      const relative = canonicalizeArtifactRelativePath(deliverable.relative_path)
      if (!relative || !isDeliverableRelativePath(relative)) return null
      return {
        id: `${toolCallId}::subagent-deliverable::${index}::${relative}`,
        kind: 'file',
        title: deliverable.filename || relative.split('/').pop() || relative,
        href: diffFileHref(relative),
        ...(typeof deliverable.file_size === 'number' ? { fileSize: deliverable.file_size } : {}),
        ...source,
      }
    }
    if (deliverable.artifact_kind === 'oss_file') {
      if (!deliverable.url.startsWith('tabtin://')) return null
      return {
        id: `${toolCallId}::subagent-deliverable::${index}::${deliverable.url}`,
        kind: 'file',
        title: deliverable.filename || 'File',
        href: deliverable.url,
        ...(typeof deliverable.file_size === 'number' ? { fileSize: deliverable.file_size } : {}),
        ...source,
      }
    }
    if (!deliverable.url.startsWith('tabtin://')) return null
    return {
      id: `${toolCallId}::subagent-deliverable::${index}::${deliverable.url}`,
      kind: mapResourceTypeToKind(deliverable.resource_type),
      title: deliverable.resource_name || deliverable.resource_type,
      href: deliverable.url,
      ...(deliverable.space_id ? { resourceSpaceId: deliverable.space_id } : {}),
      ...source,
    }
  }
  if (!deliverable.widget_id || deliverable.widget_id.startsWith('pending:')) return null
  return {
    id: `${toolCallId}::subagent-deliverable::${index}::widget::${deliverable.widget_id}`,
    kind: 'widget',
    title: deliverable.title || 'Widget',
    href: widgetChatHref(deliverable.widget_id),
    widgetId: deliverable.widget_id,
    ...source,
  }
}
