/**
 * 组织详情「审计与运营记录」展示与聚合：
 * - 来源 / 动作 / 权限中文标签
 * - 三源（敏感操作 / 组织审计 / 计费审计）行聚合与筛选
 * - CSV 导出
 */

import type { AdminSensitiveActionItem } from '@/api/admin-audit'
import type { AuditLogItem } from '@/billing-management/api/billing-admin'
import type { AdminActionLogItem } from '@/types/space-admin'

export type OrganizationAuditSource = 'sensitive' | 'organization' | 'billing'

export type OrganizationAuditRow = {
  id: string
  source: OrganizationAuditSource
  action: string
  operator: string
  permission_code: string
  reason: string
  ticket_id: string
  created_at: string
  before_json?: unknown
  after_json?: unknown
}

export const AUDIT_SOURCE_LABELS: Record<OrganizationAuditSource, string> = {
  sensitive: '敏感操作',
  organization: '组织审计',
  billing: '计费审计',
}

export const AUDIT_SOURCE_OPTIONS: Array<{
  value: OrganizationAuditSource
  label: string
}> = (
  Object.entries(AUDIT_SOURCE_LABELS) as Array<[OrganizationAuditSource, string]>
).map(([value, label]) => ({ value, label }))

/** 动作码 → 中文（含 . / : / _ 变体，lookup 时会归一化） */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  anomaly_alert_resolve: '消警',
  organization_cash_purchase_addon_package: '现金购买扩容包',
  organization_cash_purchase_credit_package: '现金购买点券包',
  organization_cash_wallet_recharge: '人民币钱包充值',
  organization_wallet_recharge: '点券钱包充值',
  organization_wallet_adjust: '点券钱包调整',
  organization_create: '创建组织',
  organization_update: '更新组织',
  organization_delete: '删除组织',
  organization_transfer_ownership: '转让 Owner',
  organization_control_policy_update: '更新组织强控',
  organization_quota_grant: '发放扩容权益',
  credit_ledger_deduct: '点券扣减',
  credit_ledger_grant: '点券发放',
  credit_ledger_reverse: '点券冲正',
  credit_ledger_compensate: '点券补偿',
  credit_ledger_manual_adjust: '点券人工调整',
  credit_ledger_adjust: '点券人工调整',
  'credit_ledger.manual_adjust': '点券人工调整',
  'credit:deduct': '点券扣减',
  'credit:grant': '点券发放',
  'credit:reverse': '点券冲正',
  'credit:adjust': '点券调整',
  wallet_adjust: '钱包调整',
  pricing_create: '创建定价',
  pricing_update: '更新定价',
  pricing_delete: '删除定价',
  budget_create: '创建预算',
  budget_update: '更新预算',
  budget_delete: '删除预算',
  membership_update: '更新会员',
  membership_auto_renew_disable: '关闭自动续费',
  space_create: '创建 Space',
  space_update: '更新 Space',
  space_archive: '归档 Space',
  space_restore: '恢复 Space',
  space_delete: '删除 Space',
  space_trash: 'Space 移入回收站',
  resource_delete: '删除资源',
  resource_restore: '恢复资源',
  'trash.organization.empty': '清空组织回收站',
  'trash.resource.delete': '永久删除资源',
  'trash.resource.move': '资源移入回收站',
  'trash.resource.restore': '恢复回收站资源',
  'trash.space.delete': '永久删除 Space',
  'trash.space.restore': '恢复 Space',
  'trash.space.move': 'Space 移入回收站',
  'billing.organization_policy.auto_topup.update': '更新自动补充策略',
  'billing.organization_low_balance_config.update': '更新低余额预警',
}

const AUDIT_PERMISSION_LABELS: Record<string, string> = {
  'anomaly_alert:resolve': '消警',
  'anomaly_alert:list': '查看异常告警',
  'credit:deduct': '点券扣减',
  'credit:grant': '点券发放',
  'credit:reverse': '点券冲正',
  'credit:adjust': '点券调整',
  'credit_ledger:view': '查看点券流水',
  'credit_ledger:adjust': '点券调整',
  'credit_ledger:deduct': '点券扣减',
  'credit_ledger:grant': '点券发放',
  'credit_ledger:reverse': '点券冲正',
  'organization:list': '查看组织列表',
  'organization:view': '查看组织',
  'organization:create': '创建组织',
  'organization:disable': '组织强控',
  'wallet:list': '查看钱包列表',
  'wallet:view': '查看钱包',
  'wallet:adjust': '调整钱包',
  'wallet:recharge': '钱包充值',
  'wallet:export': '导出钱包',
  'trash:list': '查看回收站',
  'trash:restore': '恢复回收站',
  'trash:delete': '永久删除',
  'trash:cleanup': '清空回收站',
  'budget_policy:list': '查看预算策略',
  'budget_policy:update': '修改预算策略',
  'billing_dashboard:view': '查看计费仪表盘',
  'usage_event:list': '查看用量事件',
}

function compactKey(key: string): string {
  return key.replace(/[.:_\s]/g, '').toLowerCase()
}

function lookupLabel(map: Record<string, string>, key: string): string | undefined {
  const raw = key.trim()
  if (!raw) return undefined
  const variants = [
    raw,
    raw.replace(/[.:]/g, '_'),
    raw.replace(/[_:]/g, '.'),
    raw.replace(/[._]/g, ':'),
  ]
  for (const candidate of variants) {
    if (map[candidate]) return map[candidate]
  }
  const needle = compactKey(raw)
  for (const [mapKey, label] of Object.entries(map)) {
    if (compactKey(mapKey) === needle) return label
  }
  return undefined
}

export function labelAuditAction(action: string): string {
  if (!action || action === '-') return '-'
  return lookupLabel(AUDIT_ACTION_LABELS, action) || action
}

export function labelAuditPermission(code: string): string {
  if (!code || code === '-') return '-'
  return lookupLabel(AUDIT_PERMISSION_LABELS, code) || lookupLabel(AUDIT_ACTION_LABELS, code) || code
}

export function formatAuditReasonText(reason: string): string {
  if (!reason || reason === '-') return '-'
  try {
    const parsed = JSON.parse(reason) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.reason === 'string' && parsed.reason.trim()) return parsed.reason
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message
    }
  } catch {
    // 非 JSON
  }
  return reason
}

/**
 * 规范化「创建时间」单日筛选。
 * 空 / 空白 / 非 YYYY-MM-DD → 视为未筛选（不带日期边界）。
 */
export function normalizeAuditCreatedOn(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ''
  return trimmed
}

/**
 * 按本地自然日 → ISO 起止（仅在需要服务端按日过滤时使用）。
 * 组织详情审计 Tab 的创建日筛选改为前端 `isSameLocalDay`，清空时不应再调此函数带 bounds。
 */
export function auditCreatedDayRange(dateStr: string): { startAt?: string; endAt?: string } {
  const day = normalizeAuditCreatedOn(dateStr)
  if (!day) return {}
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(`${day}T23:59:59.999`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return {}
  return { startAt: start.toISOString(), endAt: end.toISOString() }
}

export function isSameLocalDay(iso: string, dateStr: string): boolean {
  const day = normalizeAuditCreatedOn(dateStr)
  if (!day) return true
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return true
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}` === day
}

export function buildOrganizationAuditRows(input: {
  organizationId: string
  sensitiveItems: AdminSensitiveActionItem[] | null | undefined
  organizationItems: AdminActionLogItem[] | null | undefined
  billingItems: AuditLogItem[] | null | undefined
  sourceFilter?: OrganizationAuditSource | ''
  actionFilter?: string
  operatorFilter?: string
  createdOn?: string
}): OrganizationAuditRow[] {
  const {
    organizationId,
    sensitiveItems,
    organizationItems,
    billingItems,
    sourceFilter = '',
    actionFilter = '',
    operatorFilter = '',
    createdOn = '',
  } = input

  const rows: OrganizationAuditRow[] = []

  for (const item of sensitiveItems || []) {
    rows.push({
      id: `sensitive-${item.id}`,
      source: 'sensitive',
      action: item.action,
      operator:
        item.actor_display_name || item.actor_admin_account_id || item.actor_user_id || '-',
      permission_code: item.permission_code,
      reason: item.reason || '-',
      ticket_id: item.ticket_id || '-',
      created_at: item.created_at,
      before_json: item.before_json,
      after_json: item.after_json,
    })
  }

  for (const item of organizationItems || []) {
    rows.push({
      id: `organization-${item.id}`,
      source: 'organization',
      action: item.action_type,
      operator: item.operator_name || item.operator_id || '-',
      permission_code: '-',
      reason: item.message || item.error_message || '-',
      ticket_id: String(item.request_payload?.ticket_id || '-'),
      created_at: item.created_at,
      before_json: item.request_payload,
      after_json: item.result_payload,
    })
  }

  for (const item of billingItems || []) {
    if (item.organization_id !== organizationId) continue
    const detailReason =
      typeof item.detail?.reason === 'string'
        ? item.detail.reason
        : typeof item.detail?.message === 'string'
          ? item.detail.message
          : ''
    rows.push({
      id: `billing-${String(item.id)}`,
      source: 'billing',
      action: String(item.action || '-'),
      operator: String(item.admin_user_id || '-'),
      permission_code: '-',
      reason: detailReason || formatAuditReasonText(JSON.stringify(item.detail || {})),
      ticket_id: String(item.detail?.ticket_id || '-'),
      created_at: String(item.created_at || ''),
      before_json: item.detail,
    })
  }

  return rows
    .filter((row) => (sourceFilter ? row.source === sourceFilter : true))
    .filter((row) => (actionFilter ? row.action === actionFilter : true))
    .filter((row) => (operatorFilter ? row.operator.includes(operatorFilter) : true))
    .filter((row) => isSameLocalDay(row.created_at, createdOn))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export function collectAuditActionOptions(input: {
  sourceFilter?: OrganizationAuditSource | ''
  sensitiveItems: AdminSensitiveActionItem[] | null | undefined
  organizationItems: AdminActionLogItem[] | null | undefined
  billingItems: AuditLogItem[] | null | undefined
}): Array<{ value: string; label: string }> {
  const { sourceFilter = '', sensitiveItems, organizationItems, billingItems } = input
  const keys = new Set<string>()
  if (!sourceFilter || sourceFilter === 'sensitive') {
    for (const item of sensitiveItems || []) {
      if (item.action) keys.add(item.action)
    }
  }
  if (!sourceFilter || sourceFilter === 'organization') {
    for (const item of organizationItems || []) {
      if (item.action_type) keys.add(item.action_type)
    }
  }
  if (!sourceFilter || sourceFilter === 'billing') {
    for (const item of billingItems || []) {
      if (item.action) keys.add(item.action)
    }
  }
  return Array.from(keys)
    .sort((a, b) => labelAuditAction(a).localeCompare(labelAuditAction(b), 'zh-CN'))
    .map((action) => ({ value: action, label: labelAuditAction(action) }))
}

export function buildOrganizationAuditCsv(
  rows: OrganizationAuditRow[],
  organizationId: string
): { filename: string; content: string } {
  const escapeCell = (value: unknown) => {
    const text = String(value ?? '')
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
    return text
  }
  const header = [
    '来源',
    '动作',
    '动作码',
    '操作人',
    '权限',
    '原因',
    '工单',
    '创建时间',
    'before_json',
    'after_json',
  ]
  const lines = [
    header.join(','),
    ...rows.map((row) =>
      [
        AUDIT_SOURCE_LABELS[row.source],
        labelAuditAction(row.action),
        row.action,
        row.operator,
        labelAuditPermission(row.permission_code),
        formatAuditReasonText(row.reason),
        row.ticket_id,
        row.created_at,
        row.before_json ? JSON.stringify(row.before_json) : '',
        row.after_json ? JSON.stringify(row.after_json) : '',
      ]
        .map(escapeCell)
        .join(',')
    ),
  ]
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return {
    filename: `organization-audit-${organizationId.slice(0, 8)}-${stamp}.csv`,
    content: `\uFEFF${lines.join('\n')}`,
  }
}

export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
