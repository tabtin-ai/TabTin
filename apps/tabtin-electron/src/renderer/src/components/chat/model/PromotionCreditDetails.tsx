import React from 'react'
import type { PromotionCredit } from '@tabtin/chat-client'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META } from '../registry/chatDesignTokens'
import {
  formatPromotionCreditExpiry,
  formatPromotionCreditRemaining,
} from './providerCreditPresentation'

interface PromotionCreditDetailsProps {
  promotion: PromotionCredit
}

export function PromotionCreditDetails({
  promotion,
}: PromotionCreditDetailsProps) {
  const { t, i18n } = useTranslation('chat')
  const expiry = formatPromotionCreditExpiry(promotion, i18n.language)

  return (
    <div
      data-testid="promotion-credit-details"
      className="mt-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1"
    >
      <div className={cn(COMPOSER_TEXT_META, 'font-medium text-foreground/80')}>
        <span aria-hidden="true">🎁 </span>
        {promotion.label || t('model.promotionCredit.title', { defaultValue: '推广赠送额度' })}
      </div>
      <div className="mt-0.5 text-caption text-muted-foreground">
        <span>
          {t('model.promotionCredit.remaining', {
            credits: formatPromotionCreditRemaining(promotion, i18n.language),
            defaultValue: '剩余 {{credits}} credits',
          })}
        </span>
      </div>
      {expiry && (
        <div className="text-caption text-muted-foreground">
          {t('model.promotionCredit.expireAt', {
            date: expiry,
            defaultValue: '有效期 {{date}}',
          })}
        </div>
      )}
    </div>
  )
}
