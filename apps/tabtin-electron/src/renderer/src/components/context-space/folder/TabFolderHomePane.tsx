import React, { useMemo, useCallback, useEffect } from 'react'
import { Boxes, FolderMinus, FolderOpen, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, ScrollArea, toast, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useCanvasLayoutStore, type CanvasTabKey } from '@stores/useCanvasLayoutStore'
import { useSpaceContextState } from '@components/context-space/SpaceContextAreaContext'
import { cn } from '@utils/cn'
import { canonicalizePath, normalizeComparableKey } from '@utils/canonicalPath'
import { ContextPageHeader } from '../ContextPageHeader'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { useFolderContextStore } from './useFolderStore'
import { getBaseName } from './utils'
import type { FolderContextKind, SpaceFolderState } from './types'
import { isLegacyOk } from '@/services/legacy-result'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import {
  SIDEBAR_ICON_BUTTON,
  SIDEBAR_LIST_PANEL,
  SIDEBAR_META,
} from '@components/layout/sidebarUi'

interface TabFolderHomePaneProps {
  spaceId: string
}

type DirectorySource = {
  id: string
  title: string
  subtitle?: string
  rootPath: string
  kind: FolderContextKind
}

/** Space 绑定目录（本机）：可挂多个 Space tag（历史数据可能多 Space 指向同一路径）。 */
type BoundDirEntry = {
  /** 归一化后的可比较 key，也用作 React key */
  key: string
  rootPath: string
  title: string
  spaces: Array<{ id: string; name: string }>
}

const LOCAL_DIRECTORY_TOAST_OPTIONS = { preferNative: true } as const

export const TabFolderHomePane: React.FC<TabFolderHomePaneProps> = ({ spaceId }) => {
  const { t } = useTranslation('context')
  const { tabScopeKey } = useSpaceContextState()
  const selectedOrganizationId = useOrganizationStore(s => s.selectedOrganization?.id ?? null)
  const spaces = useSpaceStore(s => s.spaces)
  const agentCache = useSpaceStore(s => s.agentCache)
  const currentUserId = useAuthStore(s => s.user?.id ?? null)
  const currentDeviceId = useDeviceStore(s => s.currentDevice?.id ?? null)
  const anchorSpace = useMemo(() => spaces.find(space => space.id === spaceId) ?? null, [spaceId, spaces])
  const activeSpaceId = useSpaceStore(s => s.selectedSpace?.id ?? null)
  const effectiveOrganizationId = anchorSpace?.organization_id ?? selectedOrganizationId
  const folderScopeReady = Boolean(effectiveOrganizationId && currentUserId)
  const scopeKey = folderScopeReady
    ? `tabfolder:organization:${effectiveOrganizationId}:user:${currentUserId}`
    : ''

  const userFolders = useFolderContextStore(s => s.userFolders)
  const legacyFolders = useFolderContextStore(s => s.folders)
  const getUserFolderIds = useFolderContextStore(s => s.getUserFolderIds)
  const addUserFolder = useFolderContextStore(s => s.addUserFolder)
  const findUserFolderByPath = useFolderContextStore(s => s.findUserFolderByPath)
  const removeUserFolder = useFolderContextStore(s => s.removeUserFolder)
  const reconcileBoundDirs = useFolderContextStore(s => s.reconcileBoundDirs)

  useEffect(() => {
    if (!folderScopeReady || !effectiveOrganizationId) return
    const currentOrganizationSpaceIds = new Set(
      spaces
        .filter(space => space.organization_id === effectiveOrganizationId)
        .map(space => space.id),
    )
    for (const [folderId, folder] of Object.entries(legacyFolders)) {
      if (!folder || folder.kind !== 'user') continue
      const delimiterIndex = folderId.indexOf('::')
      if (delimiterIndex <= 0) continue
      const sourceSpaceId = folderId.slice(0, delimiterIndex)
      if (!currentOrganizationSpaceIds.has(sourceSpaceId)) continue
      if (findUserFolderByPath(scopeKey, folder.rootPath)) continue
      addUserFolder(scopeKey, {
        rootPath: folder.rootPath,
        kind: 'user',
        title: folder.title || getBaseName(folder.rootPath) || folder.rootPath,
      })
    }
  }, [addUserFolder, effectiveOrganizationId, findUserFolderByPath, folderScopeReady, legacyFolders, scopeKey, spaces])

  // 本机 Space 绑定目录：从 spaces 派生（不落盘），只保留 control_device == 本机的目录。
  // 同一物理路径被多个 Space 绑定时合并成一行、挂多个 tag（历史/边界数据兜底）。
  const boundEntries = useMemo<BoundDirEntry[]>(() => {
    if (!currentDeviceId || !effectiveOrganizationId) return []
    const byKey = new Map<string, BoundDirEntry>()
    for (const space of spaces) {
      if (space.organization_id !== effectiveOrganizationId) continue
      if (space.type && space.type !== 'workspace') continue
      const agentId = space.execution_agent_id ?? space.agent_id ?? null
      const agent = agentId ? agentCache[agentId] : null
      const controlDeviceId =
        space.control_device_id
        ?? space.bound_device_id
        ?? agent?.control_device_id
        ?? agent?.bound_device_id
        ?? null
      // 只显示本机目录——「本地目录」语义：跨设备 Space 绑定的目录不展示、不参与去重。
      if (!controlDeviceId || controlDeviceId !== currentDeviceId) continue
      const rootPath = space.working_dir || agent?.working_dir || ''
      if (!rootPath) continue
      const key = normalizeComparableKey(rootPath)
      if (!key) continue
      const existing = byKey.get(key)
      if (existing) {
        existing.spaces.push({ id: space.id, name: space.name })
      } else {
        byKey.set(key, {
          key,
          rootPath,
          title: getBaseName(rootPath) || rootPath,
          spaces: [{ id: space.id, name: space.name }],
        })
      }
    }
    return [...byKey.values()]
  }, [agentCache, currentDeviceId, effectiveOrganizationId, spaces])

  const boundKeys = useMemo(() => new Set(boundEntries.map(entry => entry.key)), [boundEntries])
  const hasBoundEntries = boundEntries.length > 0

  // 降级承接：绑定关系消失（Space 删除 / 换绑）的目录，自动落成普通用户目录。
  // 守卫：设备已识别且组织有已加载的 Space，避免加载中 spaces 短暂为空导致误承接。
  useEffect(() => {
    if (!folderScopeReady || !scopeKey || !currentDeviceId) return
    if (spaces.length === 0) return
    reconcileBoundDirs(scopeKey, boundEntries.map(entry => entry.rootPath))
  }, [boundEntries, currentDeviceId, folderScopeReady, reconcileBoundDirs, scopeKey, spaces.length])

  const userSources = useMemo<DirectorySource[]>(() => {
    const result: DirectorySource[] = []
    for (const folderId of getUserFolderIds(scopeKey)) {
      const folder = userFolders[folderId]
      if (!folder) continue
      // 若某用户目录路径又被 Space 绑定（如降级后重新建 Space），交由绑定行展示，避免重复。
      if (boundKeys.has(normalizeComparableKey(folder.rootPath))) continue
      result.push({
        id: folderId,
        title: folder.title || getBaseName(folder.rootPath) || folder.rootPath,
        subtitle: folder.rootPath,
        rootPath: folder.rootPath,
        kind: folder.kind,
      })
    }
    return result
  }, [boundKeys, getUserFolderIds, scopeKey, userFolders])
  const hasUserSources = userSources.length > 0
  const hasAnySource = hasBoundEntries || hasUserSources

  const showDirectoryUnavailableToast = useCallback((rootPath: string) => {
    toast({
      title: t('folder.errors.directoryUnavailableTitle', { defaultValue: '目录不可用' }),
      description: t('folder.errors.directoryUnavailableDescription', {
        path: rootPath,
        defaultValue: '该目录不存在或无法访问：{{path}}',
      }),
      ...LOCAL_DIRECTORY_TOAST_OPTIONS,
    })
  }, [t])

  const showDirectoryOperationFailedToast = useCallback((err: unknown) => {
    toast({
      title: t('folder.errors.openFolderTitle', { defaultValue: '打开文件夹失败' }),
      description: formatIpcErrorForUser(
        err,
        t('folder.errors.openFolderDescription', {
          defaultValue: '当前环境不支持文件夹选择。',
        }),
      ),
      variant: 'destructive',
      ...LOCAL_DIRECTORY_TOAST_OPTIONS,
    })
  }, [t])

  const verifyDirectoryAvailable = useCallback(async (rootPath: string) => {
    const pathExists = window.tabtin?.fileSystem?.pathExists
    if (!pathExists) return true
    try {
      const result = await pathExists(rootPath)
      if (isLegacyOk(result) && result?.exists && result?.isDirectory) return true
    } catch {
      // fall through to the single user-facing unavailable message below
    }
    showDirectoryUnavailableToast(rootPath)
    return false
  }, [showDirectoryUnavailableToast])

  const openDirectoryTab = useCallback((source: DirectorySource) => {
    useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
      type: 'tabfolder',
      id: source.id,
      title: source.title,
      meta: {
        path: source.rootPath,
        kind: source.kind,
      },
    })
  }, [tabScopeKey])

  // 点绑定目录 → 完整切换到对应 Space（会话跟随）并打开其目录起始页。
  // 多 Space 指向同一路径时优先切当前选中的那个，否则切第一个。
  //
  // 关键：目录起始页用带 targetSpaceId 的 orchestration apphome tab（id 唯一 = 目标 Space），
  // 而不是无 targetSpaceId 的默认 `apphome:orchestration`——后者会被 SpaceContextContainer
  // 的旧标签清理 effect 在跨 Space 切换（effectiveTabScopeKey 由 space.id 翻回共享 desktop
  // scope）时删掉，导致 active 被打回 order[0]（第一个页签）。带 targetSpaceId 的标签被清理
  // effect 放行、由 apphome handler 按 targetSpaceId 渲染目标 Space 的工作目录。
  const openBoundDir = useCallback(async (entry: BoundDirEntry) => {
    const isAvailable = await verifyDirectoryAvailable(entry.rootPath)
    if (!isAvailable) return
    const target =
      entry.spaces.find(space => space.id === activeSpaceId) ?? entry.spaces[0]
    if (!target) return
    const openTargetHome = () => {
      useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
        type: 'apphome',
        id: `orchestration-${target.id}`,
        title: entry.title,
        meta: { appId: 'orchestration', targetSpaceId: target.id, spaceId: target.id },
      })
    }
    // 已在目标 Space：直接开/激活其目录起始页（共享 desktop scope，无需切换）。
    if (target.id === activeSpaceId) {
      openTargetHome()
      return
    }
    // 跨 Space：先切换 Space（会话跟随），再在共享 desktop scope 打开并激活目录起始页。
    // 两步都是同步 store 写入，React 重渲染 / effect 在其后运行时看到的 active 已是目标
    // 目录起始页；该标签带 targetSpaceId 不会被清理 effect 打回。
    useSpaceListStore.getState().selectSpaceBySpaceId(target.id)
    openTargetHome()
  }, [activeSpaceId, tabScopeKey, verifyDirectoryAvailable])

  const handleAddDirectory = useCallback(async () => {
    if (!folderScopeReady) return
    const tabtin = window.tabtin
    if (!tabtin?.showOpenDialog) {
      toast({
        title: t('folder.errors.openFolderTitle', { defaultValue: 'Failed to open folder' }),
        description: t('folder.errors.openFolderDescription', { defaultValue: 'Folder selection is not supported in this environment.' }),
        variant: 'destructive',
        ...LOCAL_DIRECTORY_TOAST_OPTIONS,
      })
      return
    }
    try {
      const picked = await tabtin.showOpenDialog({ properties: ['openDirectory'] })
      const rootPath = picked?.[0]
      if (!rootPath) return

      // 严格去重：解析物理真实路径后比较，防 symlink / junction / 大小写等不同写法指向同一目录。
      const pickedCanonical = await canonicalizePath(rootPath)
      // 撞上某个 Space 绑定目录 → 提示所属 Space，不重复添加
      const boundCanonicals = await Promise.all(
        boundEntries.map(async entry => ({ entry, key: await canonicalizePath(entry.rootPath) })),
      )
      const boundMatch = boundCanonicals.find(item => item.key === pickedCanonical)
      if (boundMatch) {
        const spaceName = boundMatch.entry.spaces[0]?.name ?? ''
        toast({
          title: t('folder.desktop.duplicateBoundTitle', {
            space: spaceName,
            defaultValue: '该目录已绑定 Space「{{space}}」',
          }),
          ...LOCAL_DIRECTORY_TOAST_OPTIONS,
        })
        return
      }
      // 与已添加的用户目录重复
      const userCanonicals = await Promise.all(
        userSources.map(async source => ({ source, key: await canonicalizePath(source.rootPath) })),
      )
      const userMatch = userCanonicals.find(item => item.key === pickedCanonical)
      if (userMatch) {
        toast({
          title: t('folder.desktop.duplicateUserTitle', { defaultValue: '该目录已在列表中' }),
          ...LOCAL_DIRECTORY_TOAST_OPTIONS,
        })
        return
      }

      const title = getBaseName(rootPath) || rootPath
      const { folderId } = addUserFolder(scopeKey, {
        rootPath,
        kind: 'user',
        title,
      } as Omit<SpaceFolderState, 'updatedAt' | 'refreshToken' | 'sourceKind' | 'scopeKey'>)
      await openDirectoryTab({
        id: folderId,
        title,
        subtitle: rootPath,
        rootPath,
        kind: 'user',
      })
    } catch (err) {
      showDirectoryOperationFailedToast(err)
    }
  }, [addUserFolder, boundEntries, folderScopeReady, openDirectoryTab, scopeKey, showDirectoryOperationFailedToast, t, userSources])

  const removeUserDirectory = useCallback((folderId: string) => {
    const tabKey = `tabfolder:${folderId}` as CanvasTabKey
    removeUserFolder(folderId)
    const canvasStore = useCanvasLayoutStore.getState()
    const group = canvasStore.findGroupByTabKey(tabScopeKey, tabKey)
    const pane = group?.panes.find(item => item.content?.tabKey === tabKey) ?? null
    if (group && pane) {
      canvasStore.closePane(tabScopeKey, group.id, pane.id)
    }
    useSpaceContextTabsStore.getState().closeTab(tabScopeKey, tabKey)
  }, [removeUserFolder, tabScopeKey])

  const renderBoundRow = (entry: BoundDirEntry) => {
    const isActive = entry.spaces.some(space => space.id === activeSpaceId)
    return (
      <SidebarMenuItem
        as="div"
        role="button"
        tabIndex={0}
        key={entry.key}
        active={isActive}
        data-testid="bound-dir-row"
        className="mx-0 w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2"
        onClick={() => { void openBoundDir(entry) }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            void openBoundDir(entry)
          }
        }}
      >
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-background/80 text-muted-foreground/80 ring-1 ring-foreground/[0.04] dark:bg-background/20 dark:ring-foreground/[0.06]">
          <Boxes className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="truncate text-body font-medium text-foreground/80">{entry.title}</span>
            {entry.spaces.map(space => (
              <span
                key={space.id}
                className="shrink-0 rounded-interactive bg-info/10 px-1.5 py-0.5 text-caption text-info"
              >
                {space.name}
              </span>
            ))}
          </span>
          <span className={cn(SIDEBAR_META, 'mt-0.5 block')}>{entry.rootPath}</span>
        </span>
      </SidebarMenuItem>
    )
  }

  const renderUserRow = (source: DirectorySource) => {
    return (
      <SidebarMenuItem
        as="div"
        role="button"
        tabIndex={0}
        key={source.id}
        data-testid="user-dir-row"
        className="mx-0 w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2"
        onClick={() => { void openDirectoryTab(source) }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            void openDirectoryTab(source)
          }
        }}
      >
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-background/80 text-muted-foreground/80 ring-1 ring-foreground/[0.04] dark:bg-background/20 dark:ring-foreground/[0.06]">
          <FolderOpen className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-foreground/80">{source.title}</span>
          {source.subtitle ? (
            <span className={cn(SIDEBAR_META, 'mt-0.5 block')}>{source.subtitle}</span>
          ) : null}
        </span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                tabIndex={0}
                aria-label={t('folder.desktop.removeDirectory', { defaultValue: '移除目录' })}
                className={cn(SIDEBAR_ICON_BUTTON, 'h-7 w-7 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive')}
                onClick={(event) => {
                  event.stopPropagation()
                  removeUserDirectory(source.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  removeUserDirectory(source.id)
                }}
              >
                <FolderMinus className="h-4 w-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" className="max-w-[260px]">
              {t('folder.desktop.removeDirectoryHint', { defaultValue: '从列表移除目录，不删除本地文件' })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </SidebarMenuItem>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="min-w-0 w-full shrink-0 px-4 pb-4 pt-6">
        <ContextPageHeader
          icon={<SidebarTypeEmoji appIdOrType="tabfolder" className="h-10 w-10" />}
          iconSurface="none"
          title={t('folder.desktop.title', { defaultValue: '本地目录' })}
          description={t('folder.desktop.subtitle', { defaultValue: '本机工作空间绑定的工作目录会自动出现在这里，你也可以添加其他本机目录。' })}
          footer={hasAnySource ? (
            <div className="flex items-center justify-end">
              <Button type="button" size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={handleAddDirectory} disabled={!folderScopeReady}>
                <FolderPlus className="h-[1em] w-[1em]" />
                {t('folder.desktop.addDirectory', { defaultValue: '添加目录' })}
              </Button>
            </div>
          ) : undefined}
        />
      </div>
      <div className="flex min-h-0 flex-1 w-full flex-col px-3 pb-3">
        <ScrollArea className={cn(SIDEBAR_LIST_PANEL, 'h-full w-full overscroll-contain [&>[data-radix-scroll-area-viewport]>div]:!block')} scrollBar="vertical" type="scroll">
          {hasAnySource ? (
            <div className="flex min-h-full w-full flex-col">
              <div className="min-w-0 w-full">
                {boundEntries.map(renderBoundRow)}
                {userSources.map(renderUserRow)}
              </div>
            </div>
          ) : (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
              <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-muted/35 text-muted-foreground/60">
                <FolderOpen className="h-6 w-6" />
              </div>
              <div>
                <div className="text-body font-medium text-foreground">
                  {t('folder.desktop.emptyTitle', { defaultValue: '还没有可显示的目录' })}
                </div>
                <div className="mt-1 max-w-sm text-caption text-muted-foreground/60">
                  {t('folder.desktop.emptyDescription', { defaultValue: '工作空间绑定本机目录后会自动显示；也可以手动添加目录用于浏览。' })}
                </div>
              </div>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={handleAddDirectory} disabled={!folderScopeReady}>
                <FolderPlus className="h-[1em] w-[1em]" />
                {t('folder.desktop.addDirectory', { defaultValue: '添加目录' })}
              </Button>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}

export default TabFolderHomePane
