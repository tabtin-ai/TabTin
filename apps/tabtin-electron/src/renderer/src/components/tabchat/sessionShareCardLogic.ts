/**
 * sessionShareCardLogic — 任务共享卡「角色 / 状态 → 视图模型」纯函数。
 *
 * 与 SessionShareCard 渲染解耦，便于 vitest 直接断言：
 * - 角色：当前用户 vs share 的 owner / grantee（都不是则为 observer，
 *   例如转发预览或成员变更后的旧卡）。
 * - 状态：详情请求成功后以服务端详情为准；快照仅作详情未到时的骨架/乐观兜底
 *   （WS 先改快照时由 SessionShareCard 乐观写回 detail）。都缺时按 active。
 * - 动作：owner / grantee + active →「打开任务」；owner + active →「停止共享」；
 *   owner + revoked →「恢复共享」；grantee + revoked → 置灰「共享已停止」。
 */

export type SessionShareRole = 'owner' | 'grantee' | 'observer'

export type SessionShareCardStatus = 'pending' | 'active' | 'revoked'

export interface SessionShareCardViewInput {
  currentUserId?: string | null
  ownerUserId?: string | null
  granteeUserId?: string | null
  status?: string | null
  canFork?: boolean
  canChat?: boolean
}

export interface SessionShareCardView {
  role: SessionShareRole
  status: SessionShareCardStatus
  /** owner / grantee 且 active：显示「打开任务」主按钮 */
  showOpen: boolean
  /** owner 且 active：显示「停止共享」按钮（带二次确认） */
  showRevoke: boolean
  /** owner 且 revoked：显示「恢复共享」（复用 POST /im/session-shares 重激活） */
  showResume: boolean
  /** grantee + revoked：按钮区显示置灰「共享已停止」 */
  showRevokedNote: boolean
  /** 权限徽标：「可查看」恒有；canFork 追加「可 fork」；canChat 追加「可控制」 */
  badges: { viewable: true; forkable: boolean; chattable: boolean }
}

export function resolveSessionShareRole(
  currentUserId: string | null | undefined,
  ownerUserId: string | null | undefined,
  granteeUserId: string | null | undefined,
): SessionShareRole {
  if (!currentUserId) return 'observer'
  if (ownerUserId && currentUserId === ownerUserId) return 'owner'
  if (granteeUserId && currentUserId === granteeUserId) return 'grantee'
  return 'observer'
}

export function normalizeSessionShareStatus(
  status: string | null | undefined,
): SessionShareCardStatus {
  if (status === 'pending') return 'pending'
  return status === 'revoked' ? 'revoked' : 'active'
}

/**
 * 权限徽标描述的是这张卡自己的共享档位，因此优先使用卡片快照。
 * 新数据中每张卡都有独立授权，快照与详情应一致；仅历史消息没有快照
 * 字段时，才回退到共享详情以兼容旧数据。
 */
export function resolveSessionShareCardCapabilities(
  detailCanFork?: boolean,
  detailCanChat?: boolean,
  canForkSnapshot?: boolean,
  canChatSnapshot?: boolean,
): { canFork: boolean; canChat: boolean } {
  return {
    canFork: canForkSnapshot ?? detailCanFork ?? false,
    canChat: canChatSnapshot ?? detailCanChat ?? false,
  }
}

/**
 * 合并详情 status 与消息 metadata.card.status。
 *
 * IM 列表快照可能仍是 active，但
 * getSessionShare 已返回 revoked。永久以快照会错误开放「打开任务」（审阅
 * ）。详情已到 → 以服务端为准；快照仅在详情未到时兜底。WS 先到时由
 * 卡片侧把快照乐观写进 detail，再走本函数。
 */
export function resolveSessionShareCardStatus(
  detailStatus?: string | null,
  statusSnapshot?: string | null,
): SessionShareCardStatus {
  if (detailStatus != null && detailStatus !== '') {
    return normalizeSessionShareStatus(detailStatus)
  }
  if (statusSnapshot != null && statusSnapshot !== '') {
    return normalizeSessionShareStatus(statusSnapshot)
  }
  return 'active'
}

export function buildSessionShareCardView(
  input: SessionShareCardViewInput,
): SessionShareCardView {
  const role = resolveSessionShareRole(
    input.currentUserId,
    input.ownerUserId,
    input.granteeUserId,
  )
  const status = normalizeSessionShareStatus(input.status)
  const active = status === 'active'
  const revoked = status === 'revoked'
  return {
    role,
    status,
    showOpen: active && (role === 'owner' || role === 'grantee'),
    showRevoke: active && role === 'owner',
    showResume: revoked && role === 'owner',
    showRevokedNote: revoked && role === 'grantee',
    badges: {
      viewable: true,
      forkable: Boolean(input.canFork),
      chattable: Boolean(input.canChat),
    },
  }
}
