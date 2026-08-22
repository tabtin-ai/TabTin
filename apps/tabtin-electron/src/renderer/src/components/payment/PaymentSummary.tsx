import React from 'react'

export const PaymentSummary: React.FC<{ amount: string; currency?: string }> = ({ amount, currency = 'CNY' }) => <div className="flex justify-between text-sm"><span>应付金额</span><span>{currency === 'CNY' ? '¥' : currency}{amount}</span></div>
