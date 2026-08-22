/**
 * 会话过期提示
 *
 * Agent 设置面板的认证门控兜底：`authPhase !== 'authenticated'` 时替代
 * 可编辑表单渲染，明确告知「会话已过期」并提供重新登录入口——避免 token
 * 失效后用户还能填表单、点保存，最后只收到通用「更新失败」。
 *
 * 「重新登录」走 `logout('token_expired')`：清理残留会话缓存并把整个应用
 * 切回登录界面（authPhase → unauthenticated 后由顶层布局接管）。
 */

import React from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@stores/useAuthStore'

export const SessionExpiredNotice: React.FC = () => {
  const { t } = useTranslation('space')

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground/60" aria-hidden />
      <p className="text-subtitle font-medium text-foreground">
        {t('sessionExpired.title', { defaultValue: '会话已过期' })}
      </p>
      <p className="text-body text-muted-foreground max-w-[320px]">
        {t('sessionExpired.description', {
          defaultValue: '登录状态已失效，设置已切换为只读。请重新登录后再修改工作空间设置。',
        })}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-1"
        onClick={() => void useAuthStore.getState().logout('token_expired')}
      >
        {t('sessionExpired.relogin', { defaultValue: '重新登录' })}
      </Button>
    </div>
  )
}
