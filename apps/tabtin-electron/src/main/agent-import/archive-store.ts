/**
 * 外部 Agent 导入 · 本机档案存储（仅 Electron userData）。
 *
 * 布局：
 *   {userData}/external-archives/{organizationId}/index.json
 *   {userData}/external-archives/{organizationId}/{source}/{sourceSessionId}/meta.json
 *   {userData}/external-archives/{organizationId}/{source}/{sourceSessionId}/messages.json
 *
 * 一次性：同源会话目录已存在则拒绝再写。重来 = 用户删 Workspace / 删档案后再导。
 *
 * 安全：organizationId / source 必须是单层安全键（禁 ../、分隔符）；落盘路径
 * 必须仍在 archivesRoot 之下（ 阻塞项 2）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { IMPORT_SOURCE_IDS, type ImportSourceId } from '@tabtin/cli-server-core'

export interface ArchiveMessage {
  id: string
  role: 'user' | 'assistant'
  content_blocks: unknown[]
  created_at: string
  model_name?: string | null
}

export interface ArchiveMeta {
  source: ImportSourceId
  sourceSessionId: string
  title: string
  cwd: string | null
  workspaceId: string | null
  workspaceName: string | null
  deviceId: string
  organizationId: string
  importedAt: string
  layer: string
  messageCount: number
  archived: boolean
  /** 特化展示标记——渲染层据此走外来气泡，不进普通会话列表。 */
  kind: 'external_archive'
  /**
   * 首次「展开为特殊新对话」后绑定的 TabTin ChatSession id。
   * 再次点击同一档案应回到该会话，禁止每次新建。
   */
  openedSessionId?: string | null
}

export interface ArchiveIndexEntry {
  source: ImportSourceId
  sourceSessionId: string
  title: string
  cwd: string | null
  workspaceId: string | null
  importedAt: string
  messageCount: number
  openedSessionId?: string | null
}

/** 组织 id：单层安全键（UUID / slug），禁止路径段与遍历。 */
const SAFE_ORG_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const IMPORT_SOURCE_SET = new Set<string>(IMPORT_SOURCE_IDS)

function archivesRoot(): string {
  return path.join(app.getPath('userData'), 'external-archives')
}

/** @internal 导出供单测；非法键返回 null（读路径软失败），不抛。 */
export function trySafeOrganizationId(organizationId: string): string | null {
  if (!organizationId || typeof organizationId !== 'string') return null
  if (!SAFE_ORG_ID_RE.test(organizationId)) return null
  const root = path.resolve(archivesRoot())
  const resolved = path.resolve(root, organizationId)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return organizationId
}

/** @internal 导出供单测；非法 source 返回 null。 */
export function trySafeImportSource(source: string): ImportSourceId | null {
  if (!source || typeof source !== 'string') return null
  if (!IMPORT_SOURCE_SET.has(source)) return null
  return source as ImportSourceId
}

function requireSafeOrganizationId(organizationId: string): string {
  const safe = trySafeOrganizationId(organizationId)
  if (!safe) {
    throw new Error(`非法 organizationId（须为单层安全键）: ${String(organizationId)}`)
  }
  return safe
}

function requireSafeImportSource(source: string): ImportSourceId {
  const safe = trySafeImportSource(source)
  if (!safe) {
    throw new Error(`非法 import source: ${String(source)}`)
  }
  return safe
}

function orgDir(organizationId: string): string {
  return path.join(archivesRoot(), requireSafeOrganizationId(organizationId))
}

/** 档案目录绝对路径（含 attachments/ 等子目录的父级）。非法键抛错。 */
export function resolveArchiveDir(
  organizationId: string,
  source: string,
  sourceSessionId: string,
): string {
  return archiveDir(organizationId, source, sourceSessionId)
}

function archiveDir(
  organizationId: string,
  source: string,
  sourceSessionId: string,
): string {
  const safeOrg = requireSafeOrganizationId(organizationId)
  const safeSource = requireSafeImportSource(source)
  // sourceSessionId 可能含路径不安全字符，压成单层文件名。
  const safeId = sourceSessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180)
  if (!safeId) {
    throw new Error('非法 sourceSessionId')
  }
  const dir = path.join(archivesRoot(), safeOrg, safeSource, safeId)
  const root = path.resolve(archivesRoot())
  const resolved = path.resolve(dir)
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('档案路径越出 external-archives 根目录')
  }
  return dir
}

function indexPath(organizationId: string): string {
  return path.join(orgDir(organizationId), 'index.json')
}

export function archiveExists(
  organizationId: string,
  source: string,
  sourceSessionId: string,
): boolean {
  if (!trySafeOrganizationId(organizationId) || !trySafeImportSource(source)) return false
  try {
    return fs.existsSync(path.join(archiveDir(organizationId, source, sourceSessionId), 'meta.json'))
  } catch {
    return false
  }
}

export function readIndex(organizationId: string): ArchiveIndexEntry[] {
  const safe = trySafeOrganizationId(organizationId)
  if (!safe) return []
  const p = indexPath(safe)
  if (!fs.existsSync(p)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as ArchiveIndexEntry[]) : []
  } catch {
    return []
  }
}

function writeIndex(organizationId: string, entries: ArchiveIndexEntry[]): void {
  const dir = orgDir(organizationId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(indexPath(organizationId), JSON.stringify(entries, null, 2), 'utf8')
}

export function writeArchive(args: {
  meta: ArchiveMeta
  messages: ArchiveMessage[]
}): void {
  const { meta, messages } = args
  requireSafeOrganizationId(meta.organizationId)
  requireSafeImportSource(meta.source)
  if (archiveExists(meta.organizationId, meta.source, meta.sourceSessionId)) {
    throw new Error(
      `导入会话已存在（一次性）：${meta.source}:${meta.sourceSessionId}。请删除对应 Workspace 或本机档案后重试。`,
    )
  }
  const dir = archiveDir(meta.organizationId, meta.source, meta.sourceSessionId)
  fs.mkdirSync(dir, { recursive: true })
  const fullMeta: ArchiveMeta = {
    ...meta,
    kind: 'external_archive',
    messageCount: messages.length,
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(fullMeta, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(messages, null, 2), 'utf8')

  const index = readIndex(meta.organizationId).filter(
    (e) => !(e.source === meta.source && e.sourceSessionId === meta.sourceSessionId),
  )
  index.unshift({
    source: meta.source,
    sourceSessionId: meta.sourceSessionId,
    title: meta.title,
    cwd: meta.cwd,
    workspaceId: meta.workspaceId,
    importedAt: meta.importedAt,
    messageCount: messages.length,
    openedSessionId: meta.openedSessionId ?? null,
  })
  writeIndex(meta.organizationId, index)
}

/** 绑定「已展开」的真会话；再次打开档案时复用，避免侧栏堆同名会话。 */
export function bindOpenedSession(args: {
  organizationId: string
  source: string
  sourceSessionId: string
  sessionId: string
}): boolean {
  const { organizationId, source, sourceSessionId, sessionId } = args
  if (!sessionId) return false
  if (!trySafeOrganizationId(organizationId) || !trySafeImportSource(source)) return false
  const existing = readArchive(organizationId, source, sourceSessionId)
  if (!existing) return false
  const nextMeta: ArchiveMeta = {
    ...existing.meta,
    openedSessionId: sessionId,
  }
  const dir = archiveDir(organizationId, source, sourceSessionId)
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(nextMeta, null, 2), 'utf8')
  const index = readIndex(organizationId).map((e) =>
    e.source === source && e.sourceSessionId === sourceSessionId
      ? { ...e, openedSessionId: sessionId }
      : e,
  )
  writeIndex(organizationId, index)
  return true
}

/** 按已绑定的 ChatSession id 找回本机导入档案。 */
export function findArchiveByOpenedSessionId(
  organizationId: string,
  sessionId: string,
): { meta: ArchiveMeta; messages: ArchiveMessage[] } | null {
  const openedSessionId = sessionId.trim()
  if (!openedSessionId || !trySafeOrganizationId(organizationId)) return null
  const chatSessionPrefix = 'chat-session-'
  const candidates = new Set([openedSessionId])
  if (openedSessionId.startsWith(chatSessionPrefix)) {
    candidates.add(openedSessionId.slice(chatSessionPrefix.length))
  } else {
    candidates.add(`${chatSessionPrefix}${openedSessionId}`)
  }
  const entry = readIndex(organizationId).find(
    (item) => item.openedSessionId != null && candidates.has(item.openedSessionId),
  )
  if (!entry) return null
  return readArchive(organizationId, entry.source, entry.sourceSessionId)
}

export function readArchive(
  organizationId: string,
  source: string,
  sourceSessionId: string,
): { meta: ArchiveMeta; messages: ArchiveMessage[] } | null {
  if (!trySafeOrganizationId(organizationId) || !trySafeImportSource(source)) return null
  let dir: string
  try {
    dir = archiveDir(organizationId, source, sourceSessionId)
  } catch {
    return null
  }
  const metaPath = path.join(dir, 'meta.json')
  const msgPath = path.join(dir, 'messages.json')
  if (!fs.existsSync(metaPath) || !fs.existsSync(msgPath)) return null
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ArchiveMeta
    const messages = JSON.parse(fs.readFileSync(msgPath, 'utf8')) as ArchiveMessage[]
    return { meta, messages }
  } catch {
    return null
  }
}

function normalizeArchiveDir(dir: string): string {
  return dir.replace(/[/\\]+$/, '').toLowerCase()
}

/**
 * 按条件删除本机档案（rollback / 删 Workspace / 用户清空）。
 *
 * - `sourceSessionIds`：精确会话（可配 source）
 * - `workspaceId` / `cwd`：任一命中即删（OR）。删 Workspace 时两者都传，
 *   可清掉「旧 workspaceId + 同目录」的残留档案，避免重导报「会话已导入过」。
 * - 仅 `source`：该来源下全部
 */
export function deleteArchives(args: {
  organizationId: string
  source?: string
  sourceSessionIds?: string[]
  workspaceId?: string
  /** 工作目录；与 index/meta.cwd 规范化后比较 */
  cwd?: string | null
}): { deleted: number } {
  const { organizationId, source, sourceSessionIds, workspaceId, cwd } = args
  if (!trySafeOrganizationId(organizationId)) return { deleted: 0 }
  if (source && !trySafeImportSource(source)) return { deleted: 0 }
  let index = readIndex(organizationId)
  const before = index.length
  const cwdKey = cwd?.trim() ? normalizeArchiveDir(cwd.trim()) : null
  const victims = index.filter((e) => {
    if (sourceSessionIds?.length) {
      return sourceSessionIds.includes(e.sourceSessionId) && (!source || e.source === source)
    }
    if (workspaceId || cwdKey) {
      const byWs = Boolean(workspaceId && e.workspaceId === workspaceId)
      const byCwd = Boolean(
        cwdKey && e.cwd?.trim() && normalizeArchiveDir(e.cwd.trim()) === cwdKey,
      )
      return byWs || byCwd
    }
    if (source) return e.source === source
    return false
  })
  for (const v of victims) {
    try {
      const dir = archiveDir(organizationId, v.source, v.sourceSessionId)
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 单条删失败不阻断其余 */
    }
  }
  const victimKeys = new Set(victims.map((v) => `${v.source}:${v.sourceSessionId}`))
  index = index.filter((e) => !victimKeys.has(`${e.source}:${e.sourceSessionId}`))
  writeIndex(organizationId, index)
  return { deleted: before - index.length }
}
