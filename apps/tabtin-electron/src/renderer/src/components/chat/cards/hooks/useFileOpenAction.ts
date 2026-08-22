/**
 * useFileOpenAction — 文件卡片打开/显示操作的通用 hook。
 *
 * 暴露四种操作：
 *   - `openInTabCode(filePath, { line?, gitDiffMode? })`：在内置 TabCode 预览打开文件。
 *     **项目根选择**：优先当前前台已打开、且包含该文件的 tabcode/tabfolder；
 *     否则文件所在 git 根；再否则 Agent `working_dir`。避免一点 Diff 就把侧栏
 *     拽回「默认工作空间」。外部路径先 `appendSessionAllowedPath`。
 *   - `revealInOsFileManager` / `openWithDefaultApp` / `copyPath`：系统级操作。
 *
 * **没硬绑 spaceId 参数的原因**：卡片在 chat 流里渲染，当前 selected space 在 ChatPanel
 * 顶层就已经选定，hook 内部从 useSpaceStore 直接读 selectedSpace.id 即可。
 */

import { useCallback } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useTabCodeStore } from '@components/tabcode/hooks/useTabCodeStore'
import { createLogger } from '@/utils/logger'
import { getRemoteExecutionAccess } from '@/services/remoteExecutionGuard'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { resolveForegroundTabScopeKey } from '../../subagent/openSubagentTab'

const log = createLogger('chat:FileOpen')

export function basename(p: string): string {
  if (!p) return ''
  const norm = p.replace(/\\/g, '/')
  return norm.split('/').filter(Boolean).pop() || norm
}

export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  const norm = p.replace(/\\/g, '/')
  return norm.startsWith('/') || /^[A-Za-z]:\//.test(norm)
}

export function normalizePath(p: string): string {
  const raw = p.replace(/\\/g, '/')
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

/** 用 working_dir 把相对 filePath 解成绝对路径（不存在 working_dir 时返回 null）。 */
export function resolveAgainstWorkingDir(filePath: string, workingDir: string | null | undefined): string | null {
  if (!workingDir) return null
  const normWD = normalizePath(workingDir)
  const normFile = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normWD) return null
  return normalizePath(`${normWD}/${normFile}`)
}

/** 文件卡片动作统一入口：相对路径必须先锚到 Agent working_dir。 */
export function resolveFileCardPath(filePath: string, workingDir: string | null | undefined): string {
  if (isAbsolutePath(filePath)) return filePath
  return resolveAgainstWorkingDir(filePath, workingDir) ?? filePath
}

/** 判断 absoluteFile 是否在 workingDir 子树内（含 workingDir 本身）。 */
export function isInsideWorkingDir(absoluteFile: string, workingDir: string): boolean {
  const normFile = normalizePath(absoluteFile)
  const normWD = normalizePath(workingDir)
  if (!normWD || !normFile) return false
  return normFile === normWD || normFile.startsWith(`${normWD}/`)
}

function encodeTabCodeId(localPath: string): string {
  return btoa(unescape(encodeURIComponent(localPath)))
}

export function dirnamePath(filePath: string): string {
  const norm = normalizePath(filePath)
  const idx = norm.lastIndexOf('/')
  if (idx <= 0) return norm.startsWith('/') ? '/' : norm
  return norm.slice(0, idx) || '/'
}

interface RevealTabTarget {
  rootPath: string
  type: 'tabcode' | 'tabfolder'
  id: string
  title: string
}

/** 在前台 scope 已打开的 tabcode/tabfolder 里，找包含该文件的最合适根（优先 active、再最长路径）。 */
export function findContainingOpenTabRoot(
  absoluteFilePath: string,
  tabScopeKey: string,
): RevealTabTarget | null {
  const tabs = useSpaceContextTabsStore.getState()
  const items = tabs.itemsBySpace[tabScopeKey] || {}
  const activeKey = tabs.getActiveKey(tabScopeKey)
  const candidates: RevealTabTarget[] = []

  for (const item of Object.values(items)) {
    if (!item || (item.type !== 'tabcode' && item.type !== 'tabfolder')) continue
    const root = normalizePath(String(item.meta?.path || ''))
    if (!root) continue
    if (!isInsideWorkingDir(absoluteFilePath, root)) continue
    candidates.push({
      rootPath: root,
      type: item.type,
      id: item.id,
      title: item.title || basename(root) || 'TabCode',
    })
  }
  if (candidates.length === 0) return null

  if (activeKey) {
    const active = items[activeKey]
    if (active) {
      const hit = candidates.find((c) => c.id === active.id && c.type === active.type)
      if (hit) return hit
    }
  }

  candidates.sort((a, b) => b.rootPath.length - a.rootPath.length)
  return candidates[0] ?? null
}

/** 从文件路径向上找最近的 git 仓库根；找不到则 null。 */
export async function findNearestGitRoot(absoluteFilePath: string): Promise<string | null> {
  const git = window.tabtin?.git
  const fs = window.tabtin?.fileSystem
  let dir = dirnamePath(absoluteFilePath)
  for (let i = 0; i < 48 && dir; i++) {
    try {
      if (git?.isGitRepo) {
        const result = await git.isGitRepo(dir)
        if (result?.success && result.isRepo) return dir
      } else if (fs?.pathExists) {
        const probe = await fs.pathExists(`${dir}/.git`)
        if (probe?.exists) return dir
      }
    } catch {
      // 继续向上
    }
    if (dir === '/' || /^[A-Za-z]:\/?$/.test(dir)) break
    const parent = dirnamePath(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function remoteFileUnavailableCopy(
  t: ReturnType<typeof useTranslation>['t'],
  spaceId: string | null | undefined,
): { title: string; description: string } | null {
  const remote = getRemoteExecutionAccess(spaceId)
  if (!remote.isRemoteViewer) return null
  const title = t('card.openFile.remoteUnavailableTitle', {
    defaultValue: '文件在远程设备上',
  })
  const description = remote.controlDeviceName
    ? t('card.openFile.remoteUnavailableWithDevice', {
        device: remote.controlDeviceName,
        defaultValue: '这个文件属于「{{device}}」上的工作空间。当前设备只能查看消息，不能直接打开或定位该文件。',
      })
    : t('card.openFile.remoteUnavailableNoDevice', {
        defaultValue: '这个文件属于工作空间的执行设备。当前设备只能查看消息，不能直接打开或定位该文件。',
      })
  return { title, description }
}

function toastRemoteFileUnavailable(
  t: ReturnType<typeof useTranslation>['t'],
  spaceId: string | null | undefined,
): boolean {
  const copy = remoteFileUnavailableCopy(t, spaceId)
  if (!copy) return false
  toast({
    title: copy.title,
    description: copy.description,
  })
  return true
}

/** 从当前 spaceState + spaceId 拿到对应 Agent 的 working_dir（无则空字符串）。 */
function pickAgentWorkingDir(spaceState: ReturnType<typeof useSpaceStore.getState>, spaceId: string): string {
  const sp = spaceState.spaces.find((s) => s.id === spaceId)
  if (sp?.working_dir) return sp.working_dir
  const agentId = sp?.type === 'workspace' ? (sp.execution_agent_id ?? sp.agent_id ?? null) : null
  const agent = agentId
    ? (spaceState.agentCache[agentId] ?? (spaceState.selectedAgent?.id === agentId ? spaceState.selectedAgent : null))
    : null
  return agent?.working_dir ?? ''
}

export interface OpenInTabCodeOptions {
  tabScopeKey?: string | null
  /** 1-based 行号；打开后滚到该行（如 DiffCard 的 startLine）。 */
  line?: number
  endLine?: number
  /** DiffCard：预览用 Monaco Diff 突出变更。 */
  gitDiffMode?: 'head' | 'staged' | 'unstaged'
}

export interface FileOpenActions {
  openInTabCode: (filePath: string, options?: OpenInTabCodeOptions) => Promise<void>
  revealInOsFileManager: (filePath: string) => Promise<void>
  openWithDefaultApp: (filePath: string) => Promise<void>
  copyPath: (filePath: string) => Promise<void>
}

export function useFileOpenAction(): FileOpenActions {
  const { t } = useTranslation('chat')

  const openInTabCode = useCallback(async (filePath: string, options?: OpenInTabCodeOptions) => {
    if (!filePath) return
    const spaceState = useSpaceStore.getState()
    const spaceId = spaceState.selectedSpace?.id
    if (!spaceId) {
      log.warn('[openInTabCode] no selected space, skip', { filePath })
      toast({
        title: t('card.openFile.noSpace', { defaultValue: '尚未选择 Space，无法打开文件' }),
        variant: 'destructive',
      })
      return
    }
    if (toastRemoteFileUnavailable(t, spaceId)) return

    const workingDir = pickAgentWorkingDir(spaceState, spaceId)
    if (!workingDir) {
      log.warn('[openInTabCode] agent has no working_dir, skip', { filePath, spaceId })
      toast({
        title: t('card.openFile.noWorkingDir', {
          defaultValue: 'Agent 还没设置工作目录，无法在 TabCode 中打开',
        }),
        variant: 'destructive',
      })
      return
    }

    // 相对路径锚定到 working_dir 转成绝对路径
    const absoluteFilePath = normalizePath(resolveFileCardPath(filePath, workingDir))
    const line = options?.line && options.line > 0 ? options.line : undefined
    const endLine = options?.endLine && options.endLine > 0 ? options.endLine : undefined
    const gitDiffMode = options?.gitDiffMode

    const targetTabScopeKey =
      options?.tabScopeKey || resolveForegroundTabScopeKey(spaceId) || spaceId
    expandCanvasForScope(targetTabScopeKey)

    // 根目录优先级：已打开且包含文件的 tab → 文件所在 git 根 → working_dir
    const openHit = findContainingOpenTabRoot(absoluteFilePath, targetTabScopeKey)
    let target: RevealTabTarget
    if (openHit) {
      target = openHit
    } else if (isInsideWorkingDir(absoluteFilePath, workingDir)) {
      const rootPath = normalizePath(workingDir)
      target = {
        rootPath,
        type: 'tabcode',
        id: encodeTabCodeId(rootPath),
        title: basename(rootPath) || 'TabCode',
      }
    } else {
      const gitRoot = await findNearestGitRoot(absoluteFilePath)
      const rootPath = gitRoot || dirnamePath(absoluteFilePath)
      target = {
        rootPath,
        type: 'tabcode',
        id: encodeTabCodeId(rootPath),
        title: basename(rootPath) || 'TabCode',
      }
    }

    // 根不在 working_dir 内时 session 授权（文件 + 根），否则预览/树可能被拒。
    if (!isInsideWorkingDir(absoluteFilePath, workingDir) || !isInsideWorkingDir(target.rootPath, workingDir)) {
      log.info('[openInTabCode] session allow for reveal root/file', {
        filePath: absoluteFilePath,
        rootPath: target.rootPath,
        workingDir,
      })
      try {
        await window.tabtin?.workspace?.appendSessionAllowedPath?.({
          spaceId,
          path: absoluteFilePath,
        })
        if (target.rootPath !== absoluteFilePath) {
          await window.tabtin?.workspace?.appendSessionAllowedPath?.({
            spaceId,
            path: target.rootPath,
          })
        }
      } catch (err) {
        log.warn('[openInTabCode] appendSessionAllowedPath failed', err)
        toast({
          title: t('card.openFile.openFailed', { defaultValue: '无法授权打开该文件' }),
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
        return
      }
    }

    // **先**写 pendingReveal 再 openResourceTab
    useTabCodeStore.getState().setPendingReveal(target.rootPath, {
      filePath: absoluteFilePath,
      line,
      endLine,
      gitDiffMode,
      requestId: Date.now(),
    })
    log.info('[openInTabCode] open tab + pending reveal', {
      rootPath: target.rootPath,
      tabType: target.type,
      filePath: absoluteFilePath,
      line,
      gitDiffMode,
      tabScopeKey: targetTabScopeKey,
      reusedOpenTab: Boolean(openHit),
    })
    useSpaceContextTabsStore.getState().openResourceTab(targetTabScopeKey, {
      type: target.type,
      id: target.id,
      title: target.title,
      meta: target.type === 'tabfolder'
        ? { path: target.rootPath, kind: 'user', spaceId }
        : { path: target.rootPath, spaceId },
    })
  }, [t])

  const revealInOsFileManager = useCallback(async (filePath: string) => {
    if (!filePath) return
    const showItemInFolder = window.tabtin?.showItemInFolder
    if (!showItemInFolder) {
      toast({
        title: t('card.openFile.unsupported', { defaultValue: '当前环境不支持系统级文件操作' }),
        variant: 'destructive',
      })
      return
    }
    try {
      const spaceState = useSpaceStore.getState()
      const spaceId = spaceState.selectedSpace?.id
      if (toastRemoteFileUnavailable(t, spaceId)) return
      const workingDir = spaceId ? pickAgentWorkingDir(spaceState, spaceId) : ''
      const resolvedPath = resolveFileCardPath(filePath, workingDir)
      const result = await showItemInFolder(resolvedPath)
      if (!result?.success) {
        throw new Error(result?.error || 'unknown')
      }
    } catch (err) {
      log.warn('[revealInOsFileManager] failed', err)
      toast({
        title: t('card.openFile.revealFailed', { defaultValue: '在文件管理器中显示失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [t])

  const openWithDefaultApp = useCallback(async (filePath: string) => {
    if (!filePath) return
    const openPath = window.tabtin?.openPath
    if (!openPath) {
      toast({
        title: t('card.openFile.unsupported', { defaultValue: '当前环境不支持系统级文件操作' }),
        variant: 'destructive',
      })
      return
    }
    try {
      const spaceState = useSpaceStore.getState()
      const spaceId = spaceState.selectedSpace?.id
      if (toastRemoteFileUnavailable(t, spaceId)) return
      const workingDir = spaceId ? pickAgentWorkingDir(spaceState, spaceId) : ''
      const resolvedPath = resolveFileCardPath(filePath, workingDir)
      const result = await openPath(resolvedPath)
      if (!result?.success) {
        throw new Error(result?.error || 'unknown')
      }
    } catch (err) {
      log.warn('[openWithDefaultApp] failed', err)
      toast({
        title: t('card.openFile.openFailed', { defaultValue: '用系统默认应用打开失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [t])

  const copyPath = useCallback(async (filePath: string) => {
    if (!filePath) return
    try {
      await navigator.clipboard.writeText(filePath)
      toast({ title: t('card.openFile.copied', { defaultValue: '路径已复制' }) })
    } catch (err) {
      log.warn('[copyPath] failed', err)
      toast({
        title: t('card.openFile.copyFailed', { defaultValue: '复制路径失败' }),
        variant: 'destructive',
      })
    }
  }, [t])

  return { openInTabCode, revealInOsFileManager, openWithDefaultApp, copyPath }
}
