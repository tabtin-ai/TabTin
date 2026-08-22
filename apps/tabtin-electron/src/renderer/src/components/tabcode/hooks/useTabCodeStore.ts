/**
 * TabCode 状态管理 — 单根契约下的 per-Space 工作状态
 *
 * 单根契约（见 `docs/single-root-space-prd.md` §2.1）：每个 Space 只有一个执行根
 * = 该 Space 绑定 Agent 的 `working_dir`。本 store 不再持有"代码项目列表"，
 * 只管理跟 working_dir 紧耦合的 UX 状态：
 *
 *   - 钉住的文件（pinnedItems）：用户在文件树里钉住的文件/目录
 *   - 预览历史（previewHistory）：最近预览过的文件路径
 *   - Git context（gitContextByPath）：每个 root 的分支 / 改动信息
 *   - PendingReveal（pendingRevealByRootPath）：chat → TabCode reveal 文件的 transient 通道
 *
 * pinnedItems / previewHistory 都按 rootPath 分桶——单根契约下大多数时候只有
 * working_dir 一个 root，但 Worktree 跳转（PRD §2.5 合法例外）会让同一 Space
 * 短时间内出现 sibling worktree 路径，按 rootPath 分桶让 worktree 切换不互相
 * 污染钉住列表。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PERSIST_KEYS } from '@stores/persist-key-registry'
import type { SplitSide } from '@/utils/split-layout'
import {
  activateEditorGroupFile,
  closeEditorGroupFile,
  createEditorWorkspace,
  pinEditorGroup,
  unpinEditorGroup,
  splitEmptyEditorGroup,
  moveEditorFile,
  normalizeEditorWorkspace,
  openFileInEditorGroup,
  reorderEditorGroupFile,
  setEditorLayoutSplitSizes,
  splitEditorGroupWithFile,
  type TabCodeEditorWorkspace,
} from '../utils/editorGroupLayout'

/** Git context for a code project (written by TabCodePaneHost, read by ChatPanel). */
export interface CodeProjectGitContext {
  branch: string | null
  changedFiles: string[]
  selectedFile: string | null
}

export interface TabCodePinnedItem {
  path: string
  name: string
  isDirectory: boolean
}

/** chat DiffCard / 文件卡 → TabCode 的一次性 reveal 载荷。 */
export interface TabCodePendingReveal {
  filePath: string
  /** 1-based 行号；打开后滚到该行（diff 起始行）。 */
  line?: number
  /** DiffCard 结束行；预览 Diff 视图滚到变更区时用。 */
  endLine?: number
  /** 有值时预览走 Monaco Diff（HEAD/暂存 vs 工作区），突出 Agent 改动。 */
  gitDiffMode?: 'head' | 'staged' | 'unstaged'
  /** store 会归一化为进程内唯一的递增编号，避免同毫秒请求碰撞。 */
  requestId: number
}

/** 画布轨 / Changes「提交或推送」→ TabCode 侧栏激活意图（transient）。 */
export type TabCodeSidebarTab = 'files' | 'git' | 'search'

export interface TabCodeWorkspaceSession extends TabCodeEditorWorkspace {
  /** 已展开的目录绝对路径。 */
  expandedDirs: string[]
  /** 最近关闭的文件，最新项在前。 */
  recentlyClosedFiles: string[]
  /** 每个编辑器分栏当前保留的预览文件。 */
  previewFilesByGroup: Record<string, string>
  /** 预览文件是否正在对应分栏中显示。 */
  previewActiveByGroup: Record<string, boolean>
}

const EMPTY_WORKSPACE_SESSION: TabCodeWorkspaceSession = {
  ...createEditorWorkspace(),
  expandedDirs: [],
  recentlyClosedFiles: [],
  previewFilesByGroup: {},
  previewActiveByGroup: {},
}

const MAX_RECENTLY_CLOSED_FILES = 50
let latestPendingRevealRequestId = 0
let latestPendingSidebarRequestId = 0

function nextPendingRevealRequestId(requestId?: number): number {
  latestPendingRevealRequestId = Math.max(
    latestPendingRevealRequestId + 1,
    requestId ?? 0,
    Date.now(),
  )
  return latestPendingRevealRequestId
}

function nextPendingSidebarRequestId(requestId?: number): number {
  latestPendingSidebarRequestId = Math.max(
    latestPendingSidebarRequestId + 1,
    requestId ?? 0,
    Date.now(),
  )
  return latestPendingSidebarRequestId
}

/** 画布轨「提交或推送」等 → TabCode 侧栏的一次性跳转意图。 */
export interface TabCodePendingSidebarTab {
  tab: TabCodeSidebarTab
  /** 每次点击递增，keep-alive 重激活时也能触发跳转。 */
  requestId: number
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function normalizeSession(session: Partial<TabCodeWorkspaceSession>): TabCodeWorkspaceSession {
  const workspace = normalizeEditorWorkspace(session)
  const previewFilesByGroup = Object.fromEntries(
    Object.entries(session.previewFilesByGroup ?? {}).filter(([groupId, filePath]) => (
      Boolean(filePath)
      && Boolean(workspace.groupsById[groupId])
      && !workspace.groupsById[groupId].openFiles.includes(filePath)
    )),
  )
  return {
    ...workspace,
    expandedDirs: dedupePaths(session.expandedDirs ?? []),
    recentlyClosedFiles: dedupePaths(session.recentlyClosedFiles ?? []).slice(0, MAX_RECENTLY_CLOSED_FILES),
    previewFilesByGroup,
    previewActiveByGroup: Object.fromEntries(
      Object.entries(session.previewActiveByGroup ?? {}).filter(([groupId, active]) => (
        active === true && groupId in previewFilesByGroup
      )),
    ),
  }
}

function updateWorkspaceSession(
  sessions: Record<string, TabCodeWorkspaceSession>,
  sessionKey: string,
  update: (session: TabCodeWorkspaceSession) => TabCodeWorkspaceSession,
): Record<string, TabCodeWorkspaceSession> {
  const current = sessions[sessionKey] ?? EMPTY_WORKSPACE_SESSION
  return { ...sessions, [sessionKey]: update(current) }
}

/** 与 useFileOpenAction.normalizePath 对齐：pending reveal 的 map key 必须两边同算法。 */
export function normalizeTabCodeRootKey(rootPath: string): string {
  const raw = rootPath.replace(/\\/g, '/')
  const drive = raw.match(/^([A-Za-z]:)(?:\/|$)/)?.[1] ?? ''
  const absoluteRoot = drive ? '' : (raw.startsWith('/') ? '/' : '')
  const prefix = drive || absoluteRoot
  let rest = raw.slice(prefix.length)
  if (drive && rest.startsWith('/')) rest = rest.slice(1)

  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop()
      } else if (!prefix) {
        parts.push(segment)
      }
      continue
    }
    parts.push(segment)
  }

  const normalizedRest = parts.join('/')
  if (drive) return normalizedRest ? `${drive}/${normalizedRest}` : `${drive}/`
  if (absoluteRoot) return normalizedRest ? `/${normalizedRest}` : '/'
  return normalizedRest
}

/** TabCode 的 IDE 现场按工作台 scope 与稳定资源身份隔离。 */
export function getTabCodeWorkspaceSessionKey(
  tabScopeKey: string | null | undefined,
  resourceId: string | null | undefined,
  rootPath: string,
): string {
  const scope = tabScopeKey || 'default'
  const resource = resourceId || normalizeTabCodeRootKey(rootPath)
  return `${scope}\0${resource}`
}

/** v1 曾遗漏 scope 的持久化会话键；仅用于一次性迁移。 */
export function getUnscopedTabCodeWorkspaceSessionKey(
  _tabScopeKey: string | null | undefined,
  resourceId: string | null | undefined,
  rootPath: string,
): string {
  const resource = resourceId || normalizeTabCodeRootKey(rootPath)
  return `resource\0${resource}`
}

interface TabCodeState {
  /** rootPath → pinned 文件/目录（最多 50 条） */
  pinnedItemsByRootPath: Record<string, TabCodePinnedItem[]>

  /** rootPath → 最近预览文件路径（最多 20 条） */
  previewHistoryByRootPath: Record<string, string[]>

  /** code project path → git context (live, not persisted) */
  gitContextByPath: Record<string, CodeProjectGitContext>

  /**
   * **rootPath → 待 reveal 载荷**（transient，不持久化）。
   *
   * 来源：`useFileOpenAction.openInTabCode(filePath, { line })` 调用时注入，
   * rootPath = working_dir（单根；外部文件也挂在此 root 下预览，不挂第二根）。
   *
   * 消费：`TabCodePaneHost` mount + `pathStatus === 'exists'` 后立即调
   * `consumePendingReveal(rootPath)`，拿到载荷 → setSelectedFile / selectedLine
   * + 清空该 rootPath 的 entry。**消费一次**契约保证用户后续手动切换文件时
   * 不会被重新覆盖。
   */
  pendingRevealByRootPath: Record<string, TabCodePendingReveal>

  /**
   * rootPath → 待激活侧栏标签（transient，含 requestId）。
   * 画布轨「提交或推送」写入 `git`；TabCodePaneHost 消费一次后清除。
   */
  pendingSidebarTabByRootPath: Record<string, TabCodePendingSidebarTab>

  /** 工作台 scope + TabCode 资源 → IDE 文件现场。 */
  workspaceSessionsByKey: Record<string, TabCodeWorkspaceSession>

  /** 钉住文件或目录 */
  pinItem: (rootPath: string, item: TabCodePinnedItem) => void

  /** 取消钉住文件或目录 */
  unpinItem: (rootPath: string, path: string) => void

  /** 切换钉住状态 */
  togglePinItem: (rootPath: string, item: TabCodePinnedItem) => void

  /** 记录最近预览文件 */
  pushPreviewHistory: (rootPath: string, filePath: string) => void

  /** Update git context for a project path (called from TabCodePaneHost) */
  setGitContext: (path: string, ctx: CodeProjectGitContext) => void

  /**
   * 设置待 reveal 的 file（由 useFileOpenAction.openInTabCode 调用）。
   * 兼容旧调用：第二个参数可直接传 filePath 字符串。
   */
  setPendingReveal: (rootPath: string, reveal: TabCodePendingReveal | string) => void

  /**
   * 取出并清除某个 rootPath 的 pending reveal——消费一次的语义。
   * 传入 requestId 时仅消费当前请求，避免较早异步请求吞掉后来的 reveal。
   * 返回值：载荷或 null（无待 reveal）。
   */
  consumePendingReveal: (rootPath: string, requestId?: number) => TabCodePendingReveal | null

  setPendingSidebarTab: (rootPath: string, tab: TabCodeSidebarTab) => void
  /** 传入 requestId 时仅消费匹配请求，避免旧异步逻辑吞掉新点击。 */
  consumePendingSidebarTab: (
    rootPath: string,
    requestId?: number,
  ) => TabCodePendingSidebarTab | null

  /** 在指定或当前编辑器分组打开文件（已打开时只激活），并把它移出最近关闭历史。 */
  openFileInWorkspaceSession: (sessionKey: string, filePath: string, groupId?: string) => void
  /** 激活分组中的标签。 */
  activateWorkspaceFile: (sessionKey: string, groupId: string, filePath: string) => void
  /** 关闭分组中的标签，自动选择相邻标签并记录最近关闭。 */
  closeFileInWorkspaceSession: (sessionKey: string, groupId: string, filePath: string) => void
  /**
   * 将文件记入最近关闭（预览关闭/被替换时用）。
   * 若该文件仍作为固定标签打开，则跳过，避免「还开着却出现在最近关闭」。
   */
  pushRecentlyClosedFile: (sessionKey: string, filePath: string) => void
  /** 让一个编辑器分组成为后续打开文件的目标。 */
  setActiveWorkspaceEditorGroup: (sessionKey: string, groupId: string) => void
  /** 将标签移动到已有的编辑器分组。 */
  moveWorkspaceFile: (
    sessionKey: string,
    sourceGroupId: string,
    targetGroupId: string,
    filePath: string,
    targetFilePath?: string | null,
    position?: 'before' | 'after',
  ) => void
  /** 在同一编辑器分组内调整标签顺序。 */
  reorderWorkspaceFile: (
    sessionKey: string,
    groupId: string,
    sourceFilePath: string,
    targetFilePath: string,
    position?: 'before' | 'after',
  ) => void
  /** 在目标编辑器分组的指定边缘创建一个嵌套分屏。 */
  splitWorkspaceFile: (
    sessionKey: string,
    sourceGroupId: string,
    targetGroupId: string,
    filePath: string,
    side: SplitSide,
  ) => void
  /** 钉住空分组，避免只挂 History 时被 normalize 折叠。 */
  pinWorkspaceEditorGroup: (sessionKey: string, groupId: string) => void
  /** 取消钉住；若该组没有打开的文件，会折叠分屏。 */
  unpinWorkspaceEditorGroup: (sessionKey: string, groupId: string) => void
  /** 在目标分组边缘拆出一个空分组，返回新分组 id。 */
  splitEmptyWorkspaceGroup: (
    sessionKey: string,
    targetGroupId: string,
    side: SplitSide,
  ) => string | null
  /** 持久化指定 split 节点的分隔比例。 */
  setWorkspaceSplitSizes: (sessionKey: string, path: number[], sizes: number[]) => void
  /** 设置分栏预览文件；传 null 时清除该分栏预览。 */
  setWorkspacePreview: (
    sessionKey: string,
    groupId: string,
    filePath: string | null,
    active: boolean,
  ) => void
  /** 将 v1 未按 scope 隔离的会话一次性迁移到当前 scope。 */
  adoptUnscopedWorkspaceSession: (sessionKey: string, unscopedSessionKey: string) => void
  /** 文件树展开状态完整同步。 */
  setExpandedDirsForWorkspaceSession: (sessionKey: string, paths: string[]) => void
  /** 从所有会话子状态中移除已失效文件或目录（包含子路径）。 */
  pruneWorkspaceSessionPaths: (sessionKey: string, invalidPaths: string[]) => void
}

export const useTabCodeStore = create<TabCodeState>()(
  persist(
    (set, get) => ({
      pinnedItemsByRootPath: {},
      previewHistoryByRootPath: {},
      gitContextByPath: {},
      pendingRevealByRootPath: {},
      pendingSidebarTabByRootPath: {},
      workspaceSessionsByKey: {},

      pinItem: (rootPath, item) =>
        set((state) => {
          const current = state.pinnedItemsByRootPath[rootPath] || []
          const deduped = current.filter((entry) => entry.path !== item.path)
          return {
            pinnedItemsByRootPath: {
              ...state.pinnedItemsByRootPath,
              [rootPath]: [item, ...deduped].slice(0, 50),
            },
          }
        }),

      unpinItem: (rootPath, path) =>
        set((state) => {
          const current = state.pinnedItemsByRootPath[rootPath] || []
          const next = current.filter((entry) => entry.path !== path)
          return {
            pinnedItemsByRootPath: {
              ...state.pinnedItemsByRootPath,
              [rootPath]: next,
            },
          }
        }),

      togglePinItem: (rootPath, item) =>
        set((state) => {
          const current = state.pinnedItemsByRootPath[rootPath] || []
          const exists = current.some((entry) => entry.path === item.path)
          const next = exists
            ? current.filter((entry) => entry.path !== item.path)
            : [item, ...current].filter(
                (entry, index, arr) => arr.findIndex((it) => it.path === entry.path) === index
              ).slice(0, 50)
          return {
            pinnedItemsByRootPath: {
              ...state.pinnedItemsByRootPath,
              [rootPath]: next,
            },
          }
        }),

      pushPreviewHistory: (rootPath, filePath) =>
        set((state) => {
          const current = state.previewHistoryByRootPath[rootPath] || []
          const next = [filePath, ...current.filter((path) => path !== filePath)].slice(0, 20)
          return {
            previewHistoryByRootPath: {
              ...state.previewHistoryByRootPath,
              [rootPath]: next,
            },
          }
        }),

      setGitContext: (codePath, ctx) =>
        set((state) => ({
          gitContextByPath: { ...state.gitContextByPath, [codePath]: ctx },
        })),

      setPendingReveal: (rootPath, reveal) => {
        const key = normalizeTabCodeRootKey(rootPath)
        if (!key) return
        const payload: TabCodePendingReveal = typeof reveal === 'string'
          ? { filePath: reveal, requestId: nextPendingRevealRequestId() }
          : {
              filePath: reveal.filePath,
              line: reveal.line,
              endLine: reveal.endLine,
              gitDiffMode: reveal.gitDiffMode,
              requestId: nextPendingRevealRequestId(reveal.requestId),
            }
        if (!payload.filePath) return
        set((state) => ({
          pendingRevealByRootPath: {
            ...state.pendingRevealByRootPath,
            [key]: payload,
          },
        }))
      },

      setPendingSidebarTab: (rootPath, tab) => {
        const key = normalizeTabCodeRootKey(rootPath)
        if (!key) return
        const payload: TabCodePendingSidebarTab = {
          tab,
          requestId: nextPendingSidebarRequestId(),
        }
        set((state) => ({
          pendingSidebarTabByRootPath: {
            ...state.pendingSidebarTabByRootPath,
            [key]: payload,
          },
        }))
      },

      consumePendingSidebarTab: (rootPath, requestId) => {
        const key = normalizeTabCodeRootKey(rootPath)
        const current = get().pendingSidebarTabByRootPath[key]
          ?? get().pendingSidebarTabByRootPath[rootPath]
        if (!current) return null
        if (requestId != null && current.requestId !== requestId) return null
        set((state) => {
          const next = { ...state.pendingSidebarTabByRootPath }
          delete next[key]
          delete next[rootPath]
          return { pendingSidebarTabByRootPath: next }
        })
        return current
      },

      consumePendingReveal: (rootPath, requestId) => {
        const key = normalizeTabCodeRootKey(rootPath)
        const current = get().pendingRevealByRootPath[key]
          ?? get().pendingRevealByRootPath[rootPath]
        if (!current) return null
        if (requestId != null && current.requestId !== requestId) return null
        // 消费即清除——下次 mount 不再重复触发，用户手动选了别的文件后切回也不会被覆盖
        set((state) => {
          const next = { ...state.pendingRevealByRootPath }
          delete next[key]
          delete next[rootPath]
          return { pendingRevealByRootPath: next }
        })
        return current
      },

      openFileInWorkspaceSession: (sessionKey, filePath, groupId) => {
        if (!sessionKey || !filePath) return
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...openFileInEditorGroup(
                current,
                groupId ?? current.activeGroupId,
                filePath,
              ),
              recentlyClosedFiles: current.recentlyClosedFiles.filter((path) => path !== filePath),
            }),
          ),
        }))
      },

      activateWorkspaceFile: (sessionKey, groupId, filePath) => {
        set((state) => {
          const current = state.workspaceSessionsByKey[sessionKey]
          if (!current) return state
          return {
            workspaceSessionsByKey: {
              ...state.workspaceSessionsByKey,
              [sessionKey]: { ...current, ...activateEditorGroupFile(current, groupId, filePath) },
            },
          }
        })
      },

      closeFileInWorkspaceSession: (sessionKey, groupId, filePath) => {
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => {
              if (!current.groupsById[groupId]?.openFiles.includes(filePath)) return current
              const nextWorkspace = closeEditorGroupFile(current, groupId, filePath)
              const remainsOpen = Object.values(nextWorkspace.groupsById)
                .some((group) => group.openFiles.includes(filePath))
              return {
                ...current,
                ...nextWorkspace,
                recentlyClosedFiles: remainsOpen
                  ? current.recentlyClosedFiles
                  : [filePath, ...current.recentlyClosedFiles.filter((path) => path !== filePath)]
                    .slice(0, MAX_RECENTLY_CLOSED_FILES),
              }
            },
          ),
        }))
      },

      pushRecentlyClosedFile: (sessionKey, filePath) => {
        if (!sessionKey || !filePath) return
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => {
              const stillOpen = Object.values(current.groupsById)
                .some((group) => group.openFiles.includes(filePath))
              if (stillOpen) return current
              return {
                ...current,
                recentlyClosedFiles: [
                  filePath,
                  ...current.recentlyClosedFiles.filter((path) => path !== filePath),
                ].slice(0, MAX_RECENTLY_CLOSED_FILES),
              }
            },
          ),
        }))
      },

      setActiveWorkspaceEditorGroup: (sessionKey, groupId) => {
        set((state) => {
          const current = state.workspaceSessionsByKey[sessionKey]
          if (!current?.groupsById[groupId] || current.activeGroupId === groupId) return state
          return {
            workspaceSessionsByKey: {
              ...state.workspaceSessionsByKey,
              [sessionKey]: { ...current, activeGroupId: groupId },
            },
          }
        })
      },

      moveWorkspaceFile: (
        sessionKey,
        sourceGroupId,
        targetGroupId,
        filePath,
        targetFilePath,
        position,
      ) => {
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...moveEditorFile(
                current,
                sourceGroupId,
                targetGroupId,
                filePath,
                targetFilePath,
                position,
              ),
            }),
          ),
        }))
      },

      reorderWorkspaceFile: (sessionKey, groupId, sourceFilePath, targetFilePath, position) => {
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...reorderEditorGroupFile(current, groupId, sourceFilePath, targetFilePath, position),
            }),
          ),
        }))
      },

      splitWorkspaceFile: (sessionKey, sourceGroupId, targetGroupId, filePath, side) => {
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...splitEditorGroupWithFile(current, sourceGroupId, targetGroupId, filePath, side),
            }),
          ),
        }))
      },

      pinWorkspaceEditorGroup: (sessionKey, groupId) => {
        if (!sessionKey || !groupId) return
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...pinEditorGroup(current, groupId),
            }),
          ),
        }))
      },

      unpinWorkspaceEditorGroup: (sessionKey, groupId) => {
        if (!sessionKey || !groupId) return
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...unpinEditorGroup(current, groupId),
            }),
          ),
        }))
      },

      splitEmptyWorkspaceGroup: (sessionKey, targetGroupId, side) => {
        if (!sessionKey || !targetGroupId) return null
        let createdId: string | null = null
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => {
              const next = splitEmptyEditorGroup(current, targetGroupId, side)
              if (next === current) {
                createdId = null
                return current
              }
              createdId = next.activeGroupId
              return { ...current, ...next }
            },
          ),
        }))
        return createdId
      },

      setWorkspaceSplitSizes: (sessionKey, path, sizes) => {
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({
              ...current,
              ...setEditorLayoutSplitSizes(current, path, sizes),
            }),
          ),
        }))
      },

      setWorkspacePreview: (sessionKey, groupId, filePath, active) => {
        if (!sessionKey || !groupId) return
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => {
              if (!current.groupsById[groupId]) return current
              const previewFilesByGroup = { ...current.previewFilesByGroup }
              const previewActiveByGroup = { ...current.previewActiveByGroup }
              if (
                filePath
                && !current.groupsById[groupId].openFiles.includes(filePath)
              ) {
                previewFilesByGroup[groupId] = filePath
                if (active) previewActiveByGroup[groupId] = true
                else delete previewActiveByGroup[groupId]
              } else {
                delete previewFilesByGroup[groupId]
                delete previewActiveByGroup[groupId]
              }
              return { ...current, previewFilesByGroup, previewActiveByGroup }
            },
          ),
        }))
      },

      adoptUnscopedWorkspaceSession: (sessionKey, unscopedSessionKey) => {
        if (!sessionKey || !unscopedSessionKey || sessionKey === unscopedSessionKey) return
        set((state) => {
          if (state.workspaceSessionsByKey[sessionKey]) return state
          const unscopedSession = state.workspaceSessionsByKey[unscopedSessionKey]
          if (!unscopedSession) return state
          const workspaceSessionsByKey = { ...state.workspaceSessionsByKey }
          delete workspaceSessionsByKey[unscopedSessionKey]
          return {
            workspaceSessionsByKey: {
              ...workspaceSessionsByKey,
              [sessionKey]: normalizeSession(unscopedSession),
            },
          }
        })
      },

      setExpandedDirsForWorkspaceSession: (sessionKey, paths) => {
        if (!sessionKey) return
        set((state) => ({
          workspaceSessionsByKey: updateWorkspaceSession(
            state.workspaceSessionsByKey,
            sessionKey,
            (current) => ({ ...current, expandedDirs: dedupePaths(paths) }),
          ),
        }))
      },

      pruneWorkspaceSessionPaths: (sessionKey, invalidPaths) => {
        const prefixes = dedupePaths(invalidPaths)
          .map((path) => normalizeTabCodeRootKey(path).replace(/\/+$/, ''))
          .filter(Boolean)
        if (!sessionKey || prefixes.length === 0) return

        const isInvalid = (path: string) => {
          const normalized = normalizeTabCodeRootKey(path).replace(/\/+$/, '')
          return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
        }

        set((state) => {
          const current = state.workspaceSessionsByKey[sessionKey]
          if (!current) return state
          const groupsById = Object.fromEntries(
            Object.entries(current.groupsById).map(([groupId, group]) => [
              groupId,
              {
                ...group,
                openFiles: group.openFiles.filter((path) => !isInvalid(path)),
                activeFile: group.activeFile && !isInvalid(group.activeFile)
                  ? group.activeFile
                  : null,
              },
            ]),
          )
          return {
            workspaceSessionsByKey: {
              ...state.workspaceSessionsByKey,
              [sessionKey]: normalizeSession({
                ...current,
                groupsById,
                expandedDirs: current.expandedDirs.filter((path) => !isInvalid(path)),
                recentlyClosedFiles: current.recentlyClosedFiles.filter((path) => !isInvalid(path)),
                previewFilesByGroup: Object.fromEntries(
                  Object.entries(current.previewFilesByGroup).filter(([, path]) => !isInvalid(path)),
                ),
                previewActiveByGroup: Object.fromEntries(
                  Object.entries(current.previewActiveByGroup).filter(([groupId]) => (
                    current.previewFilesByGroup[groupId] && !isInvalid(current.previewFilesByGroup[groupId])
                  )),
                ),
              }),
            },
          }
        })
      },
    }),
    {
      name: PERSIST_KEYS.tabCode,
      // v2：预览标签也成为会话工作现场的一部分。
      version: 2,
      partialize: (state) => ({
        pinnedItemsByRootPath: state.pinnedItemsByRootPath,
        previewHistoryByRootPath: state.previewHistoryByRootPath,
        workspaceSessionsByKey: Object.fromEntries(
          Object.entries(state.workspaceSessionsByKey).map(([key, session]) => [
            key,
            normalizeSession({ ...session, pinnedGroupIds: [] }),
          ]),
        ),
      }),
      // 单根契约升级（2026-05-18）：旧 persist 数据可能含 recentProjectsBySpace
      // 字段，迁移时直接丢弃；pinned/preview 字段保留。
      migrate: (persisted: unknown) => {
        const raw = persisted as {
          pinnedItemsByRootPath?: Record<string, TabCodePinnedItem[]>
          previewHistoryByRootPath?: Record<string, string[]>
          workspaceSessionsByKey?: Record<string, Partial<TabCodeWorkspaceSession>>
        }
        return {
          pinnedItemsByRootPath: raw.pinnedItemsByRootPath ?? {},
          previewHistoryByRootPath: raw.previewHistoryByRootPath ?? {},
          workspaceSessionsByKey: Object.fromEntries(
            Object.entries(raw.workspaceSessionsByKey ?? {}).map(([key, session]) => [
              key,
              normalizeSession({ ...session, pinnedGroupIds: [] }),
            ]),
          ),
        }
      },
    },
  ),
)
