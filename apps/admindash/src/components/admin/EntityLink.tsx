import { Link } from 'react-router-dom'

const entityPath: Record<string, (id: string) => string> = {
  user: (id) => `/users?keyword=${encodeURIComponent(id)}`,
  adminAccount: (id) => `/admin-accounts/${id}`,
  organization: (id) => `/organizations/${id}`,
  space: (id) => `/spaces/${id}`,
  wallet: (id) => `/billing/wallets/${id}`,
  // 月结账单管理页已下线；invoice 仅作只读展示，不再生成跳转。
  invoice: () => '',
  billingEvent: (id) => `/billing/events?keyword=${encodeURIComponent(id)}`,
  usageEvent: (id) => `/ai-ops/usage?keyword=${encodeURIComponent(id)}`,
  model: (id) => `/ai/models?keyword=${encodeURIComponent(id)}`,
  provider: (id) => `/ai/providers?keyword=${encodeURIComponent(id)}`,
}

export function EntityLink({
  type,
  id,
  label,
}: {
  type: keyof typeof entityPath
  id: string
  label?: string
}) {
  const to = entityPath[type]?.(id)
  if (!to) return <span>{label ?? id}</span>
  return (
    <Link className="text-primary hover:underline" to={to}>
      {label ?? id}
    </Link>
  )
}
