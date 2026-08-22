/**
 * 组织选择器组件
 * 使用新的 ContextMenu 系统
 */

import React, { useState, useRef, useEffect } from 'react'
import { Building2, Plus, Settings, Users, RefreshCw, MailOpen } from 'lucide-react'
import { ContextMenu, ContextMenuItem, ContextMenuDivider, ContextMenuSection } from '../context-menu'
import { t } from "../../i18n"

export interface Organization {
  id: string
  name: string
  icon?: string
  description?: string
  type?: 'personal' | 'team'
}

export interface OrganizationSelectorProps {
  /** 组织列表 */
  organizations: Organization[]
  /** 当前选中的组织 */
  selectedOrganization: Organization | null
  /** 加载状态 */
  isLoading?: boolean
  /** 错误信息 */
  error?: string | null
  /** 待处理邀请数量 */
  pendingInvitationCount?: number
  /** 选择组织回调 */
  onSelect: (organization: Organization) => void
  /** 创建组织回调 */
  onCreate?: () => void
  /** 组织设置回调 */
  onSettings?: (organization: Organization) => void
  /** 成员管理回调 */
  onMembers?: (organization: Organization) => void
  /** 重新加载回调 */
  onReload?: () => void
  /** 点击待处理邀请回调 */
  onPendingInvitationClick?: () => void
}

export const OrganizationSelector: React.FC<OrganizationSelectorProps> = ({
  organizations,
  selectedOrganization,
  isLoading = false,
  error = null,
  pendingInvitationCount = 0,
  onSelect,
  onCreate,
  onSettings,
  onMembers,
  onReload,
  onPendingInvitationClick,
}) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [autoRetryCount, setAutoRetryCount] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // ✅ 自动重试逻辑：当出现错误时，自动重试（最多 3 次）
  useEffect(() => {
    if (error && onReload && autoRetryCount < 3) {
      const delay = Math.min(2000 * Math.pow(2, autoRetryCount), 10000) // 2s, 4s, 8s
      console.log(`[OrganizationSelector] 自动重试 (${autoRetryCount + 1}/3)，延迟 ${delay}ms`)

      retryTimeoutRef.current = setTimeout(() => {
        setAutoRetryCount(prev => prev + 1)
        onReload()
      }, delay)
    }

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [error, onReload, autoRetryCount])

  // ✅ 清除自动重试计数（当成功加载或用户手动重试时）
  useEffect(() => {
    if (!error && autoRetryCount > 0) {
      console.log('[OrganizationSelector] 加载成功，重置重试计数')
      setAutoRetryCount(0)
    }
  }, [error, autoRetryCount])

  const selectedDisplayName =
    selectedOrganization?.type === 'personal'
      ? t('organizationSelector.personalIdentity')
      : selectedOrganization?.name

  const handleToggle = () => {
    if (!menuOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setMenuPosition({
        x: rect.left,
        y: rect.bottom + 4
      })
    }
    setMenuOpen(!menuOpen)
  }

  const handleSelect = (organization: Organization) => {
    onSelect(organization)
    setMenuOpen(false)
  }

  const handleRetry = () => {
    setAutoRetryCount(0)  // 重置自动重试计数
    onReload?.()
  }

  const renderOrganizationIcon = () => <Building2 className="h-4 w-4" />

  // 加载状态
  if (isLoading && organizations.length === 0) {
    return (
      <div className="p-4 flex items-center justify-center">
        <div className="h-4 w-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="ml-2 text-body text-muted-foreground">{t('organizationSelector.loading')}</span>
      </div>
    )
  }

  // ✅ 错误状态（改进版）
  if (error) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-body text-destructive mb-1">{t('organizationSelector.errorTitle')}</div>
        <div className="text-body text-muted-foreground">{error}</div>

        {/* 自动重试提示 */}
        {autoRetryCount > 0 && autoRetryCount < 3 && (
          <div className="text-body text-muted-foreground flex items-center justify-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {t('organizationSelector.autoRetry', { count: autoRetryCount, max: 3 })}
          </div>
        )}

        {/* 手动重试按钮 */}
        {onReload && (
          <button
            onClick={handleRetry}
            disabled={isLoading}
            className="text-body text-accent hover:text-accent-foreground hover:bg-accent/10 px-2 py-1 rounded transition-colors disabled:opacity-50"
          >
            {isLoading ? t('organizationSelector.retrying') : t('organizationSelector.retry')}
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {/* 选择器按钮 */}
      <button
        type="button"
        ref={buttonRef}
        onClick={handleToggle}
        title={selectedDisplayName ?? undefined}
        aria-label={selectedDisplayName ?? t('organizationSelector.placeholder')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="relative w-full flex items-center justify-between px-2 py-2 text-body font-medium h-auto text-muted-foreground hover:text-foreground hover:bg-accent/10 rounded transition-all duration-150"
      >
        <div className="flex items-center gap-2 truncate">
          {renderOrganizationIcon()}
          <span className="truncate">
            {selectedDisplayName || t('organizationSelector.placeholder')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {pendingInvitationCount > 0 && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
            </span>
          )}
          <svg
            className={`ml-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${menuOpen ? 'rotate-180' : ''}`}
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* 下拉菜单 */}
      <ContextMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorPosition={menuPosition || undefined}
        placement="bottom-start"
      >
        {/* 待处理邀请 */}
        {pendingInvitationCount > 0 && onPendingInvitationClick && (
          <>
            <ContextMenuItem
              icon={
                <span className="relative">
                  <MailOpen className="h-4 w-4 text-destructive" />
                  <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-destructive px-0.5 text-[10px] font-medium text-white">
                    {pendingInvitationCount}
                  </span>
                </span>
              }
              label={t('organizationSelector.pendingInvitations')}
              onClick={() => {
                setMenuOpen(false)
                onPendingInvitationClick()
              }}
            />
            <ContextMenuDivider />
          </>
        )}

        {/* 组织列表（按 type 分组） */}
        {(() => {
          const hasType = organizations.some(w => w.type)
          if (!hasType) {
            return organizations.map((organization) => (
              <ContextMenuItem
                key={organization.id}
                icon={renderOrganizationIcon()}
                label={organization.name}
                selected={selectedOrganization?.id === organization.id}
                onClick={() => handleSelect(organization)}
              />
            ))
          }

          const personal = organizations.filter(w => w.type === 'personal')
          const teams = organizations.filter(w => w.type !== 'personal')
          return (
            <>
              {personal.map((organization) => (
                <ContextMenuItem
                  key={organization.id}
                  icon={renderOrganizationIcon()}
                  label={t('organizationSelector.personalIdentity')}
                  selected={selectedOrganization?.id === organization.id}
                  onClick={() => handleSelect(organization)}
                />
              ))}
              {personal.length > 0 && teams.length > 0 && <ContextMenuDivider />}
              {teams.length > 0 && (
                <ContextMenuSection label={t('organizationSelector.teamGroup')}>
                  {teams.map((organization) => (
                    <ContextMenuItem
                      key={organization.id}
                      icon={renderOrganizationIcon()}
                      label={organization.name}
                      selected={selectedOrganization?.id === organization.id}
                      onClick={() => handleSelect(organization)}
                    />
                  ))}
                </ContextMenuSection>
              )}
            </>
          )
        })()}

        {/* 操作按钮 */}
        {(onCreate || onSettings || onMembers) && <ContextMenuDivider />}

        {onCreate && (
          <ContextMenuItem
            icon={<Plus className="h-4 w-4"  />}
            label={t('organizationSelector.create')}
            onClick={() => {
              setMenuOpen(false)
              onCreate()
            }}
          />
        )}

        {selectedOrganization && onSettings && (
          <ContextMenuItem
            icon={<Settings className="h-4 w-4"  />}
            label={t('organizationSelector.settings')}
            onClick={() => {
              setMenuOpen(false)
              onSettings(selectedOrganization)
            }}
          />
        )}

        {selectedOrganization && onMembers && (
          <ContextMenuItem
            icon={<Users className="h-4 w-4"  />}
            label={t('organizationSelector.members')}
            onClick={() => {
              setMenuOpen(false)
              onMembers(selectedOrganization)
            }}
          />
        )}
      </ContextMenu>
    </>
  )
}
