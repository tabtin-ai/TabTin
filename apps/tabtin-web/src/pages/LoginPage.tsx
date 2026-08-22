import { useNavigate } from 'react-router-dom'
import { AuthPageShell } from '@/components/layout/AuthPageShell'
import { InviteCodeGate } from '@/components/layout/InviteCodeGate'
import { LoginForm } from '@/components/auth'
import { selectNeedsInviteCode, useAuthStore } from '@/stores/auth-store'

export function LoginPage() {
  const navigate = useNavigate()
  const needsInviteCode = useAuthStore(selectNeedsInviteCode)

  return (
    <AuthPageShell>
      {needsInviteCode ? (
        <InviteCodeGate embedded />
      ) : (
        <LoginForm
          onSwitchToRegister={() => navigate('/register')}
          onSwitchToForgotPassword={() => navigate('/forgot-password')}
        />
      )}
    </AuthPageShell>
  )
}
