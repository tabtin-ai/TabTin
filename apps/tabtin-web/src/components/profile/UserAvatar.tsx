/**
 * UserAvatar — 从 Electron 端提取，Web 版简化（无 AuthDialog、无 settings 跳转）
 * @see apps/tabtin-electron/src/renderer/src/components/profile/UserAvatar.tsx
 */

import React from 'react'
import { User } from 'lucide-react'
import { UserAvatar as IdentityAvatar } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@/stores/auth-store'

export const UserAvatar: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  if (!isAuthenticated || !user) {
    return (
      <div className="h-8 w-8 rounded-full bg-muted/40 border border-border/50 flex items-center justify-center">
        <User className="h-4 w-4 text-muted-foreground" />
      </div>
    )
  }

  return (
    <button
      type="button"
      className="relative h-8 w-8 rounded-full p-0"
      title={user.nickname || user.username || ''}
    >
      <IdentityAvatar
        name={user.nickname || user.username || ''}
        seed={user.id}
        avatarUrl={user.avatar}
        size={32}
      />
    </button>
  )
}
