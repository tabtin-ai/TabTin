import type { PaymentMethod } from '@/types/membership'

export type PaymentExtraParams = Record<string, unknown>

export function getDefaultPaymentExtraParams(method: PaymentMethod): PaymentExtraParams | undefined {
  if (method !== 'alipay') return undefined
  return { payment_type: 'qr' }
}
