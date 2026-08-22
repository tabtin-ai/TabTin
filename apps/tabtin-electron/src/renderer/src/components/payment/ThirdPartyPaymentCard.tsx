import React from 'react'

export const ThirdPartyPaymentCard: React.FC<{ method: 'alipay' | 'wechat'; amount: string }> = ({ method, amount }) => <div className="rounded-md border p-3 text-sm">{method === 'alipay' ? '支付宝' : '微信支付'} · ¥{amount}</div>
