import { shouldAutoExpandActiveGroup } from '@/components/layout/sidebar-collapse-state'
import { checkLeafItemActive } from '@/components/layout/sidebar-nav-active'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { cn } from '@/lib/utils'
import { hasOpsPermission } from '@/ops-governance/permissions'
import type { OpsPermissionCode } from '@/ops-governance/types'
import { useAuthStore } from '@/stores/auth-store'
import {
  Activity,
  AlertCircle,
  Boxes,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cog,
  CreditCard,
  Database,
  Download,
  FileText,
  FolderKanban,
  Gift,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquare,
  Package,
  Presentation,
  Receipt,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Smartphone,
  Table2,
  Terminal,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

interface NavItem {
  title: string
  href?: string
  icon: LucideIcon
  permission?: string | string[]
  superuserOnly?: boolean
  children?: NavItem[]
}

interface NavGroup {
  id: string
  title: string
  icon: LucideIcon
  items: NavItem[]
}

const isTableManagementRoute = (pathname: string): boolean =>
  pathname === '/tables' || pathname.startsWith('/tables/')

const isContentRoute = (pathname: string): boolean => pathname === '/content'

const isDocManagementRoute = (pathname: string): boolean =>
  pathname === '/docs' || pathname.startsWith('/docs/')

const isSlideManagementRoute = (pathname: string): boolean =>
  pathname === '/slides' || pathname.startsWith('/slides/')

const isMailManagementRoute = (pathname: string): boolean =>
  pathname === '/mail' || pathname.startsWith('/mail/')

const isShareManagementRoute = (pathname: string): boolean =>
  pathname === '/shares' || pathname.startsWith('/shares/')

const isAssetManagementRoute = (pathname: string): boolean =>
  pathname === '/assets' || pathname.startsWith('/assets/')

const isFunctionManagementRoute = (pathname: string): boolean =>
  pathname === '/functions' || pathname.startsWith('/functions/')

const isOrganizationRoute = (pathname: string): boolean =>
  pathname === '/organizations' || pathname.startsWith('/organizations/')

const isSpaceRoute = (pathname: string): boolean =>
  pathname === '/spaces' || pathname.startsWith('/spaces/')

const isBillingRoute = (pathname: string): boolean => pathname === '/billing'

const isCeleryOverviewRoute = (pathname: string): boolean => pathname === '/celery'

const isCeleryFailedRoute = (pathname: string): boolean => pathname === '/celery/failed-tasks'

const isDesktopUpdatesRoute = (pathname: string): boolean =>
  pathname === '/desktop-updates' || pathname.startsWith('/desktop-updates/')

const navGroups: NavGroup[] = [
  {
    id: 'home',
    title: '首页',
    icon: LayoutDashboard,
    items: [
      {
        title: '运营总览',
        href: '/',
        icon: LayoutDashboard,
        permission: ADMIN_PERMISSION.BILLING_DASHBOARD_VIEW,
      },
    ],
  },
  {
    id: 'customer-team',
    title: '客户与组织',
    icon: Users,
    items: [
      { title: '客户用户', href: '/users', icon: Users, permission: ADMIN_PERMISSION.USER_LIST },
      {
        title: '用户排障',
        href: '/customers/user-diagnose',
        icon: Users,
        permission: 'ops_user:diagnose',
      },
      {
        title: '邀请码',
        href: '/invite-codes',
        icon: KeyRound,
        permission: ADMIN_PERMISSION.INVITE_CODE_LIST,
      },
      {
        title: '意向用户',
        href: '/intent-users',
        icon: Users,
        permission: ADMIN_PERMISSION.INTENT_USER_LIST,
      },
      {
        title: '客户争议',
        href: '/billing/disputes',
        icon: MessageSquare,
        permission: ADMIN_PERMISSION.DISPUTE_LIST,
      },
      {
        title: '组织',
        href: '/organizations',
        icon: Building2,
        permission: ADMIN_PERMISSION.ORGANIZATION_LIST,
      },
      {
        title: 'Space',
        href: '/spaces',
        icon: FolderKanban,
        permission: ADMIN_PERMISSION.SPACE_LIST,
      },
    ],
  },
  {
    id: 'resource-management',
    title: '资源管理',
    icon: Database,
    items: [
      { title: '内容总览', href: '/content', icon: Database },
      { title: '文档', href: '/docs', icon: FileText },
      { title: '表格', href: '/tables', icon: Table2 },
      { title: 'Slides', href: '/slides', icon: Presentation },
      { title: '邮件', href: '/mail', icon: Mail },
      { title: '对象存储', href: '/assets', icon: HardDrive },
      { title: '分享链接', href: '/shares', icon: Share2, permission: ADMIN_PERMISSION.SHARE_LIST },
      { title: '回收站', href: '/trash', icon: Trash2, permission: ADMIN_PERMISSION.TRASH_LIST },
    ],
  },
  {
    id: 'billing-center',
    title: '计费中心',
    icon: Wallet,
    items: [
      {
        title: '计费概览',
        href: '/billing',
        icon: CreditCard,
        permission: ADMIN_PERMISSION.BILLING_DASHBOARD_VIEW,
      },
      {
        title: '商品与定价',
        href: '/billing/products',
        icon: Boxes,
        permission: [
          ADMIN_PERMISSION.PRODUCT_CONFIG_LIST,
          ADMIN_PERMISSION.PLAN_LIST,
          ADMIN_PERMISSION.PRICING_RULE_LIST,
          ADMIN_PERMISSION.CREDIT_PACKAGE_LIST,
          ADMIN_PERMISSION.ADDON_PACKAGE_LIST,
        ],
      },
      {
        title: '钱包与 credits',
        href: '/billing/wallets',
        icon: Wallet,
        permission: [ADMIN_PERMISSION.WALLET_LIST, ADMIN_PERMISSION.CREDIT_PACKAGE_LIST],
        children: [
          {
            title: '钱包列表',
            href: '/billing/wallets',
            icon: Wallet,
            permission: [ADMIN_PERMISSION.WALLET_LIST, ADMIN_PERMISSION.CREDIT_PACKAGE_LIST],
          },
          {
            title: '组织计费记录',
            href: '/billing/organization-credit-explanation',
            icon: CreditCard,
            permission: [ADMIN_PERMISSION.BILLING_EVENT_LIST, ADMIN_PERMISSION.WALLET_LIST],
          },
        ],
      },
      {
        title: '供应商赠送额度',
        href: '/billing/provider-credit',
        icon: Gift,
        permission: [
          ADMIN_PERMISSION.PROVIDER_CREDIT_VIEW,
          ADMIN_PERMISSION.PROVIDER_CREDIT_OPERATE,
          ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN,
        ],
      },
      {
        title: '用量与扣费',
        href: '/billing/events',
        icon: Database,
        permission: [
          ADMIN_PERMISSION.BILLING_EVENT_LIST,
          ADMIN_PERMISSION.COST_ANALYSIS_VIEW,
          ADMIN_PERMISSION.STORAGE_BILLING_LIST,
        ],
        children: [
          {
            title: '扣费事件',
            href: '/billing/events',
            icon: Database,
            permission: ADMIN_PERMISSION.BILLING_EVENT_LIST,
          },
          {
            title: '成本分析',
            href: '/billing/cost-analysis',
            icon: CreditCard,
            permission: ADMIN_PERMISSION.COST_ANALYSIS_VIEW,
          },
          {
            title: '存储计费',
            href: '/billing/storage',
            icon: HardDrive,
            permission: ADMIN_PERMISSION.STORAGE_BILLING_LIST,
          },
        ],
      },
      {
        title: '账单与对账',
        href: '/billing/payment-orders',
        icon: Receipt,
        permission: [
          ADMIN_PERMISSION.INVOICE_LIST,
          ADMIN_PERMISSION.RECONCILIATION_LIST,
          ADMIN_PERMISSION.AUDIT_LOG_LIST,
          ADMIN_PERMISSION.DISPUTE_LIST,
        ],
        children: [
          {
            title: '支付订单',
            href: '/billing/payment-orders',
            icon: CreditCard,
            permission: ADMIN_PERMISSION.INVOICE_LIST,
          },
          {
            title: '对账中心',
            href: '/billing/reconciliation',
            icon: CheckCircle2,
            permission: ADMIN_PERMISSION.RECONCILIATION_LIST,
          },
          {
            title: '计费审计',
            href: '/billing/audit-log',
            icon: CheckCircle2,
            permission: ADMIN_PERMISSION.AUDIT_LOG_LIST,
          },
          {
            title: '客户争议',
            href: '/billing/disputes',
            icon: MessageSquare,
            permission: ADMIN_PERMISSION.DISPUTE_LIST,
          },
        ],
      },
      {
        title: '财务 Trace',
        href: '/billing/finance-trace',
        icon: Receipt,
        permission: 'ops_finance_trace:view',
      },
      {
        title: '异常与预算',
        href: '/billing/anomalies',
        icon: AlertCircle,
        permission: [
          ADMIN_PERMISSION.ANOMALY_ALERT_LIST,
          ADMIN_PERMISSION.BUDGET_POLICY_LIST,
          ADMIN_PERMISSION.STORAGE_BILLING_LIST,
        ],
        children: [
          {
            title: '异常告警',
            href: '/billing/anomalies',
            icon: AlertCircle,
            permission: ADMIN_PERMISSION.ANOMALY_ALERT_LIST,
          },
          {
            title: '预算策略',
            href: '/billing/budget',
            icon: CreditCard,
            permission: ADMIN_PERMISSION.BUDGET_POLICY_LIST,
          },
          {
            title: '清理队列',
            href: '/billing/organization-cleanup',
            icon: RefreshCw,
            permission: ADMIN_PERMISSION.STORAGE_BILLING_LIST,
          },
        ],
      },
    ],
  },
  {
    id: 'ai-apps',
    title: 'AI 与应用',
    icon: Activity,
    items: [
      {
        title: '模型渠道与模型',
        href: '/ai/providers',
        icon: Activity,
        permission: [
          ADMIN_PERMISSION.PROVIDER_LIST,
          ADMIN_PERMISSION.MODEL_LIST,
          ADMIN_PERMISSION.AI_EMBEDDING_LIST,
          ADMIN_PERMISSION.AI_PROMPT_LIST,
        ],
        children: [
          {
            title: '模型渠道',
            href: '/ai/providers',
            icon: Cog,
            permission: ADMIN_PERMISSION.PROVIDER_LIST,
          },
          {
            title: '模型',
            href: '/ai/models',
            icon: Database,
            permission: ADMIN_PERMISSION.MODEL_LIST,
          },
          {
            title: '提示词',
            href: '/ai/prompts',
            icon: FileText,
            permission: ADMIN_PERMISSION.AI_PROMPT_LIST,
          },
          {
            title: '向量模型',
            href: '/ai/embedding',
            icon: Database,
            permission: ADMIN_PERMISSION.AI_EMBEDDING_LIST,
          },
        ],
      },
      {
        title: '场景与多模态',
        href: '/ai/scenes',
        icon: CheckCircle2,
        permission: [ADMIN_PERMISSION.AI_SCENE_LIST, ADMIN_PERMISSION.AI_MULTIMODAL_LIST],
        children: [
          {
            title: '场景',
            href: '/ai/scenes',
            icon: CheckCircle2,
            permission: ADMIN_PERMISSION.AI_SCENE_LIST,
          },
          {
            title: '多模态',
            href: '/ai/multimodal',
            icon: Activity,
            permission: ADMIN_PERMISSION.AI_MULTIMODAL_LIST,
          },
        ],
      },
      {
        title: 'AI 用量与异常',
        href: '/ai-ops/usage',
        icon: Activity,
        permission: [
          ADMIN_PERMISSION.USAGE_EVENT_LIST,
          ADMIN_PERMISSION.AI_OPS_VIEW,
          ADMIN_PERMISSION.AUDIT_LOG_LIST,
        ],
        children: [
          {
            title: '用量',
            href: '/ai-ops/usage',
            icon: Activity,
            permission: [
              ADMIN_PERMISSION.USAGE_EVENT_LIST,
              ADMIN_PERMISSION.AI_OPS_VIEW,
              ADMIN_PERMISSION.AUDIT_LOG_LIST,
            ],
          },
          {
            title: '运行时',
            href: '/ai-ops/runtime',
            icon: Cog,
            permission: ADMIN_PERMISSION.AI_OPS_VIEW,
          },
          {
            title: '审计',
            href: '/ai-ops/audit',
            icon: ShieldCheck,
            permission: ADMIN_PERMISSION.AUDIT_LOG_LIST,
          },
          {
            title: '异常',
            href: '/ai-ops/incident',
            icon: AlertCircle,
            permission: ADMIN_PERMISSION.AI_OPS_VIEW,
          },
        ],
      },
      {
        title: 'Agent 配置',
        href: '/agent-config/engine',
        icon: Settings,
        children: [
          {
            title: '引擎',
            href: '/agent-config/engine',
            icon: Cog,
          },
          {
            title: '上下文',
            href: '/agent-config/context',
            icon: Database,
          },
          {
            title: '护栏',
            href: '/agent-config/guard',
            icon: ShieldCheck,
          },
          {
            title: '特性',
            href: '/agent-config/features',
            icon: CheckCircle2,
          },
          {
            title: '清理',
            href: '/agent-config/cleanup',
            icon: Trash2,
          },
        ],
      },
      {
        title: 'Web 搜索',
        href: '/external/search-admin',
        icon: Search,
        permission: [ADMIN_PERMISSION.PRICING_RULE_LIST, ADMIN_PERMISSION.SEARCH_PROVIDER_DELETE],
      },
      {
        title: '应用与工具',
        href: '/app-installs',
        icon: Package,
        permission: [
          ADMIN_PERMISSION.APP_INSTALL_LIST,
          ADMIN_PERMISSION.APP_AUTHORIZATION_LIST,
          ADMIN_PERMISSION.CONNECT_LIST,
          ADMIN_PERMISSION.TOOL_LIST,
          ADMIN_PERMISSION.TOOL_AUDIT_LIST,
          ADMIN_PERMISSION.SKILL_REVIEW_LIST,
        ],
        children: [
          {
            title: '应用安装',
            href: '/app-installs',
            icon: Package,
            permission: ADMIN_PERMISSION.APP_INSTALL_LIST,
          },
          {
            title: '应用授权',
            href: '/app-authorization',
            icon: KeyRound,
            permission: ADMIN_PERMISSION.APP_AUTHORIZATION_LIST,
          },
          {
            title: '连接管理',
            href: '/connects',
            icon: Share2,
            permission: ADMIN_PERMISSION.CONNECT_LIST,
          },
          {
            title: '工具',
            href: '/tools',
            icon: Cog,
            permission: ADMIN_PERMISSION.TOOL_LIST,
          },
          {
            title: '工具审计',
            href: '/tool-audit',
            icon: ShieldCheck,
            permission: ADMIN_PERMISSION.TOOL_AUDIT_LIST,
          },
          {
            title: 'Skill 审核',
            href: '/skill-review',
            icon: CheckCircle2,
            permission: ADMIN_PERMISSION.SKILL_REVIEW_LIST,
          },
        ],
      },
    ],
  },
  {
    id: 'system-monitoring',
    title: '系统监控',
    icon: Activity,
    items: [
      {
        title: '队列',
        href: '/monitoring/queues',
        icon: Cog,
        permission: ['ops_task:view', 'ops_search_outbox:view', 'ops_beat:view'],
      },
      {
        title: 'Worker',
        href: '/monitoring/workers',
        icon: Users,
        permission: 'ops_task:view',
      },
      {
        title: '失败样本',
        href: '/monitoring/failed-samples',
        icon: Search,
        permission: ['ops_task:view', 'ops_search_outbox:view'],
      },
      {
        title: 'WebSocket',
        href: '/monitoring/websocket',
        icon: Activity,
        permission: 'ops_realtime:view',
      },
      {
        title: '协作',
        href: '/monitoring/collab',
        icon: Share2,
        permission: 'ops_collab:view',
      },
      {
        title: 'IM 即时通信',
        href: '/monitoring/im',
        icon: MessageSquare,
        permission: 'ops_realtime:view',
      },
      {
        title: 'Agent 会话',
        href: '/threads',
        icon: MessageSquare,
        superuserOnly: true,
      },
      {
        title: 'Agent 错误',
        href: '/agent-errors',
        icon: AlertCircle,
        superuserOnly: true,
      },
      {
        title: '事件与 SLA',
        href: '/ops/incidents',
        icon: AlertCircle,
        permission: ['ops_incident:view', 'ops_cost_sla:view'],
        children: [
          {
            title: '事件',
            href: '/ops/incidents',
            icon: AlertCircle,
            permission: 'ops_incident:view',
          },
          {
            title: '成本 SLA',
            href: '/ops/cost-sla',
            icon: CreditCard,
            permission: 'ops_cost_sla:view',
          },
        ],
      },
    ],
  },
  {
    id: 'system-governance',
    title: '系统治理',
    icon: Settings,
    items: [
      {
        title: '后台账号与权限',
        href: '/admin-accounts',
        icon: Users,
        permission: [ADMIN_PERMISSION.ADMIN_ACCOUNT_LIST, ADMIN_PERMISSION.ADMIN_ROLE_LIST],
        children: [
          {
            title: '后台账号',
            href: '/admin-accounts',
            icon: Users,
            permission: ADMIN_PERMISSION.ADMIN_ACCOUNT_LIST,
          },
          {
            title: 'RBAC 权限',
            href: '/admin-rbac',
            icon: KeyRound,
            permission: ADMIN_PERMISSION.ADMIN_ROLE_LIST,
          },
        ],
      },
      {
        title: '后台操作日志',
        href: '/governance/admin-logs',
        icon: CheckCircle2,
        permission: [
          'ops_audit:view',
          ADMIN_PERMISSION.SENSITIVE_ACTION_LIST,
          ADMIN_PERMISSION.ADMIN_LOGIN_LOG_LIST,
          ADMIN_PERMISSION.CLI_AUDIT_LIST,
        ],
        children: [
          {
            title: '全部',
            href: '/governance/admin-logs',
            icon: CheckCircle2,
            permission: ['ops_audit:view', ADMIN_PERMISSION.SENSITIVE_ACTION_LIST],
          },
          {
            title: '敏感操作',
            href: '/governance/admin-logs?type=sensitive',
            icon: CheckCircle2,
            permission: ADMIN_PERMISSION.SENSITIVE_ACTION_LIST,
          },
          {
            title: '排障查询',
            href: '/governance/admin-logs?type=diagnose',
            icon: Search,
            permission: 'ops_audit:view',
          },
          {
            title: '登录日志',
            href: '/governance/admin-logs?type=login',
            icon: Users,
            permission: ADMIN_PERMISSION.ADMIN_LOGIN_LOG_LIST,
          },
          {
            title: '权限变更',
            href: '/governance/admin-logs?type=permission',
            icon: ShieldCheck,
            permission: ADMIN_PERMISSION.CLI_AUDIT_LIST,
          },
          {
            title: '系统操作',
            href: '/governance/admin-logs?type=system',
            icon: Terminal,
            permission: ADMIN_PERMISSION.CLI_AUDIT_LIST,
          },
        ],
      },
      {
        title: '平台配置',
        href: '/platform-config',
        icon: Settings,
        permission: ADMIN_PERMISSION.PLATFORM_CONFIG_LIST,
      },
      {
        title: '更多运维工具',
        icon: ChevronRight,
        children: [
          {
            title: '桌面更新',
            href: '/desktop-updates',
            icon: Download,
            permission: ADMIN_PERMISSION.DESKTOP_UPDATE_LIST,
          },
          {
            title: '移动端版本',
            href: '/mobile-version',
            icon: Smartphone,
            permission: ADMIN_PERMISSION.DESKTOP_UPDATE_LIST,
          },
          {
            title: '官网获客',
            href: '/marketing',
            icon: TrendingUp,
            permission: ADMIN_PERMISSION.ANALYTICS_VIEW,
          },
          {
            title: '客户端错误',
            href: '/client-errors',
            icon: AlertCircle,
            permission: ADMIN_PERMISSION.CLIENT_ERROR_LIST,
          },
          {
            title: '诊断包收件箱',
            href: '/diagnostics',
            icon: Download,
            permission: ADMIN_PERMISSION.CLIENT_ERROR_LIST,
          },
        ],
      },
    ],
  },
]

function checkItemActive(href: string, pathname: string): boolean {
  switch (href) {
    case '/':
      return pathname === '/'
    case '/threads':
      return (
        pathname === '/threads' ||
        pathname.startsWith('/threads/') ||
        pathname.startsWith('/traces/')
      )
    case '/agent-errors':
      return pathname === '/agent-errors'
    case '/content':
      return isContentRoute(pathname)
    case '/organizations':
      return isOrganizationRoute(pathname)
    case '/spaces':
      return isSpaceRoute(pathname)
    case '/customers/user-diagnose':
      return pathname === '/customers/user-diagnose'
    case '/tables':
      return isTableManagementRoute(pathname)
    case '/docs':
      return isDocManagementRoute(pathname)
    case '/slides':
      return isSlideManagementRoute(pathname)
    case '/mail':
      return isMailManagementRoute(pathname)
    case '/shares':
      return isShareManagementRoute(pathname)
    case '/assets':
      return isAssetManagementRoute(pathname)
    case '/functions':
      return isFunctionManagementRoute(pathname)
    case '/billing':
      return isBillingRoute(pathname)
    case '/billing/products':
      return (
        pathname === '/billing/products' ||
        pathname === '/billing/products/membership' ||
        pathname === '/billing/products/addon-packages' ||
        pathname === '/billing/products/credit-packages' ||
        pathname === '/billing/products/pricing' ||
        pathname === '/billing/runtime-config'
      )
    case '/billing/wallets':
      return (
        pathname === '/billing/wallets' ||
        pathname.startsWith('/billing/wallets/') ||
        pathname === '/billing/organization-credit-explanation'
      )
    case '/billing/organization-credit-explanation':
      return pathname === '/billing/organization-credit-explanation'
    case '/intent-users':
      return pathname === '/intent-users' || pathname.startsWith('/intent-users/')
    case '/agent-config/engine':
      return pathname.startsWith('/agent-config/')
    case '/ops/incidents':
      return pathname === '/ops/incidents' || pathname === '/ops/cost-sla'
    case '/ops/cost-sla':
      return pathname === '/ops/cost-sla'
    case '/billing/events':
      return (
        pathname === '/billing/events' ||
        pathname === '/billing/cost-analysis' ||
        pathname === '/billing/storage'
      )
    case '/billing/payment-orders':
      return (
        pathname === '/billing/payment-orders' ||
        pathname === '/billing/reconciliation' ||
        pathname === '/billing/audit-log' ||
        pathname === '/billing/disputes'
      )
    case '/billing/anomalies':
      return (
        pathname === '/billing/anomalies' ||
        pathname === '/billing/budget' ||
        pathname === '/billing/organization-cleanup'
      )
    case '/billing/finance-trace':
      return pathname === '/billing/finance-trace'
    case '/ai/providers':
      return (
        pathname === '/ai/providers' ||
        pathname === '/ai/models' ||
        pathname === '/ai/embedding' ||
        pathname === '/ai/prompts'
      )
    case '/ai/scenes':
      return pathname === '/ai/scenes' || pathname === '/ai/multimodal' || pathname === '/ai/speech'
    case '/ai-ops/usage':
      return (
        pathname === '/ai-ops/usage' ||
        pathname === '/ai-ops/runtime' ||
        pathname === '/ai-ops/audit' ||
        pathname === '/ai-ops/incident'
      )
    case '/app-installs':
      return (
        pathname === '/app-installs' ||
        pathname.startsWith('/app-installs/') ||
        pathname === '/app-authorization' ||
        pathname.startsWith('/app-authorization/') ||
        pathname === '/connect-management' ||
        pathname === '/connects' ||
        pathname.startsWith('/connects/') ||
        pathname === '/tools' ||
        pathname.startsWith('/tools/') ||
        pathname === '/tool-audit' ||
        pathname === '/skill-review'
      )
    case '/tools':
      return (
        pathname === '/tools' ||
        pathname.startsWith('/tools/') ||
        pathname === '/tool-audit' ||
        pathname === '/skill-review'
      )
    case '/celery':
      return isCeleryOverviewRoute(pathname)
    case '/celery/failed-tasks':
      return isCeleryFailedRoute(pathname)
    case '/desktop-updates':
      return isDesktopUpdatesRoute(pathname)
    case '/mobile-version':
      return pathname === '/mobile-version' || pathname.startsWith('/mobile-version/')
    case '/app-authorization':
      return pathname === '/app-authorization' || pathname.startsWith('/app-authorization/')
    case '/connects':
      return pathname === '/connects' || pathname.startsWith('/connects/')
    case '/cli-audit':
      return pathname === '/cli-audit' || pathname.startsWith('/cli-audit/')
    case '/admin-accounts':
      return (
        pathname === '/admin-accounts' ||
        pathname.startsWith('/admin-accounts/') ||
        pathname === '/admin-rbac'
      )
    case '/governance/admin-logs':
      return (
        pathname === '/governance/admin-logs' ||
        pathname === '/admin-sensitive-actions' ||
        pathname === '/admin-login-logs' ||
        pathname === '/ops/audit' ||
        pathname === '/cli-audit' ||
        pathname === '/permission-audit' ||
        pathname.startsWith('/cli-audit/')
      )
    case '/admin-sensitive-actions':
      return pathname === '/admin-sensitive-actions'
    case '/permission-audit':
      return pathname === '/permission-audit' || pathname.startsWith('/permission-audit/')
    case '/skill-review':
      return pathname === '/skill-review' || pathname.startsWith('/skill-review/')
    case '/platform-config':
      return pathname === '/platform-config' || pathname.startsWith('/platform-config/')
    case '/monitor':
      return (
        pathname === '/monitor' ||
        pathname === '/celery' ||
        pathname === '/celery/failed-tasks' ||
        pathname === '/client-errors'
      )
    case '/monitoring/queues':
      return (
        pathname === '/monitoring/queues' ||
        pathname === '/celery' ||
        pathname === '/monitoring/overview'
      )
    case '/monitoring/workers':
      return pathname === '/monitoring/workers' || pathname === '/monitoring/consumers'
    case '/monitoring/failed-samples':
      return (
        pathname === '/monitoring/failed-samples' ||
        pathname === '/monitoring/messages' ||
        pathname === '/celery/failed-tasks'
      )
    case '/monitoring/websocket':
      return pathname === '/monitoring/websocket' || pathname === '/monitoring/connections'
    case '/monitoring/collab':
      return pathname === '/monitoring/collab'
    case '/monitoring/im':
      return pathname === '/monitoring/im' || pathname === '/monitoring/channels'
    case '/ops/stability':
    case '/ops/users':
    case '/ops/tasks':
    case '/ops/beat':
    case '/ops/llm-trace':
    case '/ops/oss-sms':
    case '/ops/dependencies':
    case '/ops/realtime':
    case '/ops/collab':
    case '/ops/search':
    case '/ops/finance-trace':
    case '/ops/audit':
      return pathname === href || pathname.startsWith(`${href}/`)
    default:
      if (
        href.startsWith('/billing/') ||
        href.startsWith('/ai/') ||
        href.startsWith('/ai-ops/') ||
        href.startsWith('/agent-config/') ||
        href.startsWith('/external/')
      ) {
        return pathname === href || pathname.startsWith(`${href}/`)
      }
      return pathname === href
  }
}

function resolveHref(href: string): string {
  return href
}

const COLLAPSED_GROUPS_KEY = 'sidebar-collapsed-groups:v2'
const COLLAPSED_SUBMENUS_KEY = 'sidebar-collapsed-submenus:v2'

function loadCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function loadCollapsedSubmenus(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SUBMENUS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function toOpsPermissionCode(permission: string): OpsPermissionCode | null {
  const code = permission.startsWith('maintenance.')
    ? permission.slice('maintenance.'.length)
    : permission
  return code.startsWith('ops_') ? (code as OpsPermissionCode) : null
}

function hasNavPermission(
  user: ReturnType<typeof useAuthStore.getState>['user'],
  permissions: string[] | null,
  required?: string | string[]
): boolean {
  if (!required) return true
  const requiredPermissions = Array.isArray(required) ? required : [required]
  const opsPermissions = requiredPermissions
    .map(toOpsPermissionCode)
    .filter((permission): permission is OpsPermissionCode => Boolean(permission))
  const adminPermissions = requiredPermissions.filter(
    (permission) => !toOpsPermissionCode(permission)
  )

  if (opsPermissions.length > 0) {
    const hasOpsAccess = opsPermissions.some((permission) => hasOpsPermission(user, permission))
    if (hasOpsAccess) return true
    if (adminPermissions.length === 0) return false
    return hasAdminPermission(permissions, adminPermissions)
  }

  return hasAdminPermission(permissions, adminPermissions)
}

function hasSuperAdminNavAccess(
  user: ReturnType<typeof useAuthStore.getState>['user'],
  permissions: string[] | null
): boolean {
  // 权限已加载时以投影为准，避免 persist 残留 is_superuser 造成幽灵菜单
  if (permissions != null) {
    return permissions.includes('*')
  }
  return Boolean(user?.is_superuser)
}

function filterNavItem(
  item: NavItem,
  permissions: string[] | null,
  user: ReturnType<typeof useAuthStore.getState>['user']
): NavItem | null {
  if (item.superuserOnly && !hasSuperAdminNavAccess(user, permissions)) return null

  if (item.children?.length) {
    const children = item.children
      .map((child) => filterNavItem(child, permissions, user))
      .filter((child): child is NavItem => Boolean(child))
    if (children.length === 0) return null
    return { ...item, children }
  }

  return hasNavPermission(user, permissions, item.permission) ? item : null
}

function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href && checkItemActive(item.href, pathname)) return true
  return item.children?.some((child) => isNavItemActive(child, pathname)) ?? false
}

export function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, adminPermissions, logout } = useAuthStore()

  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved === 'true'
  })

  const [collapsedGroups, setCollapsedGroups] =
    useState<Record<string, boolean>>(loadCollapsedGroups)
  const [collapsedSubmenus, setCollapsedSubmenus] =
    useState<Record<string, boolean>>(loadCollapsedSubmenus)

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(isCollapsed))
  }, [isCollapsed])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedGroups))
  }, [collapsedGroups])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_SUBMENUS_KEY, JSON.stringify(collapsedSubmenus))
  }, [collapsedSubmenus])

  const visibleNavGroups = useMemo(
    () =>
      navGroups
        .map((group) => ({
          ...group,
          items: group.items
            .map((item) => filterNavItem(item, adminPermissions, user))
            .filter((item): item is NavItem => Boolean(item)),
        }))
        .filter((group) => group.items.length > 0),
    [adminPermissions, user]
  )

  const activeGroupId = useMemo(() => {
    for (const group of visibleNavGroups) {
      for (const item of group.items) {
        if (isNavItemActive(item, location.pathname)) {
          return group.id
        }
      }
    }
    return null
  }, [location.pathname, visibleNavGroups])

  const previousActiveGroupId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (
      activeGroupId &&
      shouldAutoExpandActiveGroup(previousActiveGroupId.current, activeGroupId)
    ) {
      setCollapsedGroups((previous) => ({ ...previous, [activeGroupId]: false }))
    }
    previousActiveGroupId.current = activeGroupId
  }, [activeGroupId])

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
  }, [])

  const toggleSubmenu = useCallback((menuKey: string) => {
    setCollapsedSubmenus((prev) => ({ ...prev, [menuKey]: !prev[menuKey] }))
  }, [])

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const getInitials = (name: string) => {
    return name ? name.substring(0, 2).toUpperCase() : 'AD'
  }

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed)
  }

  return (
    <div
      className={cn(
        'flex h-full flex-col border-r bg-muted/20 transition-all duration-300',
        isCollapsed ? 'w-[60px]' : 'w-[240px]'
      )}
    >
      <div className="flex h-12 items-center px-4 border-b bg-background justify-between">
        <div className="flex items-center overflow-hidden">
          <LayoutDashboard
            className={cn('h-5 w-5 text-primary flex-shrink-0', isCollapsed ? '' : 'mr-2')}
          />
          {!isCollapsed && <h1 className="font-bold tracking-tight">AdminDash</h1>}
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="flex-shrink-0 p-1 hover:bg-muted rounded-md transition-colors"
          title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {visibleNavGroups.map((group) => {
          const GroupIcon = group.icon
          const isGroupCollapsed = collapsedGroups[group.id] ?? activeGroupId !== group.id
          const isGroupActive = activeGroupId === group.id

          if (isCollapsed) {
            return (
              <div key={group.id} className="space-y-0.5">
                <div
                  className={cn(
                    'flex items-center justify-center rounded-md px-2 py-2 transition-colors',
                    isGroupActive ? 'text-primary' : 'text-muted-foreground'
                  )}
                  title={group.title}
                >
                  <GroupIcon className="h-4 w-4 flex-shrink-0" />
                </div>
                {group.items
                  .flatMap((item) => {
                    const entries = item.children?.length ? item.children : [item]
                    const match: 'leaf' | 'section' = item.children?.length ? 'leaf' : 'section'
                    return entries.map((entry) => ({ entry, match }))
                  })
                  .map(({ entry, match }) => {
                    if (!entry.href) return null
                    const Icon = entry.icon
                    const href = resolveHref(entry.href)
                    const isActive =
                      match === 'leaf'
                        ? checkLeafItemActive(entry.href, location.pathname, location.search)
                        : checkItemActive(entry.href, location.pathname)
                    return (
                      <Link
                        key={entry.href}
                        to={href}
                        className={cn(
                          'flex items-center justify-center rounded-md px-2 py-1.5 transition-all',
                          isActive
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                        title={entry.title}
                      >
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                      </Link>
                    )
                  })}
              </div>
            )
          }

          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-3 py-2 text-body font-semibold uppercase tracking-wider transition-colors',
                  isGroupActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="flex items-center gap-2">
                  <GroupIcon className="h-4 w-4 flex-shrink-0" />
                  {group.title}
                </span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition-transform duration-200',
                    isGroupCollapsed && '-rotate-90'
                  )}
                />
              </button>

              <div
                className={cn(
                  'grid transition-[grid-template-rows] duration-200',
                  isGroupCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="ml-2 space-y-0.5 border-l border-border/50 pl-2">
                    {group.items.map((item) => {
                      const Icon = item.icon
                      const itemKey = item.href ?? `${group.id}:${item.title}`
                      const isActive = isNavItemActive(item, location.pathname)
                      if (item.children?.length) {
                        const isSubmenuCollapsed = collapsedSubmenus[itemKey] ?? !isActive
                        return (
                          <div key={itemKey} className="space-y-0.5">
                            <button
                              type="button"
                              onClick={() => toggleSubmenu(itemKey)}
                              className={cn(
                                'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-body font-medium transition-all',
                                isActive
                                  ? 'bg-muted text-foreground'
                                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              )}
                            >
                              <span className="flex min-w-0 items-center gap-2.5">
                                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="truncate">{item.title}</span>
                              </span>
                              <ChevronDown
                                className={cn(
                                  'h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200',
                                  isSubmenuCollapsed && '-rotate-90'
                                )}
                              />
                            </button>
                            <div
                              className={cn(
                                'grid transition-[grid-template-rows] duration-200',
                                isSubmenuCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                              )}
                            >
                              <div className="min-h-0 overflow-hidden">
                                <div className="ml-4 border-l border-border/40 pl-2">
                                  {item.children.map((child) => {
                                    if (!child.href) return null
                                    const ChildIcon = child.icon
                                    const childHref = resolveHref(child.href)
                                    const childActive = checkLeafItemActive(
                                      child.href,
                                      location.pathname,
                                      location.search
                                    )
                                    return (
                                      <Link
                                        key={child.href}
                                        to={childHref}
                                        className={cn(
                                          'mt-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-body transition-all',
                                          childActive
                                            ? 'bg-primary text-primary-foreground shadow-sm'
                                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                        )}
                                      >
                                        <ChildIcon className="h-3.5 w-3.5 flex-shrink-0" />
                                        <span className="truncate">{child.title}</span>
                                      </Link>
                                    )
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      }
                      if (!item.href) return null
                      const href = resolveHref(item.href)
                      return (
                        <Link
                          key={itemKey}
                          to={href}
                          className={cn(
                            'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body font-medium transition-all',
                            isActive
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                          <span>{item.title}</span>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t p-3 bg-muted/10">
        {!isCollapsed ? (
          <>
            <div className="flex items-center gap-3 mb-2">
              <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-body font-bold text-primary">
                {getInitials(user?.username || '')}
              </div>
              <div className="overflow-hidden flex-1">
                <p className="text-body font-medium truncate">{user?.username || '管理员'}</p>
                <p className="text-body text-muted-foreground truncate">
                  {user?.email || user?.phone || '访客'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-md border bg-background px-3 py-1.5 text-body font-medium hover:bg-accent transition-colors"
            >
              <LogOut className="h-3 w-3" />
              退出登录
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div
              className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-body font-bold text-primary"
              title={user?.username || '管理员'}
            >
              {getInitials(user?.username || '')}
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="p-1.5 rounded-md border bg-background hover:bg-accent transition-colors"
              title="退出登录"
            >
              <LogOut className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
