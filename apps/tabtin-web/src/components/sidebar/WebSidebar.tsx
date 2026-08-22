/**
 * WebSidebar — Web 端左侧主导航栏（单列宽栏）
 *
 * 结构（自上而下）对齐 Electron 桌面侧栏：
 * 个人身份 / 工作空间切换 → Agent(Space) 列表 → 云端应用（文档/表格目录）→ 底部工具栏
 *
 * @see apps/tabtin-electron/src/renderer/src/components/context-space/DesktopPanel.tsx
 */

import React from 'react'
import { Check, RefreshCw, LogOut, ChevronDown } from 'lucide-react'
import { ContextMenu, ContextMenuDivider, ContextMenuItem } from '@tabtin/smartsheet-ui'
import { SpaceList } from './SpaceList'
import { SpaceResourceTree } from './SpaceResourceTree'
import { useOrganizationStore } from '@tabtin/app-shell'
import { useAuthStore } from '@/stores/auth-store'
import { UserAvatar } from '@/components/profile/UserAvatar'
import { LanguageToggle, ThemeToggle } from '@/components/layout/ToolbarWidgets'
import { NotificationBell } from '@/platform/notification-bell'
import { useTranslation } from 'react-i18next'

const SIDEBAR_WIDTH = 240

export const WebSidebar: React.FC = () => {
  const { t } = useTranslation('sidebar')
  const {
    organizations: workspaces,
    selectedOrganization: selectedWorkspace,
    isLoading: isLoadingWorkspaces,
    loadOrganizations: loadWorkspaces,
    selectOrganization: selectWorkspace,
    getEffectiveOrganization,
  } = useOrganizationStore()
  const isAuthenticated = useAuthStore(state => state.isAuthenticated)
  const logout = useAuthStore(state => state.logout)
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = React.useState(false)
  const workspaceButtonRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!isAuthenticated) return
    void (async () => {
      await loadWorkspaces()
      const { selectedOrganization: sw, organizations: ws } = useOrganizationStore.getState()
      if (!sw && ws.length > 0) {
        const fallback = getEffectiveOrganization()
        if (fallback) void selectWorkspace(fallback)
      }
    })()
  }, [getEffectiveOrganization, isAuthenticated, loadWorkspaces, selectWorkspace])

  const identityLabel =
    selectedWorkspace?.type === 'personal'
      ? t('personalIdentity')
      : selectedWorkspace?.name || t('workspaceFallback')

  return (
    <div
      className="flex-shrink-0 h-full flex flex-col bg-[hsl(var(--canvas))] border-r border-border/20"
      style={{ width: SIDEBAR_WIDTH }}
    >
      {/* 顶部：个人身份 / 工作空间切换 */}
      <div className="px-2 pt-3 pb-2 flex-shrink-0">
        <button
          ref={workspaceButtonRef}
          type="button"
          onClick={() => setIsWorkspaceMenuOpen((open) => !open)}
          className="w-full h-10 px-2 rounded-xl border border-border/35 bg-muted/35 flex items-center gap-2 text-left transition-colors hover:bg-accent/10 hover:border-accent/30"
          title={identityLabel}
          aria-label={identityLabel}
        >
          <span className="shrink-0 h-6 w-6 rounded-lg bg-accent/15 flex items-center justify-center text-caption font-semibold text-foreground/90">
            {(selectedWorkspace?.name?.trim()?.[0] || 'W').toUpperCase()}
          </span>
          <span className="flex-1 truncate text-body font-medium text-foreground/90">
            {identityLabel}
          </span>
          <ChevronDown className="shrink-0 h-3.5 w-3.5 text-muted-foreground/50" />
        </button>
      </div>

      <div className="mx-2 border-t border-border/20" />

      {/* 中部：Agent 列表 + 云端应用目录（共享一条滚动） */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hover py-1">
        <div className="px-1">
          <SpaceList />
        </div>
        <div className="mx-2 my-1.5 border-t border-border/20" />
        <SpaceResourceTree />
      </div>

      {/* 底部工具栏 */}
      <div className="flex items-center justify-between gap-1 px-2 py-2 border-t border-border/20 flex-shrink-0">
        <NotificationBell />
        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <LanguageToggle />
        </div>
        <UserAvatar />
        {isAuthenticated && (
          <button
            type="button"
            onClick={() => void logout()}
            className="h-7 w-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 flex items-center justify-center transition-colors"
            title={t('common:logout', '退出登录')}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <ContextMenu
        open={isWorkspaceMenuOpen}
        onClose={() => setIsWorkspaceMenuOpen(false)}
        anchorEl={workspaceButtonRef.current}
        className="w-56"
      >
        {isLoadingWorkspaces && workspaces.length === 0 ? (
          <ContextMenuItem
            disabled
            icon={<RefreshCw className="h-4 w-4 animate-spin" />}
            label={t('loadingWorkspaces')}
          />
        ) : (
          <>
            {/* 个人身份固定在顶部 */}
            {workspaces.filter(w => w.type === 'personal').map((workspace) => (
              <ContextMenuItem
                key={workspace.id}
                icon={
                  selectedWorkspace?.id === workspace.id
                    ? <Check className="h-4 w-4" />
                    : <span className="text-body w-4 text-center">{(workspace.name?.trim()?.[0] || 'P').toUpperCase()}</span>
                }
                label={t('personalIdentity')}
                onClick={() => {
                  selectWorkspace(workspace)
                  setIsWorkspaceMenuOpen(false)
                }}
              />
            ))}

            {/* 团队分组 */}
            {workspaces.some(w => w.type === 'team') && (
              <>
                <ContextMenuDivider />
                <div className="px-2 py-1 text-caption font-medium text-muted-foreground/60">
                  {t('teamGroup')}
                </div>
                {workspaces.filter(w => w.type === 'team').map((workspace) => (
                  <ContextMenuItem
                    key={workspace.id}
                    icon={
                      selectedWorkspace?.id === workspace.id
                        ? <Check className="h-4 w-4" />
                        : <span className="text-body w-4 text-center">{(workspace.name?.trim()?.[0] || 'W').toUpperCase()}</span>
                    }
                    label={workspace.name}
                    onClick={() => {
                      selectWorkspace(workspace)
                      setIsWorkspaceMenuOpen(false)
                    }}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ContextMenu>
    </div>
  )
}
