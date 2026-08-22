import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { AuthPageShell } from '@/components/layout/AuthPageShell'
import { ForgotPasswordForm } from '@/components/auth'

export function ForgotPasswordPage() {
  const navigate = useNavigate()
  const { t } = useTranslation('common')

  return (
    <AuthPageShell>
      <ForgotPasswordForm
        onSwitchToLogin={() => navigate('/login')}
        onResetSuccess={() => {
          toast({ title: t('toast.resetPasswordSuccess') })
          navigate('/login')
        }}
      />
    </AuthPageShell>
  )
}
