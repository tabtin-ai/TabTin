import React from 'react'
import { CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { ResolvedAskChoicePresentation } from '@stores/chat/presentation/messageBubble/resolvedAskChoicePresentation'
import {
  CARD_GAP,
  CARD_PADDING,
  CARD_RADIUS,
  CARD_STATE,
  ICON_SIZE,
  TEXT,
  TEXT_COLOR,
} from '../../../registry/chatDesignTokens'

export const ResolvedAskChoiceResultCard: React.FC<{
  result: ResolvedAskChoicePresentation
}> = ({ result }) => {
  const { t } = useTranslation('chat')

  return (
    <div className="w-full py-2" data-testid="resolved-ask-choice-card">
      <section
        aria-label={t('askUser.answered', { defaultValue: '已回答' })}
        className={cn('border', CARD_RADIUS, CARD_STATE.success, CARD_PADDING.x, CARD_PADDING.y)}
      >
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className={cn(ICON_SIZE.status, 'shrink-0', TEXT_COLOR.successSoft)} aria-hidden />
          <span className={cn(TEXT.label, TEXT_COLOR.successSoft)}>
            {t('askUser.answered', { defaultValue: '已回答' })}
          </span>
        </div>
        <div className={cn('mt-2', CARD_GAP)}>
          {result.questions.map((question) => (
            <div key={question.questionId} className="min-w-0">
              <p className={cn(TEXT.body, TEXT_COLOR.primary, 'break-words [overflow-wrap:anywhere]')}>
                {question.prompt}
              </p>
              <ul className="mt-1 space-y-1">
                {question.answers.map((answer) => (
                  <li
                    key={`${question.questionId}:${answer}`}
                    className={cn('flex min-w-0 items-start gap-1.5', TEXT.body, TEXT_COLOR.secondary)}
                  >
                    <CheckCircle2 className={cn(ICON_SIZE.md, 'mt-1 shrink-0', TEXT_COLOR.successSoft)} aria-hidden />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{answer}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

ResolvedAskChoiceResultCard.displayName = 'ResolvedAskChoiceResultCard'
