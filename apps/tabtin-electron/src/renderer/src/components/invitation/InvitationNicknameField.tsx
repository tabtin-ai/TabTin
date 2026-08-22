import React from 'react'
import { Input } from '@components/ui'
import { useTranslation } from 'react-i18next'

export type InvitationNicknameValidationError = 'required' | 'length' | null

export function validateInvitationNickname(value: string): InvitationNicknameValidationError {
  const nickname = value.trim()
  if (!nickname) return 'required'
  if (nickname.length > 50) return 'length'
  return null
}

interface InvitationNicknameFieldProps {
  inputId: string
  value: string
  error: string
  disabled?: boolean
  onChange: (value: string) => void
}

export const InvitationNicknameField: React.FC<InvitationNicknameFieldProps> = ({
  inputId,
  value,
  error,
  disabled = false,
  onChange,
}) => {
  const { t } = useTranslation('organization')
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-body font-medium text-foreground">
        {t('invitation.nickname.label')}
      </label>
      <Input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('invitation.nickname.placeholder')}
        autoComplete="nickname"
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      <p id={hintId} className="text-caption text-muted-foreground/60">
        {t('invitation.nickname.visibilityHint')}
      </p>
      {error && (
        <p id={errorId} className="text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
