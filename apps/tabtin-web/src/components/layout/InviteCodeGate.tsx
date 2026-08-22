import React, { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button, Input, LoadingSpinner } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@/stores/auth-store'

interface InviteCodeGateProps {
  embedded?: boolean
}

export function InviteCodeGate({ embedded = false }: InviteCodeGateProps) {
  const redeemInviteCode = useAuthStore((s) => s.redeemInviteCode)
  const logout = useAuthStore((s) => s.logout)
  const isLoading = useAuthStore((s) => s.isLoading)
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedCode = inviteCode.trim()
    if (!trimmedCode) {
      setError('请输入邀请码')
      return
    }

    setError(null)
    try {
      await redeemInviteCode(trimmedCode)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '邀请码验证失败')
    }
  }

  return (
    <div className={embedded ? 'w-full' : 'h-screen w-full flex items-center justify-center bg-background px-6'}>
      <form
        onSubmit={handleSubmit}
        className={embedded
          ? 'w-full space-y-5'
          : 'w-full max-w-sm rounded-xl border border-border/60 bg-card/80 shadow-[0_4px_24px_hsl(var(--foreground)/0.05)] p-6 space-y-5'}
      >
        <div className="space-y-2 text-center">
          <div className="mx-auto h-11 w-11 rounded-xl bg-accent/[0.08] text-accent flex items-center justify-center">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 className="text-title font-semibold text-foreground">输入邀请码</h2>
          <p className="text-body text-muted-foreground leading-relaxed">
            账号已登录。当前内测阶段需要完成邀请码验证后继续使用 TabTin。
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="web-post-auth-invite-code" className="sr-only">
            邀请码
          </label>
          <Input
            id="web-post-auth-invite-code"
            value={inviteCode}
            onChange={(event) => {
              setInviteCode(event.target.value.toUpperCase())
              if (error) setError(null)
            }}
            placeholder="请输入邀请码"
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
          {isLoading ? <LoadingSpinner size="sm" /> : '继续'}
        </Button>

        <button
          type="button"
          onClick={() => void logout()}
          disabled={isLoading}
          className="block w-full text-center text-caption text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          返回登录 / 换账号
        </button>
      </form>
    </div>
  )
}
