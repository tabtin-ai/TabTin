/**
 * 系统权限单行
 *
 * 布局（参考 mac 系统设置「隐私与安全性」）：
 *  ┌────────────────────────────────────────────────────────────┐
 *  │ [icon] 权限名 [状态徽章]                                      │
 *  │        用途描述（一句话告诉用户它影响什么）                     │
 *  │        （可选）检测/身份提示                                   │
 *  │                                    [打开系统设置 ↗] / [立即请求] │
 *  └────────────────────────────────────────────────────────────┘
 *
 * 操作按钮的展示规则：
 *  - granted: 不显示按钮（用户已经搞定）
 *  - 当前平台不适用：不显示按钮；无法自动检测时仍保留系统设置入口
 *  - 麦克风等真·可请求：显示 [立即请求] + [去授权]
 *  - 辅助功能 / 屏幕录制：只显示「打开系统设置」类文案，不展示「立即请求」
 */

import React, { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { PERMISSION_DISPLAY, type PermissionDescriptor, type PermissionKind } from './permissionConfig'
import { PermissionStatusBadge } from './PermissionStatusBadge'
import { SETTINGS_HINT, SETTINGS_TEXT_META } from '../../settingsUi'

interface Props {
  descriptor: PermissionDescriptor
  onRequest: () => Promise<void>
  onOpenSettings: () => Promise<void>
}

/** 辅助功能 / 屏幕录制只能去系统设置，禁止展示「立即请求」误导文案。 */
function allowsInAppRequest(kind: PermissionKind, canRequest: boolean): boolean {
  if (kind === 'accessibility' || kind === 'screenCapture') return false
  return canRequest
}

function openSettingsActionKey(kind: PermissionKind): string {
  if (kind === 'accessibility') return 'authorizationSystem.actions.openAccessibilitySettings'
  if (kind === 'screenCapture') return 'authorizationSystem.actions.openSystemSettings'
  return 'authorizationSystem.actions.openSettings'
}

export const SystemPermissionRow: React.FC<Props> = ({
  descriptor,
  onRequest,
  onOpenSettings,
}) => {
  const { t } = useTranslation('settings')
  const display = PERMISSION_DISPLAY[descriptor.kind]
  const Icon = display.icon
  const [requesting, setRequesting] = useState(false)
  const [opening, setOpening] = useState(false)

  const titleKey = `authorizationSystem.items.${display.i18nKey}.title`
  const descKey = `authorizationSystem.items.${display.i18nKey}.desc`

  const status = descriptor.status
  const detection = descriptor.detection ?? 'supported'
  const isNotApplicable = status === 'not-applicable'
  const showActions =
    !isNotApplicable &&
    status !== 'granted' &&
    (descriptor.canOpenSettings || detection !== 'unsupported')
  const showRequest =
    showActions &&
    detection !== 'unsupported' &&
    allowsInAppRequest(descriptor.kind, descriptor.canRequest)
  const showDetectionHint = detection === 'unsupported'
  const showAccessibilityHint =
    descriptor.kind === 'accessibility' &&
    descriptor.platform === 'darwin' &&
    status !== 'granted' &&
    status !== 'not-applicable'
  const showRestartHint =
    descriptor.platform === 'darwin' &&
    descriptor.requiresAppRestartAfterGrant &&
    status !== 'granted' &&
    status !== 'not-applicable'

  const handleRequest = async () => {
    if (requesting) return
    setRequesting(true)
    try {
      await onRequest()
    } finally {
      setRequesting(false)
    }
  }

  const handleOpenSettings = async () => {
    if (opening) return
    setOpening(true)
    try {
      await onOpenSettings()
    } finally {
      // 留 800ms 显示 spinner，避免点击后视觉空白
      setTimeout(() => setOpening(false), 800)
    }
  }

  return (
    <div
      className={cn(
        'group flex items-start gap-3 rounded-md px-2 py-2.5',
        isNotApplicable && 'opacity-55',
      )}
      data-testid={`permission-row-${descriptor.kind}`}
    >
      <div className="mt-0.5 shrink-0 text-muted-foreground/80">
        <Icon className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-foreground">
            {t(titleKey)}
          </span>
          <PermissionStatusBadge
            status={status}
            detection={detection}
            pendingRestartConfirmation={descriptor.pendingRestartConfirmation}
          />
        </div>
        <p className={cn(SETTINGS_HINT, 'mt-0.5 leading-relaxed')}>
          {t(descKey)}
        </p>
        {showDetectionHint && (
          <p
            className={cn(SETTINGS_TEXT_META, 'mt-1 leading-relaxed')}
            data-testid={`permission-detection-hint-${descriptor.kind}`}
          >
            {t('authorizationSystem.hints.detectionUnsupported')}
          </p>
        )}
        {showAccessibilityHint && (
          <p
            className={cn(SETTINGS_TEXT_META, 'mt-1 leading-relaxed')}
            data-testid="permission-accessibility-hint"
          >
            {t('authorizationSystem.hints.accessibilityIdentity', {
              processLabel: descriptor.processLabel || 'TabTin',
            })}
          </p>
        )}
        {showRestartHint && (
          <p
            className={cn(SETTINGS_TEXT_META, 'mt-1 leading-relaxed')}
            data-testid={`permission-restart-hint-${descriptor.kind}`}
          >
            {t('authorizationSystem.hints.restartAfterGrant')}
          </p>
        )}
      </div>

      {showActions && (
        <div className="flex shrink-0 items-center gap-2">
          {showRequest && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRequest}
              disabled={requesting || opening}
              data-testid={`permission-request-${descriptor.kind}`}
            >
              {requesting ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {t('authorizationSystem.actions.requesting')}
                </>
              ) : (
                t('authorizationSystem.actions.request')
              )}
            </Button>
          )}
          {descriptor.canOpenSettings && (
            <Button
              variant="default"
              size="sm"
              onClick={handleOpenSettings}
              disabled={requesting || opening}
              data-testid={`permission-open-settings-${descriptor.kind}`}
            >
              {opening ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : null}
              {t(openSettingsActionKey(descriptor.kind))}
              {!opening && <ExternalLink className="ml-1 h-3 w-3" />}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
