import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  LoadingSpinner,
  VisuallyHidden,
} from '@tabtin/smartsheet-ui'
import { LoginForm } from './LoginForm'
import { RegisterForm } from './RegisterForm'
import { ForgotPasswordForm } from './ForgotPasswordForm'
import { useTranslation } from 'react-i18next'
import { selectNeedsInviteCode, useAuthStore } from '@stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { InviteCodeContactStrip } from './InviteCodeAcquireCard'

interface AuthDialogProps {
  isOpen: boolean
  onClose: () => void
  initialMode?: 'login' | 'register' | 'forgot-password'
}

export const AuthDialog: React.FC<AuthDialogProps> = ({
  isOpen,
  onClose,
  initialMode = 'login',
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot-password'>(initialMode)
  const { t } = useTranslation('auth')
  const needsInviteCode = useAuthStore(selectNeedsInviteCode)

  const modeKey = mode === 'forgot-password' ? 'forgot' : mode

  // 重置模式当对话框关闭时
  const handleClose = () => {
    setMode('login')
    onClose()
  }

  // 注册成功处理：后端已返回 Token 并完成自动登录，直接关闭对话框
  const handleRegisterSuccess = () => {
    const user = useAuthStore.getState().user
    if (user?.invite_code_required && !user.invite_code_redeemed) {
      return
    }
    handleClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden">
        <DialogHeader>
          <VisuallyHidden>
            <DialogTitle>
              {t(`dialog.title.${modeKey}`)}
            </DialogTitle>
            <DialogDescription>
              {t(`dialog.description.${modeKey}`)}
            </DialogDescription>
          </VisuallyHidden>
        </DialogHeader>

        <div className="p-6">
          <AnimatePresence mode="wait">
            {needsInviteCode && (
              <motion.div
                key="invite"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
              >
                <DialogInviteCodePanel onBackToLogin={() => setMode('login')} />
              </motion.div>
            )}

            {!needsInviteCode && mode === 'login' && (
              <motion.div
                key="login"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
              >
                <LoginForm
                  onSwitchToRegister={() => setMode('register')}
                  onSwitchToForgotPassword={() => setMode('forgot-password')}
                />
              </motion.div>
            )}

            {!needsInviteCode && mode === 'register' && (
              <motion.div
                key="register"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
              >
                <RegisterForm
                  onSwitchToLogin={() => setMode('login')}
                  onRegisterSuccess={handleRegisterSuccess}
                />
              </motion.div>
            )}

            {!needsInviteCode && mode === 'forgot-password' && (
              <motion.div
                key="forgot-password"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
              >
                <ForgotPasswordForm
                  onSwitchToLogin={() => setMode('login')}
                  onResetSuccess={() => setMode('login')}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const DialogInviteCodePanel: React.FC<{ onBackToLogin: () => void }> = ({ onBackToLogin }) => {
  const { t } = useTranslation('auth')
  const redeemInviteCode = useAuthStore(s => s.redeemInviteCode)
  const logout = useAuthStore(s => s.logout)
  const isLoading = useAuthStore(s => s.isLoading)
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedCode = inviteCode.trim()
    if (!trimmedCode) {
      setError(t('invite.errors.required'))
      return
    }
    setError(null)
    try {
      await redeemInviteCode(trimmedCode)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invite.errors.verifyFailed'))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1 text-center">
        <h2 className="text-title font-semibold text-foreground">{t('invite.title')}</h2>
        <p className="text-body text-muted-foreground">{t('invite.description.dialog')}</p>
      </div>

      <InviteCodeContactStrip qrSize="md" />

      <div className="space-y-2">
        <p className="text-caption text-muted-foreground/60">{t('invite.haveCode')}</p>
        <Input
          value={inviteCode}
          onChange={event => {
            setInviteCode(event.target.value.toUpperCase())
            if (error) setError(null)
          }}
          placeholder={t('invite.placeholder.full')}
          autoComplete="one-time-code"
          disabled={isLoading}
        />
        {error && (
          <p className="text-caption text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? <LoadingSpinner size="sm" /> : t('invite.actions.continue')}
      </Button>

      <button
        type="button"
        onClick={() => {
          void runWithAgentContextSwitchGuard('logout', async () => {
            await logout('manual')
            onBackToLogin()
          })
        }}
        disabled={isLoading}
        className="block w-full text-center text-caption text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
      >
        {t('invite.actions.backToLogin')}
      </button>
    </form>
  )
}
