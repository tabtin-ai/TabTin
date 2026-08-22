/**
 * 代码工作区 / Changes 标签的打开与根切换协调。
 *
 * Changes 是独立 Context 标签（type=tabchanges），数据根永远跟随当前会话绑定代码根；
 * 不修改 Workspace 长期 working_dir。
 */

import { contextRegistry } from '../registry'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { encodeTabCodeResourceId } from '../workspaceExecutionRootApp'
import { normalizePathForCompare } from '@components/tabcode/utils/worktreePaths'
import {
  normalizeTabCodeRootKey,
  useTabCodeStore,
  type TabCodeSidebarTab,
} from '@components/tabcode/hooks/useTabCodeStore'

export const CODE_CHANGES_TAB_TYPE = 'tabchanges' as const

export type CodeChangesViewId =
  | 'agent'
  | 'uncommitted'
  | 'staged'
  | 'unstaged'
  | 'history'

/** 工作台 Changes 打开时默认「最近 Agent 执行」。 */
export const DEFAULT_CODE_CHANGES_VIEW: CodeChangesViewId = 'agent'
let changesViewIntentSequence = 0

export function encodeCodeChangesResourceId(rootPath: string): string {
  return encodeTabCodeResourceId(rootPath)
}

export function buildCodeChangesTabKey(rootPath: string): string {
  return contextRegistry.buildTabKey(
    CODE_CHANGES_TAB_TYPE,
    encodeCodeChangesResourceId(rootPath),
  )
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export function openCodeChangesTab(input: {
  tabScopeKey: string
  spaceId?: string | null
  rootPath: string
  sessionId?: string | null
  initialView?: CodeChangesViewId
  /** 卡片点击时锁定的闭合 Agent 回合，避免详情异步跳到另一轮。 */
  agentTurnEndMessageId?: string | null
  /** 已打开的 Changes 保活时，仍需明确切到调用入口要求的视图。 */
  focusView?: CodeChangesViewId
  /** 已打开的 Changes 保活时，要求文件树与 Diff 定位到指定相对路径。 */
  focusRelativePath?: string | null
  /** 仅登记标签，不抢占当前画布焦点。 */
  silent?: boolean
}): void {
  const rootPath = input.rootPath.trim()
  if (!rootPath) return
  const focusRelativePath = input.focusRelativePath?.trim() || null
  const hasViewIntent = Boolean(input.focusView || focusRelativePath)
  const id = encodeCodeChangesResourceId(rootPath)
  useSpaceContextTabsStore.getState().openResourceTab(input.tabScopeKey, {
    type: CODE_CHANGES_TAB_TYPE,
    id,
    title: 'Changes',
    ...(input.silent ? { silent: true } : {}),
    meta: {
      path: rootPath,
      spaceId: input.spaceId ?? undefined,
      sessionId: input.sessionId ?? undefined,
      initialView: input.initialView ?? DEFAULT_CODE_CHANGES_VIEW,
      agentTurnEndMessageId: input.agentTurnEndMessageId ?? undefined,
      ...(hasViewIntent
        ? {
            requestedView: input.focusView ?? DEFAULT_CODE_CHANGES_VIEW,
            requestedRelativePath: focusRelativePath ?? undefined,
            viewIntentId: String(++changesViewIntentSequence),
          }
        : {}),
    },
  })
}

/** 打开 / 激活 TabCode，并请求侧栏切到 Git（Commit / Push）。 */
export function openTabCodeGitPanel(input: {
  tabScopeKey: string
  rootPath: string
}): void {
  const rootPath = input.rootPath.trim()
  if (!rootPath) return
  const id = encodeTabCodeResourceId(rootPath)
  // 先写 pending（含 requestId），再开标签——keep-alive 重激活依赖 requestId 变化。
  useTabCodeStore.getState().setPendingSidebarTab(rootPath, 'git')
  useSpaceContextTabsStore.getState().openResourceTab(input.tabScopeKey, {
    type: 'tabcode',
    id,
    title: basename(rootPath),
    meta: { path: rootPath, preferredView: 'code', initialSidebarTab: 'git' },
  })
}

if (typeof window !== 'undefined') {
  ;(window as unknown as {
    __TABTIN_OPEN_TABCODE_GIT__?: typeof openTabCodeGitPanel
  }).__TABTIN_OPEN_TABCODE_GIT__ = openTabCodeGitPanel
}

/**
 * worktree 切换后：关掉指向旧根的 Changes 标签，若原先有打开则在新根上重建。
 * 重建时不抢焦点，保留用户仍在查看 Changes 的意图。
 * 不改 Workspace working_dir。
 */
export function redirectCodeChangesTabsToRoot(input: {
  tabScopeKey: string
  spaceId: string
  nextRootPath: string
  sessionId?: string | null
  reopenIfAnyWereOpen?: boolean
}): void {
  const nextRoot = normalizePathForCompare(input.nextRootPath)
  if (!nextRoot) return

  const tabs = useSpaceContextTabsStore.getState()
  const items = tabs.itemsBySpace[input.tabScopeKey] || {}
  let hadOpen = false
  let hadActiveChanges = false
  const staleTabs: string[] = []

  for (const item of Object.values(items)) {
    if (item.type !== CODE_CHANGES_TAB_TYPE) continue
    const itemSessionId = typeof item.meta?.sessionId === 'string'
      ? item.meta.sessionId
      : null
    if (input.sessionId && itemSessionId !== input.sessionId) continue
    hadOpen = true
    if (tabs.activeKeyBySpace[input.tabScopeKey] === item.tabKey) {
      hadActiveChanges = true
    }
    const path = typeof item.meta?.path === 'string' ? item.meta.path : ''
    if (normalizePathForCompare(path) === nextRoot) continue
    staleTabs.push(item.tabKey)
  }

  if (input.reopenIfAnyWereOpen !== false && hadOpen) {
    openCodeChangesTab({
      tabScopeKey: input.tabScopeKey,
      spaceId: input.spaceId,
      rootPath: input.nextRootPath,
      sessionId: input.sessionId,
      silent: !hadActiveChanges,
    })
  }

  for (const tabKey of staleTabs) {
    tabs.closeTab(input.tabScopeKey, tabKey)
  }
}

/**
 * 静默把「旧会话代码根」对应的 TabCode 切到新根：
 * - 只匹配 meta.path === 旧根的 tabcode，不影响其他项目
 * - silent 登记新根，不改 active/display，不展开布局
 * - 再关旧根；若旧根当时是 active，fallback 到新根以保持仍在代码标签上
 * - 不直接改 meta / replaceTabKey（keep-alive、Monaco、Git 按路径缓存）
 */
export function silentlyRebindSessionTabCodeRoot(input: {
  tabScopeKey: string
  previousRootPath: string
  nextRootPath: string
  spaceId?: string
}): void {
  const previousRoot = normalizePathForCompare(input.previousRootPath)
  const nextRoot = normalizePathForCompare(input.nextRootPath)
  if (!previousRoot || !nextRoot || previousRoot === nextRoot) return

  const tabs = useSpaceContextTabsStore.getState()
  const items = tabs.itemsBySpace[input.tabScopeKey] || {}
  const matchingOld = Object.values(items).filter((item) => {
    if (item.type !== 'tabcode') return false
    const path = typeof item.meta?.path === 'string' ? item.meta.path : ''
    return normalizePathForCompare(path) === previousRoot
  })
  if (matchingOld.length === 0) return

  const nextId = encodeTabCodeResourceId(input.nextRootPath)
  const nextTabKey = contextRegistry.buildTabKey('tabcode', nextId)
  const activeKey = tabs.activeKeyBySpace[input.tabScopeKey] ?? null
  const wasOldActive = matchingOld.some((item) => item.tabKey === activeKey)

  tabs.openResourceTab(input.tabScopeKey, {
    type: 'tabcode',
    id: nextId,
    title: basename(input.nextRootPath),
    meta: {
      path: input.nextRootPath,
      preferredView: 'code',
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    },
    silent: true,
  })

  for (const item of matchingOld) {
    if (item.tabKey === nextTabKey) continue
    tabs.closeTab(
      input.tabScopeKey,
      item.tabKey,
      wasOldActive && item.tabKey === activeKey ? nextTabKey : undefined,
    )
  }
}

export function requestTabCodeSidebarTab(
  rootPath: string,
  tab: TabCodeSidebarTab,
): void {
  useTabCodeStore.getState().setPendingSidebarTab(rootPath, tab)
}

export function consumePendingSidebarTab(rootPath: string): TabCodeSidebarTab | null {
  return useTabCodeStore.getState().consumePendingSidebarTab(rootPath)?.tab ?? null
}

export function normalizeCodeRootKey(rootPath: string): string {
  return normalizeTabCodeRootKey(rootPath)
}
