/** TabTin 自定义 IM 卡片的类型与能力单一入口。 */

export const TABTIN_CUSTOM_CARD_TYPES = [
  'space',
  'agent_space',
  'table',
  'document',
  'contact',
  'handoff',
  'prompt',
  'session_share',
  'session_share_v2',
  'session_continuation',
  'codex_session',
] as const

export type TabTinCustomCardType = typeof TABTIN_CUSTOM_CARD_TYPES[number]
export type TabTinResourceCardType = Extract<TabTinCustomCardType, 'table' | 'document'>

/** IM 消息中的原始卡片负载；未知字段保留，供新旧客户端向前兼容。 */
export interface TabTinCustomCardPayload {
  type: string
  space_id?: string
  name?: string
  icon?: string
  resource_id?: string
  organization_id?: string
  hint_carrier_app_id?: string
  description?: string
  caption?: string
  preview_table?: {
    columns?: Array<{ key?: string; label?: string }>
    rows?: Array<Record<string, string>>
    total_rows?: number
  }
  image_url?: string
  thumbnail_url?: string
  user_id?: string
  username?: string
  avatar?: string
  handoff_id?: string
  goal?: string
  initiator_type?: 'user' | 'agent'
  initiator_id?: string
  recipient_count?: number
  prompt_text?: string
  prompt_version?: number
  title?: string
  share_id?: string
  session_id?: string
  session_title?: string
  can_fork?: boolean
  can_chat?: boolean
  status?: string
  schema_version?: number
  version?: number
  object_id?: string
  title_snapshot?: string
  sender_id?: string
  recipient_id?: string
  codex_session_id?: string
  codex_session_name?: string
  suggested_working_directory?: string
  [key: string]: unknown
}

export type TabTinSpaceCard = TabTinCustomCardPayload & {
  type: 'space' | 'agent_space'
}

export type TabTinResourceCard = TabTinCustomCardPayload & {
  type: TabTinResourceCardType
}

export type TabTinContactCard = TabTinCustomCardPayload & {
  type: 'contact'
  user_id: string
}

export type TabTinHandoffCard = TabTinCustomCardPayload & {
  type: 'handoff'
  handoff_id: string
}

export type TabTinPromptCard = TabTinCustomCardPayload & {
  type: 'prompt'
  prompt_text: string
}

export type TabTinSessionShareCard = TabTinCustomCardPayload & {
  type: 'session_share'
  share_id: string
}

export type TabTinSharedTaskCard = TabTinCustomCardPayload & {
  schema_version: 1
  version: number
  type: 'session_share_v2' | 'session_continuation'
  object_id: string
  title_snapshot: string
  sender_id: string
  recipient_id: string
}

export type TabTinSessionShareV2Card = TabTinSharedTaskCard & {
  type: 'session_share_v2'
}

export type TabTinSessionContinuationCard = TabTinSharedTaskCard & {
  type: 'session_continuation'
}

export type TabTinCodexSessionCard = TabTinCustomCardPayload & {
  type: 'codex_session'
  schema_version: 1
  codex_session_id: string
  codex_session_name: string
}

export type SupportedTabTinCustomCard =
  | TabTinSpaceCard
  | TabTinResourceCard
  | TabTinContactCard
  | TabTinHandoffCard
  | TabTinPromptCard
  | TabTinSessionShareCard
  | TabTinSessionShareV2Card
  | TabTinSessionContinuationCard
  | TabTinCodexSessionCard

type AssertNever<T extends never> = T

/** @internal 注册类型与可渲染契约必须完全相等，缺任一侧都让 TypeScript 失败。 */
export type TabTinCustomCardRouteCoverage = AssertNever<
  | Exclude<TabTinCustomCardType, SupportedTabTinCustomCard['type']>
  | Exclude<SupportedTabTinCustomCard['type'], TabTinCustomCardType>
>

export type TabTinCustomCardResolution =
  | { kind: 'supported'; card: SupportedTabTinCustomCard }
  | { kind: 'invalid'; type: TabTinCustomCardType }
  | { kind: 'unsupported'; type: string }

const KNOWN_TYPES = new Set<string>(TABTIN_CUSTOM_CARD_TYPES)
const NON_FORWARDABLE_TYPES = new Set<TabTinCustomCardType>([
  'handoff',
  'session_share',
  'session_share_v2',
  'session_continuation',
])
const SYSTEM_MANAGED_CARD_TYPES = new Set<TabTinCustomCardType>([
  'session_share',
  'session_share_v2',
  'session_continuation',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasString(card: Record<string, unknown>, key: string): boolean {
  return typeof card[key] === 'string' && Boolean(card[key])
}

function isSharedTaskCard(card: Record<string, unknown>): boolean {
  return card.schema_version === 1
    && typeof card.version === 'number'
    && Number.isSafeInteger(card.version)
    && card.version >= 1
    && hasString(card, 'object_id')
    && hasString(card, 'title_snapshot')
    && hasString(card, 'sender_id')
    && hasString(card, 'recipient_id')
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TabTin custom card contract: ${String(value)}`)
}

export function isTabTinCustomCardType(value: unknown): value is TabTinCustomCardType {
  return typeof value === 'string' && KNOWN_TYPES.has(value)
}

/**
 * 将传输负载归一成可渲染卡片；未知类型必须保留给旧客户端的升级兜底。
 * space/resource 暂时沿用旧行为，允许空 ID 交给现有卡片展示层处理。
 */
export function parseTabTinCustomCard(raw: unknown): TabTinCustomCardResolution | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !raw.type) return null
  if (!isTabTinCustomCardType(raw.type)) return { kind: 'unsupported', type: raw.type }

  const card = raw as TabTinCustomCardPayload
  switch (raw.type) {
    case 'space':
    case 'agent_space':
      return { kind: 'supported', card: card as TabTinSpaceCard }
    case 'table':
    case 'document':
      return { kind: 'supported', card: card as TabTinResourceCard }
    case 'contact':
      return hasString(raw, 'user_id')
        ? { kind: 'supported', card: card as TabTinContactCard }
        : { kind: 'invalid', type: raw.type }
    case 'handoff':
      return hasString(raw, 'handoff_id')
        ? { kind: 'supported', card: card as TabTinHandoffCard }
        : { kind: 'invalid', type: raw.type }
    case 'prompt':
      return hasString(raw, 'prompt_text')
        ? { kind: 'supported', card: card as TabTinPromptCard }
        : { kind: 'invalid', type: raw.type }
    case 'session_share':
      return hasString(raw, 'share_id')
        ? { kind: 'supported', card: card as TabTinSessionShareCard }
        : { kind: 'invalid', type: raw.type }
    case 'session_share_v2':
      if (typeof raw.schema_version === 'number' && raw.schema_version !== 1) {
        return { kind: 'unsupported', type: raw.type }
      }
      return isSharedTaskCard(raw)
        ? { kind: 'supported', card: card as TabTinSessionShareV2Card }
        : { kind: 'invalid', type: raw.type }
    case 'session_continuation':
      if (typeof raw.schema_version === 'number' && raw.schema_version !== 1) {
        return { kind: 'unsupported', type: raw.type }
      }
      return isSharedTaskCard(raw)
        ? { kind: 'supported', card: card as TabTinSessionContinuationCard }
        : { kind: 'invalid', type: raw.type }
    case 'codex_session':
      if (typeof raw.schema_version === 'number' && raw.schema_version !== 1) {
        return { kind: 'unsupported', type: raw.type }
      }
      return raw.schema_version === 1
        && hasString(raw, 'codex_session_id')
        && hasString(raw, 'codex_session_name')
        ? { kind: 'supported', card: card as TabTinCodexSessionCard }
        : { kind: 'invalid', type: raw.type }
    default:
      return assertNever(raw.type)
  }
}

/** 声明了卡片契约即使用独立布局；未知类型由升级兜底承接。 */
export function isTabTinCustomCardContent(raw: unknown): boolean {
  return isRecord(raw) && typeof raw.type === 'string' && Boolean(raw.type)
}

/** 会话级授权或冻结上下文不能经转发扩散。 */
export function canForwardTabTinCustomCard(raw: unknown): boolean {
  if (!isRecord(raw) || !isTabTinCustomCardType(raw.type)) return true
  return !NON_FORWARDABLE_TYPES.has(raw.type)
}

/** 这些卡片的消息修改来自系统状态投影，不是用户编辑。 */
export function isSystemManagedTabTinCard(raw: unknown): boolean {
  return isRecord(raw)
    && isTabTinCustomCardType(raw.type)
    && SYSTEM_MANAGED_CARD_TYPES.has(raw.type)
}
