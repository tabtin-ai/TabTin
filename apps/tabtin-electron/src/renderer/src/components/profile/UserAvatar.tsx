import React, { useState } from 'react'
import { LogIn } from 'lucide-react'
import { Button, UserAvatar as IdentityAvatar } from '@tabtin/smartsheet-ui'
import { AuthDialog } from '@/components/auth'
import { useAuthStore, selectIsAuthenticated } from '@/stores/useAuthStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useTranslation } from 'react-i18next'

/**
 * 用户头像组件
 * 未登录时显示登录按钮，已登录时显示用户头像
 */
export const UserAvatar: React.FC = () => {
  const { t } = useTranslation(['auth', 'settings'])
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const user = useAuthStore(state => state.user)
  const openSettings = useSettingsSpaceStore(state => state.openSettings)
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false)

  // 未登录状态
  if (!isAuthenticated) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsAuthDialogOpen(true)}
          className="h-8 gap-2"
          title={t('loginOrRegister', { ns: 'auth' })}
        >
          <LogIn className="h-4 w-4" />
          <span className="text-body">{t('login', { ns: 'auth' })}</span>
        </Button>

        <AuthDialog
          isOpen={isAuthDialogOpen}
          onClose={() => setIsAuthDialogOpen(false)}
        />
      </>
    )
  }

  // 已登录状态
  return (
    <>
      <Button
        variant="ghost"
        className="relative h-8 w-8 rounded-full p-0"
        onClick={() => openSettings({ category: 'profile', section: 'profile' })}
        title={user?.nickname || user?.username || t('tabs.profile', { ns: 'settings' })}
      >
        <IdentityAvatar
          name={user?.nickname || user?.username || ''}
          seed={user?.id}
          avatarUrl={user?.avatar}
          size={32}
        />
      </Button>

    </>
  )
}
