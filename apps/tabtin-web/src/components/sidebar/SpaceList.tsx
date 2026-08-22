/**
 * SpaceList — Web 端统一 Space 侧边栏列表
 *
 * 结构与 Electron SpaceList 一致，数据来自 app-shell stores。
 * Web 暂不需要 device 管理、IM、全局搜索等 Electron 特有功能。
 *
 * @see apps/tabtin-electron/src/renderer/src/components/sidebar/SpaceList.tsx
 */

import React, { useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { SpaceCard } from './SpaceCard'
import {
  useSpaceStore,
  useSpaceListStore,
  useOrganizationStore,
  type SpaceListItem,
  parseSpaceSelectionId,
} from '@tabtin/app-shell'
import { useAuthStore } from '@/stores/auth-store'
import { getPendingSpaceRouteSyncTarget } from '@/features/space/spaceRoutes'
import { useTranslation } from 'react-i18next'

export const SpaceList: React.FC = () => {
  const { t } = useTranslation('sidebar')
  const prevOrganizationIdRef = React.useRef<string | null>(null)
  const shouldSyncRouteAfterOrganizationChangeRef = React.useRef(false)
  const navigate = useNavigate()
  const location = useLocation()

  const spaces = useSpaceStore(state => state.spaces)
  const selectedSpace = useSpaceStore(state => state.selectedSpace)
  const isLoading = useSpaceStore(state => state.isLoading)
  const error = useSpaceStore(state => state.error)
  const loadSpaces = useSpaceStore(state => state.loadSpaces)
  const selectedWorkspace = useOrganizationStore(state => state.selectedOrganization)
  const workspaceError = useOrganizationStore(state => state.error)
  const isAuthenticated = useAuthStore(state => state.isAuthenticated)

  const selectedSpaceId = useSpaceListStore(state => state.selectedSpaceId)
  const selectedSpaceKind = useSpaceListStore(state => state.selectedSpaceKind)
  const getSpaceList = useSpaceListStore(state => state.getSpaceList)
  const hydrateSelectionForOrganization = useSpaceListStore(state => state.hydrateSelectionForOrganization)

  const clearInvalidSelection = useCallback(() => {
    useSpaceStore.getState().selectSpace(null)
    useSpaceListStore.getState().clearSelection()
  }, [])

  useEffect(() => {
    const nextOrganizationId = selectedWorkspace?.id ?? null
    const prevOrganizationId = prevOrganizationIdRef.current

    if (prevOrganizationId !== nextOrganizationId) {
      shouldSyncRouteAfterOrganizationChangeRef.current = Boolean(prevOrganizationId && nextOrganizationId)
      // ：selectSpace(null) 不清身份，切组织须先清跨 org selectedAgent
      useSpaceStore
        .getState()
        .clearSelectedAgentOutsideOrganization(nextOrganizationId)
      useSpaceStore.getState().selectSpace(null)
      if (nextOrganizationId) {
        hydrateSelectionForOrganization(nextOrganizationId, {
          preferCurrentSelectionAsFallback: prevOrganizationId == null,
        })
      } else {
        useSpaceListStore.getState().clearSelection({ preserveOrganizationMemory: true })
      }
    }

    prevOrganizationIdRef.current = nextOrganizationId
  }, [selectedWorkspace?.id, hydrateSelectionForOrganization])

  useEffect(() => {
    if (!shouldSyncRouteAfterOrganizationChangeRef.current) return
    if (!selectedWorkspace?.id || selectedSpaceKind !== 'workspace') return
    if (!selectedSpace?.id || selectedSpace.organization_id !== selectedWorkspace.id) return

    const targetPath = getPendingSpaceRouteSyncTarget({
      pathname: location.pathname,
      pendingOrganizationSwitch: true,
      selectedSpaceKind,
      organizationId: selectedWorkspace.id,
      spaceId: selectedSpace.id,
    })

    shouldSyncRouteAfterOrganizationChangeRef.current = false
    if (targetPath) {
      navigate(targetPath, { replace: true })
    }
  }, [
    location.pathname,
    navigate,
    selectedSpace?.id,
    selectedSpace?.organization_id,
    selectedSpaceKind,
    selectedWorkspace?.id,
  ])

  useEffect(() => {
    if (isAuthenticated && selectedWorkspace && !workspaceError) {
      loadSpaces(selectedWorkspace.id)
    }
  }, [isAuthenticated, selectedWorkspace?.id, workspaceError, loadSpaces])

  useEffect(() => {
    if (!selectedWorkspace?.id) return
    if (!selectedSpaceId || !selectedSpaceKind) return

    const { rawId } = parseSpaceSelectionId(selectedSpaceId)

    if (selectedSpaceKind === 'team') {
      clearInvalidSelection()
      return
    }

    if (selectedSpaceKind === 'workspace') {
      if (isLoading || error) return

      const hasSpace = spaces.some(
        (space) => space.id === rawId && space.organization_id === selectedWorkspace.id,
      )
      if (!hasSpace) {
        clearInvalidSelection()
        return
      }

      const needsRestore = useSpaceStore.getState().selectedSpace?.id !== rawId
      if (needsRestore) {
        useSpaceListStore.getState().selectSpaceById('workspace', rawId)
      }
    }
  }, [
    clearInvalidSelection,
    error,
    isLoading,
    selectedSpaceId,
    selectedSpaceKind,
    selectedWorkspace?.id,
    spaces,
  ])

  const spaceList: SpaceListItem[] = useMemo(() => {
    if (!selectedWorkspace?.id) return []
    return getSpaceList({
      organizationId: selectedWorkspace.id,
      navigationKinds: ['workspace'],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaces, selectedWorkspace?.id, getSpaceList])

  // 默认选中第一个 Space：当前 organization 下没有有效选中时（localStorage 无记录、
  // 或记录已失效），回退到列表里第一个 Space。选中后由 useSpaceListStore 的 persist
  // 自动写入 localStorage，下次打开优先恢复上次选中的 Space（多 Space 时切换即记忆）。
  useEffect(() => {
    if (!selectedWorkspace?.id) return
    if (isLoading || error) return
    if (spaceList.length === 0) return

    // 已有有效选中（含从 localStorage 恢复的 workspace）→ 不覆盖
    if (selectedSpaceId && selectedSpaceKind) {
      if (selectedSpaceKind !== 'workspace') return
      const { rawId } = parseSpaceSelectionId(selectedSpaceId)
      if (spaces.some((space) => space.id === rawId && space.organization_id === selectedWorkspace.id)) return
    }

    const firstSpace = spaceList.find((item) => item.navigationKind === 'workspace')
    if (firstSpace) {
      useSpaceListStore.getState().selectSpace(firstSpace)
    }
  }, [
    selectedWorkspace?.id,
    isLoading,
    error,
    spaces,
    spaceList,
    selectedSpaceId,
    selectedSpaceKind,
  ])

  if (isLoading && spaceList.length === 0) {
    return (
      <div className="flex items-center justify-center h-20">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="h-4 w-4 border-2 border-accent border-t-transparent rounded-full"
        />
      </div>
    )
  }

  if (error && spaceList.length === 0) {
    return (
      <div className="px-1 py-2 flex flex-col items-center gap-2">
        <div className="text-body text-destructive text-center leading-tight">{t('loadFailed')}</div>
        {selectedWorkspace && (
          <button
            onClick={() => loadSpaces(selectedWorkspace.id)}
            disabled={isLoading}
            className="h-7 w-7 rounded-lg text-body text-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
            title={error}
          >
            ↻
          </button>
        )}
      </div>
    )
  }

  if (spaceList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 px-2">
        <div className="text-center space-y-1">
          <p className="text-body font-medium text-foreground/80">
            {t('space.emptyTitle', '开始工作')}
          </p>
          <p className="text-caption text-muted-foreground/60 leading-tight">
            {t('space.emptyHint', '当前 Team 还没有可在 Web 打开的 Space')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <AnimatePresence>
        {spaceList.map((space, index) => (
          <motion.div
            key={space.id}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{
              duration: 0.12,
              delay: index * 0.015,
              ease: 'easeOut'
            }}
          >
            <SpaceCard
              space={space}
              isSelected={selectedSpaceId === space.id}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
