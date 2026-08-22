import React from 'react'

export const WalletPaymentCard: React.FC<{ balance: string; amount: string; shortage?: string; onRecharge?: () => void }> = ({ balance, amount, shortage = '0.00', onRecharge }) => (
  <div className="rounded-md border p-3 text-sm"><div>组织余额：¥{balance}</div><div>订单金额：¥{amount}</div>{Number(shortage) > 0 && <div className="text-destructive">余额不足，缺口 ¥{shortage} <button type="button" onClick={onRecharge}>去充值</button></div>}</div>
)
