import { ADMIN_PERMISSION } from '@/lib/admin-permissions'

export interface SensitiveActionMeta {
  permission: string
  title: string
  impact: string
  confirmText?: string
  targetType: string
  auditAction: string
}

export const SENSITIVE_ACTION_MAP: Record<string, SensitiveActionMeta> = {
  customer_user_update_status: {
    permission: ADMIN_PERMISSION.USER_UPDATE_STATUS,
    title: '客户用户状态变更',
    impact: '启停会直接影响客户登录与产品访问能力。',
    targetType: 'user',
    auditAction: 'customer_user.update_status',
  },
  customer_user_batch_update_status: {
    permission: ADMIN_PERMISSION.USER_UPDATE_STATUS,
    title: '批量客户用户状态变更',
    impact: '批量启停会影响多个客户账号，请确认原因和影响范围。',
    confirmText: '确认',
    targetType: 'user',
    auditAction: 'customer_user.batch_update_status',
  },
  admin_account_toggle_login: {
    permission: ADMIN_PERMISSION.ADMIN_ACCOUNT_UPDATE,
    title: '后台账号登录开关修改',
    impact: '修改后会立即影响后台登录与操作权限链路。',
    targetType: 'admin_account',
    auditAction: 'admin_account.update',
  },
  admin_account_assign_role: {
    permission: ADMIN_PERMISSION.ADMIN_ACCOUNT_ASSIGN_ROLE,
    title: '后台账号角色分配',
    impact: '角色变更会直接改变后台治理能力边界，请确认角色集合。',
    confirmText: '确认',
    targetType: 'admin_account',
    auditAction: 'admin_account.role_assign',
  },
  connect_revoke: {
    permission: ADMIN_PERMISSION.CONNECT_REVOKE,
    title: '撤销 Connect 授权',
    impact: '撤销后第三方连接将立即失效，相关自动化任务可能中断。',
    confirmText: '确认',
    targetType: 'connect',
    auditAction: 'connect.revoke',
  },
  credit_ledger_adjust: {
    permission: ADMIN_PERMISSION.CREDIT_ADJUST,
    title: 'credits 人工调整',
    impact: '会影响 Organization credits余额，请核对金额与工单。',
    confirmText: '确认',
    targetType: 'organization_credit_ledger',
    auditAction: 'credit_ledger.manual_adjust',
  },
}
