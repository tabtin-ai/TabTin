/**
 * Folder Context Store
 *
 * 管理文件夹浏览状态（持久化存储）。
 *
 * 新边界下 TabFolder 是 Desktop 级目录聚合器：
 * - `userFolders` 保存用户主动添加的浏览目录（Organization+User scope）。
 * - `folders` 保留旧 per-Space folder tab 数据和资源流兼容，不再代表 Space 执行根。
 */

import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { contextRegistry } from '@components/context-space/registry/instance'
import type { ContextItem } from '@components/context-space/registry/types'
import type { FolderContextKind, SpaceFolderState } from './types'
import { getBaseName } from './utils'
import { useTranslation } from 'react-i18next'
import { notifyWorkspacePathsForSpace } from '@components/workspace/notifyWorkspacePaths'
import { normalizeComparableKey } from '@utils/canonicalPath'

/**
 * 生成文件夹的唯一 ID
 * 使用 spaceId 和路径的 base64 编码组合
 */
function generateFolderId(spaceId: string, path: string): string {
  // 简单的路径编码，避免特殊字符问题
  const encodedPath = btoa(encodeURIComponent(path))
  return `${spaceId}::${encodedPath}`
}

function generateUserFolderId(scopeKey: string, path: string): string {
  const encodedScope = btoa(encodeURIComponent(scopeKey))
  const encodedPath = btoa(encodeURIComponent(path))
  return `user::${encodedScope}::${encodedPath}`
}

function parseScopeKeyFromUserFolderId(folderId: string): string | null {
  const parts = folderId.split('::')
  if (parts.length !== 3 || parts[0] !== 'user') return null
  try {
    return decodeURIComponent(atob(parts[1]))
  } catch {
    return null
  }
}

/**
 * 从文件夹 ID 解析 Space ID
 */
function parseSpaceIdFromFolderId(folderId: string): string | null {
  const idx = folderId.indexOf('::')
  return idx > 0 ? folderId.slice(0, idx) : null
}

interface FolderContextState {
  // 存储所有文件夹：key = folderId (spaceId::encodedPath)
  folders: Record<string, SpaceFolderState | undefined>
  /** Desktop TabFolder 用户添加目录：key = user::{scope}::{path} */
  userFolders: Record<string, SpaceFolderState | undefined>
  /**
   * 记录每个 scope 上一次可见的「Space 绑定目录」路径快照（原始 rootPath）。
   * 用于降级承接：某绑定目录曾出现、如今绑定关系消失（Space 删除 / 换绑）时，
   * 自动把它落成一条普通用户目录，从而变得可删、可继续浏览。
   */
  seenBoundDirs: Record<string, string[]>

  // 添加文件夹（如果已存在相同路径，则更新）
  addSpaceFolder: (
    spaceId: string,
    payload: Omit<SpaceFolderState, 'updatedAt' | 'refreshToken'>
  ) => { folderId: string; isNew: boolean }

  /** 添加 Desktop 级用户浏览目录；不会影响 Space allowedPaths。 */
  addUserFolder: (
    scopeKey: string,
    payload: Omit<SpaceFolderState, 'updatedAt' | 'refreshToken' | 'sourceKind' | 'scopeKey'>
  ) => { folderId: string; isNew: boolean }

  /**
   * 对齐当前 scope 的绑定目录快照，实现降级承接。
   * 传入当前可见的绑定目录 rootPath 列表；对比上次快照，把「曾见过、现已消失」
   * 的路径补录为普通用户目录（已存在则跳过），再更新快照。
   */
  reconcileBoundDirs: (scopeKey: string, currentBoundPaths: string[]) => void

  // 移除指定文件夹
  removeFolder: (folderId: string) => void
  removeUserFolder: (folderId: string) => void

  /**
   * 用户目录失效后重绑：删旧 id、按新路径建新 id。
   * folderId 编码了 path，改路径必须换 id，并让 caller 关掉旧 tab / 打开新 tab。
   */
  relocateUserFolder: (
    folderId: string,
    newPath: string,
    title?: string,
  ) => { oldFolderId: string; newFolderId: string; rootPath: string; title: string } | null

  // 刷新指定文件夹
  refreshFolder: (folderId: string) => void

  // 根据路径查找已存在的文件夹 ID
  findFolderByPathForSpace: (spaceId: string, path: string) => string | null
  findUserFolderByPath: (scopeKey: string, path: string) => string | null

  // 获取 Space 的所有文件夹 ID
  getSpaceFolderIds: (spaceId: string) => string[]
  getUserFolderIds: (scopeKey: string) => string[]
}

export const useFolderContextStore = create<FolderContextState>()(
  persist(
    (set, get) => ({
      folders: {},
      userFolders: {},
      seenBoundDirs: {},

      // 路径权限治理 Wave 3 第二轮独立验证 P0-1 修复：IPC 推送下沉到 store
      // action 内部（不再仅在 hook `useFolderContextSource` 层做）。
      // 这条修复闭环了 7 处直接调 store action 的生产 caller：
      //   - FolderHomePane.tsx:123/326/344/393（4 个增/初始化场景）
      //   - FolderHomePane.tsx:349（删除按钮）
      //   - useRemoveFolderConfirm.ts:28（二次确认删除）
      //   - SkillsSection.tsx:148（打开 skills folder）
      // 任一直接 mutate store 都会同步推送当前 spaceId 完整快照到 main，
      // 不再绕过 IPC——dogfood 用户拖外接盘文件夹 / 右键删除 folder 真生效。
      addSpaceFolder: (spaceId, payload) => {
        const folderId = generateFolderId(spaceId, payload.rootPath)
        const existing = get().folders[folderId]

        set((state) => ({
          folders: {
            ...state.folders,
            [folderId]: {
              ...payload,
              sourceKind: payload.sourceKind ?? 'legacySpaceFolder',
              sourceSpaceId: payload.sourceSpaceId ?? spaceId,
              updatedAt: Date.now(),
              refreshToken: Date.now()
            }
          }
        }))

        // set 后调推送：notifyWorkspacePathsForSpace 内部 getState() 读最新值
        void notifyWorkspacePathsForSpace(spaceId)

        return { folderId, isNew: !existing }
      },

      addUserFolder: (scopeKey, payload) => {
        const folderId = generateUserFolderId(scopeKey, payload.rootPath)
        const existing = get().userFolders[folderId]

        set((state) => ({
          userFolders: {
            ...state.userFolders,
            [folderId]: {
              ...payload,
              sourceKind: 'userFolder',
              scopeKey,
              readOnly: false,
              updatedAt: Date.now(),
              refreshToken: Date.now(),
            },
          },
        }))

        return { folderId, isNew: !existing }
      },

      reconcileBoundDirs: (scopeKey, currentBoundPaths) => {
        if (!scopeKey) return
        const prevSeen = get().seenBoundDirs[scopeKey] ?? []
        const currentKeys = new Set(currentBoundPaths.map(normalizeComparableKey))
        // 曾见过、现已无绑定 → 降级承接为普通用户目录
        const disappeared = prevSeen.filter(
          (path) => !currentKeys.has(normalizeComparableKey(path)),
        )

        set((state) => {
          const nextUserFolders = { ...state.userFolders }
          for (const path of disappeared) {
            const folderId = generateUserFolderId(scopeKey, path)
            if (nextUserFolders[folderId]) continue
            nextUserFolders[folderId] = {
              rootPath: path,
              kind: 'user',
              title: getBaseName(path) || path,
              sourceKind: 'userFolder',
              scopeKey,
              readOnly: false,
              updatedAt: Date.now(),
              refreshToken: Date.now(),
            }
          }
          return {
            userFolders: nextUserFolders,
            seenBoundDirs: { ...state.seenBoundDirs, [scopeKey]: currentBoundPaths },
          }
        })
      },

      // removeFolder 只接 folderId——从 folderId 解码 spaceId 后推送。
      // 解码失败（folderId 格式畸形 / 老版数据）时跳过推送，防止把
      // 错误 spaceId 推到 main 端引发 fail-closed warning 噪音。
      removeFolder: (folderId) => {
        const spaceId = parseSpaceIdFromFolderId(folderId)
        set((state) => {
          if (!state.folders[folderId]) return state
          const next = { ...state.folders }
          delete next[folderId]
          return { folders: next }
        })
        if (spaceId) {
          void notifyWorkspacePathsForSpace(spaceId)
        }
      },

      removeUserFolder: (folderId) => {
        set((state) => {
          if (!state.userFolders[folderId]) return state
          const next = { ...state.userFolders }
          delete next[folderId]
          return { userFolders: next }
        })
      },

      relocateUserFolder: (folderId, newPath, title) => {
        const existing = get().userFolders[folderId]
        if (!existing) return null
        const scopeKey = existing.scopeKey || parseScopeKeyFromUserFolderId(folderId)
        if (!scopeKey) return null
        const nextTitle = title || getBaseName(newPath) || newPath
        const newFolderId = generateUserFolderId(scopeKey, newPath)

        set((state) => {
          const nextUserFolders = { ...state.userFolders }
          delete nextUserFolders[folderId]
          nextUserFolders[newFolderId] = {
            ...existing,
            rootPath: newPath,
            title: nextTitle,
            kind: 'user',
            sourceKind: 'userFolder',
            scopeKey,
            readOnly: false,
            updatedAt: Date.now(),
            refreshToken: Date.now(),
          }
          return { userFolders: nextUserFolders }
        })

        return {
          oldFolderId: folderId,
          newFolderId,
          rootPath: newPath,
          title: nextTitle,
        }
      },

      refreshFolder: (folderId) => {
        const current = get().folders[folderId]
        if (!current) return
        set((state) => ({
          folders: {
            ...state.folders,
            [folderId]: {
              ...current,
              refreshToken: Date.now()
            }
          }
        }))
      },

      findFolderByPathForSpace: (spaceId, path) => {
        const folderId = generateFolderId(spaceId, path)
        return get().folders[folderId] ? folderId : null
      },

      findUserFolderByPath: (scopeKey, path) => {
        const folderId = generateUserFolderId(scopeKey, path)
        return get().userFolders[folderId] ? folderId : null
      },

      getSpaceFolderIds: (spaceId) => {
        const folders = get().folders
        return Object.keys(folders).filter(
          (folderId) => parseSpaceIdFromFolderId(folderId) === spaceId
        )
      },

      getUserFolderIds: (scopeKey) => {
        const folders = get().userFolders
        return Object.keys(folders).filter(
          (folderId) => parseScopeKeyFromUserFolderId(folderId) === scopeKey
        )
      },
    }),
    {
      name: 'context-folder-v2',
      storage: createJSONStorage(() => localStorage)
    }
  )
)

export interface FolderContextSourceOptions {
  spaceId?: string
}

export interface OpenFolderResult {
  tabKey: string
  folderId: string
  title: string
  kind: string
  path: string
  isNew: boolean
}

export interface FolderContextSourceResult {
  /** 所有文件夹的 ContextItem 列表（非标签驱动，仅供列表/搜索/UI 复用） */
  items: ContextItem[]
  /** 打开用户文件夹（如果已存在则跳转） */
  openUserFolder: (path: string) => OpenFolderResult
  /** 打开 Agent 文件夹（如果已存在则跳转） */
  openAgentFolder: (path: string) => OpenFolderResult
  /** 撤销文件夹授权（从 store 中删除该文件夹） */
  revokeFolder: (folderId: string) => void
  /** 刷新指定的文件夹 */
  refreshFolder: (folderId: string) => void
  /** 根据 folderId 获取文件夹状态 */
  getFolderById: (folderId: string) => SpaceFolderState | null
}

/**
 * 文件夹上下文 Hook
 *
 * 提供文件夹的打开、关闭、刷新等操作
 * 支持同时打开多个文件夹标签
 */
export function useFolderContextSource({
  spaceId: spaceIdProp,
}: FolderContextSourceOptions): FolderContextSourceResult {
  const spaceId = spaceIdProp ?? ''
  const { t } = useTranslation('context')
  const folders = useFolderContextStore((state) => state.folders)
  const userFolders = useFolderContextStore((state) => state.userFolders)
  const getSpaceFolderIds = useFolderContextStore((state) => state.getSpaceFolderIds)
  const addSpaceFolder = useFolderContextStore((state) => state.addSpaceFolder)
  const removeFolder = useFolderContextStore((state) => state.removeFolder)
  const refreshFolderAction = useFolderContextStore((state) => state.refreshFolder)

  const resolveFolderTitle = useCallback((state: SpaceFolderState | null) => {
    if (!state) return t('folder.labels.defaultTitle')
    if (state.kind === 'sandbox') {
      return t('folder.labels.agentTitle')
    }
    return state.title || t('folder.labels.defaultTitle')
  }, [t])

  // 获取当前 Space 的所有文件夹
  const spaceFolderIds = useMemo(
    () => getSpaceFolderIds(spaceId),
    [getSpaceFolderIds, spaceId, folders]
  )

  const spaceFolders = useMemo(() => {
    return spaceFolderIds
      .map((id) => ({ id, state: folders[id] }))
      .filter((item): item is { id: string; state: SpaceFolderState } => !!item.state)
  }, [folders, spaceFolderIds])

  // 生成所有文件夹的 ContextItem
  const items = useMemo<ContextItem[]>(() => {
    return spaceFolders.map(({ id, state }) => ({
      type: 'tabfolder' as const,
      id,
      tabKey: contextRegistry.buildTabKey('tabfolder', id),
      title: resolveFolderTitle(state),
      meta: {
        path: state.rootPath,
        kind: state.kind,
        updatedAt: state.updatedAt
      }
    }))
  }, [spaceFolders, resolveFolderTitle])

  // 路径权限治理 Wave 3 第二轮独立验证 P0-1 修复：IPC 推送已下沉到 store
  // action（addSpaceFolder / removeFolder），本 hook 层只做闭包参数适配，
  // 不再做重复推送（避免双发 IPC 浪费 + 简化代码路径）。
  const openUserFolder = useCallback(
    (path: string) => {
      const title = getBaseName(path)
      const { folderId, isNew } = addSpaceFolder(spaceId, {
        rootPath: path,
        kind: 'user',
        title
      })
      return {
        tabKey: contextRegistry.buildTabKey('tabfolder', folderId),
        folderId,
        title,
        kind: 'user' as const,
        path,
        isNew,
      }
    },
    [addSpaceFolder, spaceId]
  )

  const openAgentFolder = useCallback(
    (path: string) => {
      const title = t('folder.labels.agentTitle')
      const { folderId, isNew } = addSpaceFolder(spaceId, {
        rootPath: path,
        kind: 'sandbox',
        title
      })
      return {
        tabKey: contextRegistry.buildTabKey('tabfolder', folderId),
        folderId,
        title,
        kind: 'sandbox' as const,
        path,
        isNew,
      }
    },
    [addSpaceFolder, spaceId, t]
  )

  const revokeFolder = useCallback(
    (folderId: string) => {
      removeFolder(folderId)
    },
    [removeFolder]
  )

  const refreshFolder = useCallback(
    (folderId: string) => {
      refreshFolderAction(folderId)
    },
    [refreshFolderAction]
  )

  const getFolderById = useCallback(
    (folderId: string): SpaceFolderState | null => {
      return folders[folderId] ?? userFolders[folderId] ?? null
    },
    [folders, userFolders]
  )

  return useMemo(
    () => ({
      items,
      openUserFolder,
      openAgentFolder,
      revokeFolder,
      refreshFolder,
      getFolderById
    }),
    [items, openAgentFolder, openUserFolder, revokeFolder, refreshFolder, getFolderById]
  )
}
