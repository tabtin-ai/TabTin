import { Check, X } from 'lucide-react'
import { LoadingSpinner } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { resolveStrengthKey, resolveSuggestionKey } from '@tabtin/shared'
import type { PasswordStrength } from '@/types/auth'

interface PasswordStrengthIndicatorProps {
  strength: PasswordStrength | null
  checking: boolean
}

export function PasswordStrengthIndicator({ strength, checking }: PasswordStrengthIndicatorProps) {
  const { t } = useTranslation('auth')

  if (!strength && !checking) return null

  const strengthKey = strength ? resolveStrengthKey(strength.level) : null
  const strengthLabel = strengthKey
    ? t(`registerForm.passwordStrength.levels.${strengthKey}`)
    : strength?.level

  return (
    <div className="mt-2 space-y-2">
      {checking ? (
        <div className="flex items-center gap-2 text-body text-muted-foreground">
          <LoadingSpinner size="sm" />
          {t('registerForm.passwordStrength.checking')}
        </div>
      ) : strength ? (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-muted rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  strength.score >= 80
                    ? 'bg-success'
                    : strength.score >= 60
                      ? 'bg-warning'
                      : 'bg-destructive'
                }`}
                style={{ width: `${strength.score}%` }}
              />
            </div>
            <span className="text-body font-medium">{strengthLabel}</span>
          </div>
          {strength.suggestions.length > 0 && (
            <ul className="text-body text-muted-foreground space-y-1">
              {strength.suggestions.map((suggestion, index) => {
                const suggestionKey = resolveSuggestionKey(suggestion)
                return (
                  <li key={index} className="flex items-start gap-2">
                    {strength.score >= 80 ? (
                      <Check className="h-3 w-3 text-success mt-0.5 flex-shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-destructive mt-0.5 flex-shrink-0" />
                    )}
                    {suggestionKey
                      ? t(`registerForm.passwordStrength.suggestions.${suggestionKey}`)
                      : suggestion}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : null}
    </div>
  )
}
