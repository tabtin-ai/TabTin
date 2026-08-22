/**
 * sessionSharePickerPresentation — IM「共享任务」选任务列表的展示口径。
 *
 * 数据来源：当前组织下个人 Workspace（非 team_space、未归档）的会话，
 * 经 useChatStore.loadSessions → sessionsBySpaceId 聚合；仅 session owner 可发起共享（后端鉴权）。
 *
 * 左栏「最近 / 各现场」的归属与计数一律用 store 桶 key（加载时的 Workspace），
 * 不用 session.space_id / workspace_id——后者可能漂移，会导致「最近」大于分项之和。
 */

import type { ChatSession } from '@tabtin/chat-client'
import type { Agent } from '@tabtin/app-shell'
import { resolveCurrentAgentDisplay } from '@components/chat/model/resolveAgentDisplayName'
import { getSessionActivityTs } from '@/utils/chat-session-sort'

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

export const SHARE_PICKER_STATUS_LABELS: Record<
  ChatSession['status'],
  { key: string; defaultValue: string }
> = {
  active: { key: 'sessionSharePicker.statusActive', defaultValue: '进行中' },
  completed: { key: 'sessionSharePicker.statusCompleted', defaultValue: '已完成' },
  archived: { key: 'sessionSharePicker.statusArchived', defaultValue: '已归档' },
}

/** 合并后的可选任务：session + 进入列表时的 Workspace 桶（计数 / 过滤 / 来源展示共用）。 */
export interface SharePickerSessionEntry {
  session: ChatSession
  sourceSpaceId: string
}

export interface SharePickerSessionContext {
  agentCache: Record<string, Pick<Agent, 'display_name' | 'name'> | undefined | null>
  selectedAgent?: Pick<Agent, 'id' | 'display_name' | 'name'> | null
  spaceNameById: Record<string, string>
  /** 多个 Workspace 时才在 meta 行展示来源 */
  showWorkspaceSource: boolean
}

export interface SharePickerSessionPresentation {
  title: string
  meta: string | null
  preview: string | null
  activityTs: number
  trackerLabel: string | null
}

export function resolveSharePickerSessionTitle(
  session: ChatSession,
  t: TranslateFn,
): string {
  const trimmed = session.title?.trim()
  if (trimmed && session.title_is_default !== true) return trimmed
  return t('sessionSharePicker.untitledTask', { defaultValue: '新任务' })
}

export function resolveSharePickerPreview(
  session: ChatSession,
  t: TranslateFn,
): string | null {
  const preview = session.last_message_preview?.trim()
  if (preview?.startsWith('Agent 已切换成')) {
    const agentName = preview.slice('Agent 已切换成'.length).trim()
    return t('sessionSharePicker.agentSwitched', {
      name: agentName,
      defaultValue: `Agent 已切换成${agentName}`,
    })
  }
  if (preview) return preview
  if ((session.message_count ?? 0) === 0) {
    return t('sessionSharePicker.noMessages', { defaultValue: '暂无消息' })
  }
  return null
}

export function buildSharePickerSessionPresentation(
  session: ChatSession,
  context: SharePickerSessionContext,
  t: TranslateFn,
  sourceSpaceId?: string | null,
): SharePickerSessionPresentation {
  const agentDisplay = resolveCurrentAgentDisplay({
    sessionAgentId: session.agent_id,
    selectedAgent: context.selectedAgent,
    agentCache: context.agentCache,
  })

  const spaceId = sourceSpaceId ?? session.space_id ?? session.workspace_id ?? null
  const workspaceName = spaceId ? context.spaceNameById[spaceId] : undefined

  const statusMeta = SHARE_PICKER_STATUS_LABELS[session.status]
  const statusLabel = statusMeta
    ? t(statusMeta.key, { defaultValue: statusMeta.defaultValue })
    : null

  const metaParts: string[] = []
  if (agentDisplay?.displayName) metaParts.push(agentDisplay.displayName)
  if (context.showWorkspaceSource && workspaceName) metaParts.push(workspaceName)
  if (statusLabel && session.status !== 'active') metaParts.push(statusLabel)

  const tracker = session.tracker_run
  const trackerLabel = tracker
    ? t('sessionSharePicker.trackerRun', {
      name: tracker.tracker_name,
      index: tracker.run_index,
      defaultValue: `定时 · ${tracker.tracker_name} #${tracker.run_index}`,
    })
    : null

  return {
    title: resolveSharePickerSessionTitle(session, t),
    meta: metaParts.length > 0 ? metaParts.join(' · ') : null,
    preview: resolveSharePickerPreview(session, t),
    activityTs: getSessionActivityTs(session),
    trackerLabel,
  }
}

export function matchesSharePickerSearch(
  session: ChatSession,
  query: string,
  context: SharePickerSessionContext,
  sourceSpaceId?: string | null,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const presentation = buildSharePickerSessionPresentation(
    session,
    context,
    (key, opts) => {
      const dv = opts?.defaultValue
      return typeof dv === 'string' ? dv : key
    },
    sourceSpaceId,
  )

  const haystack = [
    presentation.title,
    presentation.meta,
    presentation.preview,
    presentation.trackerLabel,
    session.last_message_preview,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return haystack.includes(q)
}

export type SharePickerScopeKey = 'recent' | string

export function mergeSharePickerSessions(
  personalSpaceIds: string[],
  sessionsBySpaceId: Record<string, ChatSession[] | undefined>,
): SharePickerSessionEntry[] {
  const seen = new Set<string>()
  const merged: SharePickerSessionEntry[] = []
  for (const spaceId of personalSpaceIds) {
    for (const session of sessionsBySpaceId[spaceId] ?? []) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      merged.push({ session, sourceSpaceId: spaceId })
    }
  }
  return merged
}

export function filterSharePickerSessionsByScope(
  entries: SharePickerSessionEntry[],
  scopeKey: SharePickerScopeKey,
): SharePickerSessionEntry[] {
  if (scopeKey === 'recent') return entries
  return entries.filter((entry) => entry.sourceSpaceId === scopeKey)
}

export interface SharePickerNavItem {
  key: SharePickerScopeKey
  label: string
  count: number
}

export function buildSharePickerNavItems(
  personalSpaces: Array<{ id: string; name: string }>,
  entries: SharePickerSessionEntry[],
  t: TranslateFn,
): SharePickerNavItem[] {
  const bySpace = new Map<string, number>()
  for (const entry of entries) {
    bySpace.set(entry.sourceSpaceId, (bySpace.get(entry.sourceSpaceId) ?? 0) + 1)
  }

  const recentItem: SharePickerNavItem = {
    key: 'recent',
    label: t('sessionSharePicker.scopeRecent', { defaultValue: '最近' }),
    count: entries.length,
  }

  const workspaceItems = [...personalSpaces]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map((space) => ({
      key: space.id,
      label: space.name,
      count: bySpace.get(space.id) ?? 0,
    }))

  return [recentItem, ...workspaceItems]
}

export interface SharePickerSessionGroup {
  spaceId: string | null
  spaceName: string | null
  sessions: ChatSession[]
}

export function groupSharePickerSessions(
  entries: SharePickerSessionEntry[],
  spaceNameById: Record<string, string>,
): SharePickerSessionGroup[] {
  if (entries.length === 0) return []

  const spaceIds = new Set(entries.map((entry) => entry.sourceSpaceId))
  if (spaceIds.size <= 1) {
    return [{
      spaceId: [...spaceIds][0] ?? null,
      spaceName: null,
      sessions: entries.map((entry) => entry.session),
    }]
  }

  const bySpace = new Map<string, ChatSession[]>()
  for (const entry of entries) {
    const bucket = bySpace.get(entry.sourceSpaceId)
    if (bucket) bucket.push(entry.session)
    else bySpace.set(entry.sourceSpaceId, [entry.session])
  }

  return [...bySpace.entries()]
    .map(([spaceId, sessions]) => ({
      spaceId,
      spaceName: spaceNameById[spaceId] ?? null,
      sessions,
    }))
    .sort((a, b) => (a.spaceName ?? '').localeCompare(b.spaceName ?? '', 'zh-CN'))
}

export function sortSharePickerEntriesByActivity(
  entries: SharePickerSessionEntry[],
): SharePickerSessionEntry[] {
  return [...entries].sort(
    (a, b) => getSessionActivityTs(b.session) - getSessionActivityTs(a.session),
  )
}
