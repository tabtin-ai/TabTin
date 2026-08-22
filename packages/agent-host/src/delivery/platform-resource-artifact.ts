/**
 * 平台云端资源交付物 —— 从 `tabtin table create` / `tabtin doc create` 成功
 * stdout 解析并发布 `resource_ref` 卡片（artifact_kind: platform_resource）。
 *
 * 定位：与 `oss-file-artifact` 同级，挂在 host
 * `terminal-artifact-hook` afterToolResult——**不进 agent-runtime**。
 * 流内出卡 + 前端「本轮产物」聚合（`isPresentationOnlyRichBlock` 对
 * platform_resource 豁免，仍排除 present_to_user）。
 */

import { splitShellCommandSegments } from './shell-command-segments.js'

export const PLATFORM_RESOURCE_ARTIFACT_KIND = 'platform_resource' as const

export type PlatformResourceType = 'table' | 'document'

export interface ParsedPlatformResourceCreate {
  resourceType: PlatformResourceType
  resourceId: string
  title: string
  /** 资源实际归属的执行 Workspace；Project 会话不能替代它。 */
  resourceSpaceId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 是否为 `tabtin table create` / `tabtin doc create`（允许 `cd ... &&` / env 前缀）。 */
export function isPlatformResourceCreateCommand(
  command: string,
  kind: PlatformResourceType,
): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  const want = kind === 'table' ? ['tabtin', 'table', 'create'] : ['tabtin', 'doc', 'create']
  const segments = splitShellCommandSegments(command)
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter((t) => t.length > 0)
    let i = 0
    while (
      i < tokens.length
      && (/^[A-Z_][A-Z0-9_]*=/.test(tokens[i]!) || tokens[i] === 'sudo' || tokens[i] === 'exec')
    ) {
      i++
    }
    if (tokens[i] === 'cd') continue
    if (
      tokens[i] === want[0]
      && tokens[i + 1] === want[1]
      && tokens[i + 2] === want[2]
    ) {
      return true
    }
  }
  return false
}

function tryExtractJsonObject(stdout: string): unknown | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Go CLI 默认 agent 文本：`data: {...}\nok: true` */
function parseAgentTextDataLine(stdout: string): unknown | null {
  if (/^ok:\s*false\s*$/m.test(stdout)) return null
  const match = /^data:\s*(\{.*\})\s*$/m.exec(stdout)
  if (!match?.[1]) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function readCreateFields(
  root: Record<string, unknown>,
  kind: PlatformResourceType,
): ParsedPlatformResourceCreate | null {
  const data = isRecord(root.data) ? root.data : root
  const error = isRecord(root.error) ? root.error : null
  const detail = (error && isRecord(error.detail) ? error.detail : null)
    ?? (isRecord(root.detail) ? root.detail : null)
    ?? (isRecord(data.detail) ? data.detail : null)

  if (kind === 'table') {
    const table = (isRecord(data.table) ? data.table : null)
      ?? (isRecord(root.table) ? root.table : null)
      ?? (detail && isRecord(detail.table) ? detail.table : null)
    const resourceId = normalizeOptionalText(table?.id)
      ?? normalizeOptionalText(data.table_id)
      ?? normalizeOptionalText(root.table_id)
      ?? (detail ? normalizeOptionalText(detail.table_id) : undefined)
      ?? normalizeOptionalText(data.id)
    if (!resourceId) return null
    const title = normalizeOptionalText(table?.name)
      ?? normalizeOptionalText(table?.title)
      ?? normalizeOptionalText(data.name)
      ?? normalizeOptionalText(data.title)
      ?? resourceId
    const resourceSpaceId = normalizeOptionalText(table?.space_id)
      ?? normalizeOptionalText(data.space_id)
      ?? normalizeOptionalText(root.space_id)
      ?? (detail ? normalizeOptionalText(detail.space_id) : undefined)
    return { resourceType: 'table', resourceId, title, ...(resourceSpaceId ? { resourceSpaceId } : {}) }
  }

  const document = (isRecord(data.document) ? data.document : null)
    ?? (isRecord(root.document) ? root.document : null)
    ?? (detail && isRecord(detail.document) ? detail.document : null)
  const resourceId = normalizeOptionalText(document?.id)
    ?? normalizeOptionalText(data.document_id)
    ?? normalizeOptionalText(root.document_id)
    ?? (detail ? normalizeOptionalText(detail.document_id) : undefined)
    ?? normalizeOptionalText(data.id)
  if (!resourceId) return null
  const title = normalizeOptionalText(document?.title)
    ?? normalizeOptionalText(document?.name)
    ?? normalizeOptionalText(data.title)
    ?? normalizeOptionalText(data.name)
    ?? resourceId
  const resourceSpaceId = normalizeOptionalText(document?.space_id)
    ?? normalizeOptionalText(data.space_id)
    ?? normalizeOptionalText(root.space_id)
    ?? (detail ? normalizeOptionalText(detail.space_id) : undefined)
  return { resourceType: 'document', resourceId, title, ...(resourceSpaceId ? { resourceSpaceId } : {}) }
}

/** 从 command + stdout 解析 table/doc create 交付字段（成功或 207 partial）。 */
export function parsePlatformResourceCreateResult(
  command: string,
  stdout: string,
): ParsedPlatformResourceCreate | null {
  if (typeof stdout !== 'string' || !stdout.trim()) return null

  const kind: PlatformResourceType | null = isPlatformResourceCreateCommand(command, 'table')
    ? 'table'
    : isPlatformResourceCreateCommand(command, 'document')
      ? 'document'
      : null
  if (!kind) return null

  let root: unknown = tryExtractJsonObject(stdout)
  if (!isRecord(root)) {
    root = parseAgentTextDataLine(stdout)
  }
  if (!isRecord(root)) return null
  return readCreateFields(root, kind)
}

export function buildPlatformResourceArtifactBlock(args: {
  resourceType: PlatformResourceType
  resourceId: string
  title: string
  resourceSpaceId?: string
  summary?: string
}): { kind: 'resource_ref'; summary: string; payload: Record<string, unknown> } {
  const title = normalizeOptionalText(args.title) || args.resourceId
  const summary = normalizeOptionalText(args.summary) || title
  const hint = args.resourceType === 'table' ? 'tabdata' : 'tabdoc'
  const pathType = args.resourceType === 'table' ? 'table' : 'document'
  const params = new URLSearchParams({ hint, title })
  const url = `tabtin://resource/${pathType}/${encodeURIComponent(args.resourceId)}?${params.toString()}`

  return {
    kind: 'resource_ref',
    summary,
    payload: {
      artifact_kind: PLATFORM_RESOURCE_ARTIFACT_KIND,
      resource_type: args.resourceType === 'table' ? 'table' : 'document',
      resource_id: args.resourceId,
      resource_name: title,
      hint_carrier_app_id: hint,
      url,
      ...(args.resourceSpaceId ? { space_id: args.resourceSpaceId } : {}),
    },
  }
}

/** 从 command + stdout 构建可 emit 的 block；失败返回 null。 */
export function buildPlatformResourceArtifactBlockFromCreate(
  command: string,
  stdout: string,
): { kind: 'resource_ref'; summary: string; payload: Record<string, unknown> } | null {
  const parsed = parsePlatformResourceCreateResult(command, stdout)
  if (!parsed) return null
  return buildPlatformResourceArtifactBlock(parsed)
}
