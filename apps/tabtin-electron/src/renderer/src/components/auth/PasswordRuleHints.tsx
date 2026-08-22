import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  PASSWORD_MIN_LENGTH,
  passwordMeetsCharClassRule,
} from '@tabtin/shared'
import { cn } from '@/utils/cn'

interface PasswordRuleHintsProps {
  password: string
  className?: string
}

/**
 * QQ 风格密码规则清单：短占位 + 输入框下可换行的勾选提示，
 * 随输入实时点亮已满足项（长度 / 至少 3 类字符）。
 * 「不能包含空格」不进清单；敲入/粘贴空格时由改密弹窗红框提示。
 */
export function PasswordRuleHints({ password, className }: PasswordRuleHintsProps) {
  const { t } = useTranslation('auth')
  const rules = [
    {
      key: 'minLength',
      ok: password.length >= PASSWORD_MIN_LENGTH,
      label: t('registerForm.rules.minLength', {
        defaultValue: 'At least {{count}} characters',
        count: PASSWORD_MIN_LENGTH,
      }),
    },
    {
      key: 'charClasses',
      ok: passwordMeetsCharClassRule(password),
      label: t('registerForm.rules.charClasses', {
        defaultValue: 'Include at least 3 of: upper, lower, digit, symbol',
      }),
    },
  ]

  return (
    <ul className={cn('space-y-1', className)} aria-live="polite">
      {rules.map((rule) => (
        <li
          key={rule.key}
          className={cn(
            'flex items-start gap-1.5 text-caption leading-snug',
            rule.ok ? 'text-success' : 'text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
              rule.ok ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground/80',
            )}
            aria-hidden
          >
            <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
          </span>
          <span>{rule.label}</span>
        </li>
      ))}
    </ul>
  )
}
