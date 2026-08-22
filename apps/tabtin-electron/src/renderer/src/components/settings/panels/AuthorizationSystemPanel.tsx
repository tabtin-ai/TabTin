/**
 * AuthorizationSystemPanel —— 「授权」面板（OS 系统权限）
 *
 * 单一职责：展示和管理操作系统给 TabTin 这个 App 的能力，对齐 macOS 系统设置
 * 「隐私与安全性」/ Windows「应用权限」的心智。
 *
 * 不包括（这些在别处管，不要拉回来）：
 *  - 桌面操控 HITL 业务授权（ApprovalManager + desktop-approval.json）
 *  - Agent 级 Yolo / approval_memo
 *  - 风险动作策略偏好
 *
 * 跨平台：
 *  - macOS：底层检测 7 项；屏幕与控制能力发布前不展示对应权限组
 *  - Windows：仅 Microphone / Notifications / Location 实际有效；
 *    其余 not-applicable 默认折叠
 *  - Linux：所有项 not-applicable，整体折叠
 */

import React from 'react'
import { Loader2, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SystemPermissionsOverview } from './authorization/SystemPermissionsOverview'
import { SystemPermissionsList } from './authorization/SystemPermissionsList'
import { PERMISSION_DISPLAY } from './authorization/permissionConfig'
import { usePermissionsState } from './authorization/usePermissionsState'
import { SETTINGS_TEXT_META } from '../settingsUi'
import { cn } from '@utils/cn'

interface AuthorizationSystemPanelProps {
  /** 嵌入模式：只渲染权限内容主体，由「系统权限」页提供页眉与分组标题。 */
  embedded?: boolean
}

export const AuthorizationSystemPanel: React.FC<AuthorizationSystemPanelProps> = ({ embedded = false }) => {
  const { t } = useTranslation('settings')
  const { items, loadState, isRefreshing, errorMessage, refresh, request, openSettings } =
    usePermissionsState()
  const visibleItems = items.filter(
    ({ kind }) => PERMISSION_DISPLAY[kind].group !== 'screen',
  )

  const body = (
    <>
      {loadState === 'unavailable' && (
        <SettingsSectionCard tone="muted">
          <p className="text-body text-muted-foreground">
            {t('authorizationSystem.unavailable')}
          </p>
        </SettingsSectionCard>
      )}

      {loadState === 'error' && (
        <SettingsSectionCard tone="danger">
          <p className="text-body text-foreground">
            {t('authorizationSystem.errorTitle')}
          </p>
          <p className={cn(SETTINGS_TEXT_META, 'mt-1 break-all')}>
            {errorMessage ?? t('authorizationSystem.errorFallback')}
          </p>
        </SettingsSectionCard>
      )}

      {loadState === 'loading' && items.length === 0 && (
        <div className="flex items-center justify-center py-10 text-muted-foreground/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="ml-2 text-body">
            {t('authorizationSystem.loading')}
          </span>
        </div>
      )}

      {visibleItems.length > 0 && (
        <>
          <SystemPermissionsOverview
            items={visibleItems}
            refreshing={isRefreshing}
            onRefresh={() => refresh()}
          />
          <SystemPermissionsList
            items={visibleItems}
            onRequest={request}
            onOpenSettings={openSettings}
          />
        </>
      )}
    </>
  )

  if (embedded) {
    return body
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<ShieldOff className="h-4 w-4" />}
        title={t('authorizationSystem.title')}
        subtitle={t('authorizationSystem.subtitle')}
      />
      {body}
    </SettingsPanelLayout>
  )
}
