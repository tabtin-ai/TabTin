import type {
  Model,
  PromotionCredit,
} from '@tabtin/chat-client'

export function shouldConfirmPromotionCreditModelSwitch(
  currentModel: Model | null | undefined,
  targetModel: Model | null | undefined,
): boolean {
  return Boolean(
    currentModel
    && targetModel
    && currentModel.id !== targetModel.id
    && currentModel.promotion_credit?.eligible
    && !targetModel.promotion_credit?.eligible,
  )
}

type PromotionCreditTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string

type PromotionCreditConfirm = (options: {
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
}) => Promise<boolean>

export async function confirmPromotionCreditModelSwitch({
  currentModel,
  targetModel,
  t,
  confirm,
}: {
  currentModel: Model | null | undefined
  targetModel: Model | null | undefined
  t: PromotionCreditTranslate
  confirm: PromotionCreditConfirm
}): Promise<boolean> {
  if (!shouldConfirmPromotionCreditModelSwitch(currentModel, targetModel)) {
    return true
  }
  return confirm({
    title: t('model.promotionCredit.switchTitle', {
      defaultValue: '切换后将不再使用当前赠送额度',
    }),
    description: t('model.promotionCredit.switchDescription', {
      provider: currentModel?.provider_display_name || currentModel?.provider || '',
      model: targetModel?.display_name || '',
      defaultValue: '当前赠送额度仅适用于 {{provider}} 模型。继续使用 {{model}} 将消耗套餐额度或账户余额。',
    }),
    cancelLabel: t('common.cancel', { defaultValue: '取消' }),
    confirmLabel: t('model.promotionCredit.continue', {
      defaultValue: '继续使用',
    }),
  })
}

export function formatPromotionCreditRemaining(
  promotion: PromotionCredit,
  locale?: string,
): string {
  return formatPromotionCreditAmount(promotion.remaining_credits, locale)
}

export function formatPromotionCreditAmount(
  credits: number,
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(credits)
}

export function formatPromotionCreditExpiry(
  promotion: PromotionCredit,
  locale?: string,
): string | null {
  if (!promotion.expire_at) return null
  const date = new Date(promotion.expire_at)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
