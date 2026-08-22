import type { LucideIcon } from 'lucide-react'

export type DashboardTone = 'default' | 'success' | 'warning' | 'danger'

export interface DashboardStatusMeta {
  label: string
  tone: DashboardTone
}

export interface BillingModuleShortcut {
  title: string
  href: string
  icon: LucideIcon
  desc: string
}

export interface BillingModuleGroup {
  title: string
  description: string
  items: BillingModuleShortcut[]
}

export interface UsageAlertSummary {
  total_alerts: number
  critical_alerts: number
  warning_alerts: number
}

export interface TrendChartPoint {
  date: string
  events: number
  amount: number
}

export interface MeterChartPoint {
  name: string
  amount: number
  events: number
}
