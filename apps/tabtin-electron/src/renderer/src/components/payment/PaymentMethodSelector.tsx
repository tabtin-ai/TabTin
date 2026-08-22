import React from 'react'

export type MembershipPaymentMethod = 'organization_wallet' | 'alipay' | 'wechat'

export const PaymentMethodSelector: React.FC<{
  value: MembershipPaymentMethod
  onChange: (value: MembershipPaymentMethod) => void
  allowedMethods: Record<MembershipPaymentMethod, boolean>
}> = ({ value, onChange, allowedMethods }) => (
  <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="选择支付方式">
    <PaymentMethodButton active={value === 'organization_wallet'} disabled={!allowedMethods.organization_wallet} onClick={() => onChange('organization_wallet')}>组织余额</PaymentMethodButton>
    <PaymentMethodButton active={value === 'alipay'} disabled={!allowedMethods.alipay} onClick={() => onChange('alipay')}>支付宝</PaymentMethodButton>
    <PaymentMethodButton active={value === 'wechat'} disabled={!allowedMethods.wechat} onClick={() => onChange('wechat')}>微信支付</PaymentMethodButton>
  </div>
)

const PaymentMethodButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }> = ({ active, className = '', children, ...props }) => (
  <button type="button" aria-pressed={active} className={`relative rounded-md border px-3 py-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/25' : 'border-border bg-background text-foreground hover:border-primary/50'} ${className}`} {...props}>
    {active ? <span aria-hidden="true" className="absolute right-2 top-1 text-xs text-primary">✓</span> : null}
    {children}
  </button>
)
