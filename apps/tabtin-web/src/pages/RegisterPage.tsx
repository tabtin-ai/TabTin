import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { AuthPageShell } from '@/components/layout/AuthPageShell'
import { InviteCodeGate } from '@/components/layout/InviteCodeGate'
import { RegisterForm } from '@/components/auth'
import { selectNeedsInviteCode, useAuthStore } from '@/stores/auth-store'

export function RegisterPage() {
  const navigate = useNavigate()
  const { t } = useTranslation('common')
  const needsInviteCode = useAuthStore(selectNeedsInviteCode)

  return (
    <AuthPageShell>
      {needsInviteCode ? (
        <InviteCodeGate embedded />
      ) : (
        <RegisterForm
          onSwitchToLogin={() => navigate('/login')}
          onRegisterSuccess={() => {
            toast({ title: t('toast.registerSuccess') })
            if (useAuthStore.getState().isAuthenticated) {
              navigate('/')
            }
          }}
        />
      )}
    </AuthPageShell>
  )
}
