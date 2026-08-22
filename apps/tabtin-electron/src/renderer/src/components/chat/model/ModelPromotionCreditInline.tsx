import React from 'react'
import type { PromotionCredit } from '@tabtin/chat-client'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META } from '../registry/chatDesignTokens'
import {
  formatPromotionCreditAmount,
} from './providerCreditPresentation'

interface ModelPromotionCreditInlineProps {
  promotion: PromotionCredit
  className?: string
}

/** 模型选择列表内联展示：紧跟模型名，不占独立一行。 */
export function ModelPromotionCreditInline({
  promotion,
  className,
}: ModelPromotionCreditInlineProps) {
  const { t, i18n } = useTranslation('chat')

  return (
    <span
      className={cn(
        COMPOSER_TEXT_META,
        'shrink-0 whitespace-nowrap tabular-nums',
        className,
      )}
    >
      {t('model.promotionCredit.inlineQuota', {
        remaining: formatPromotionCreditAmount(promotion.remaining_credits, i18n.language),
        total: formatPromotionCreditAmount(
          promotion.total_credits ?? promotion.remaining_credits,
          i18n.language,
        ),
        defaultValue: '赠享 {{remaining}}/{{total}} credits',
      })}
    </span>
  )
}
