import {
  BarChart3,
  Bell,
  Boxes,
  ClipboardList,
  CreditCard,
  DollarSign,
  FileText,
  HardDrive,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Wallet,
} from 'lucide-react'
import type { BillingModuleGroup, DashboardStatusMeta } from './types'

export const COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#ef4444',
  '#14b8a6',
]

export const PIE_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
]

export const METER_LABELS: Record<string, string> = {
  'llm.tokens': 'LLM Token',
  'storage.gb_day': '存储 (GB-天)',
  'storage.bytes': '存储 (字节)',
  'speech.asr.seconds': '语音识别 (ASR)',
  'speech.tts.characters': '语音合成 (TTS)',
  'media.image.count': '图片生成',
  'media.video.seconds': '视频生成',
  'rag.embedding.tokens': '文本嵌入',
}

export const RECONCILIATION_STATUS_META: Record<string, DashboardStatusMeta> = {
  matched: { label: '已匹配', tone: 'success' },
  warning: { label: '差异预警', tone: 'warning' },
  mismatch: { label: '不匹配', tone: 'danger' },
}

export const DAYS_OPTIONS = [7, 30, 90, 365] as const

export const MODULE_GROUPS: BillingModuleGroup[] = [
  {
    title: '资金与账务',
    description: '处理余额、扣费明细、发票和存储账务问题。',
    items: [
      {
        title: '钱包管理',
        href: '/billing/wallets',
        icon: Wallet,
        desc: '查看用户与组织余额，排查扣费争议。',
      },
      {
        title: '计费事件',
        href: '/billing/events',
        icon: FileText,
        desc: '查询原始计费记录并导出核查。',
      },
      {
        title: '支付订单',
        href: '/billing/payment-orders',
        icon: CreditCard,
        desc: '查看支付宝、微信等支付订单与到账状态。',
      },
      {
        title: '存储计费',
        href: '/billing/storage',
        icon: HardDrive,
        desc: '治理存储占用、套餐与容量成本。',
      },
    ],
  },
  {
    title: '策略与治理',
    description: '维护预算、定价、会员和审计策略。',
    items: [
      {
        title: '预算策略',
        href: '/billing/budget',
        icon: Shield,
        desc: '控制组织预算阈值和阻断规则。',
      },
      {
        title: '定价管理',
        href: '/billing/products#pricing',
        icon: DollarSign,
        desc: '维护计量项定价与生效策略。',
      },
      {
        title: '商品配置',
        href: '/billing/products',
        icon: Boxes,
        desc: '统一配置套餐、credits 充值活动和权益扩容包。',
      },
      {
        title: '审计日志',
        href: '/billing/audit-log',
        icon: ClipboardList,
        desc: '追溯后台敏感操作与配置变更。',
      },
    ],
  },
  {
    title: '分析与运维',
    description: '发现异常、执行对账并分析整体盈利结构。',
    items: [
      {
        title: '异常告警',
        href: '/billing/anomalies',
        icon: Bell,
        desc: '处理消费突增、疑似滥用与异常模式。',
      },
      {
        title: '对账报告',
        href: '/billing/reconciliation',
        icon: Search,
        desc: '核对 BillingUsageEvent 与钱包扣款差异。',
      },
      {
        title: '成本分析',
        href: '/billing/cost-analysis',
        icon: BarChart3,
        desc: '分析供应商成本、收入和毛利率。',
      },
      {
        title: '生命周期清理',
        href: '/billing/organization-cleanup',
        icon: RefreshCw,
        desc: '处理组织删除后的 cleanup 队列、失败和卡住任务。',
      },
      {
        title: '运行时配置',
        href: '/billing/products#runtime',
        icon: Settings2,
        desc: '调整冻结、预检、缓存等计费运行时参数，无需重启。',
      },
    ],
  },
]
