/**
 * LocalDirAutoPane —— 本机目录的自动判定入口
 *
 * 目录是不是「Git 流程形态」由 `preferredView`（工作空间 working_dir_type）或
 * Git 仓库探测共同决定：
 *
 *   preferredView='code' → 默认 TabCode（IDE），用户开关可切回普通目录
 *   preferredView='folder' → 始终 FileExplorerPane
 *   未指定时（兼容旧入口）→ Git 仓库则 TabCode，否则 FileExplorerPane
 *
 * 用户的开关选择按目录路径持久化（`useGitFlowPreference`），覆盖 Space 绑定
 * 目录（`orchestration.tsx`）和用户手动添加目录（`folder.tsx` kind='user'）
 * 两个入口；Agent 沙箱目录（kind='sandbox'）和远程目录不接入本组件。
 *
 * 根路径失效：整页 LocalDirPathMissing（显式重绑），不静默空白。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileExplorerPane } from './FileExplorerPane'
import { LocalDirPathMissing, type LocalDirRelocateMode } from './LocalDirPathMissing'
import { useLocalDirRootHealth } from './useLocalDirRootHealth'
import { useFolderContextStore } from './useFolderStore'
import type { FolderContextKind } from './types'
import { useGitFlowPreference } from '@stores/useGitFlowPreference'
import { useTranslation } from 'react-i18next'
import { Button } from '@components/ui'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { createLogger } from '@/utils/logger'
import type { WorkspaceExecutionView } from '../workspaceExecutionRootApp'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { getBaseName } from './utils'
import { normalizePathSeparators } from '@components/shared/file-utils'
import type { ContextTabKey } from '../registry/types'

const log = createLogger('LocalDirAutoPane')

const loadTabCodePaneHost = () =>
  import('@components/tabcode/TabCodePaneHost').then(m => ({ default: m.TabCodePaneHost }))

const LazyTabCodePaneHost = React.lazy(loadTabCodePaneHost)

interface LocalDirAutoPaneProps {
  rootPath: string
  title: string
  revealPath?: string
  spaceId?: string | null
  resourceId?: string
  kind?: FolderContextKind
  requiresSessionAuthorization?: boolean
  /** 由工作空间 working_dir_type 决定的首屏视图；缺省时仍走 Git 仓库自动判定。 */
  preferredView?: WorkspaceExecutionView
  /** Chat 上下文焦点归属；二者同时存在时才上报。 */
  contextScopeKey?: string | null
  contextTabKey?: ContextTabKey | null
  /** 外层 Context 标签是否激活；保活 pane 隐藏时透传给 TabCode。 */
  isPaneActive?: boolean
}

type RepoProbeState = 'checking' | 'repo' | 'not-repo'
type SessionAccessState = 'authorizing' | 'ready' | 'failed'

function resolveRelocateMode(resourceId?: string): LocalDirRelocateMode {
  return resourceId?.startsWith('user::') ? 'user' : 'workspace'
}

export const LocalDirAutoPane: React.FC<LocalDirAutoPaneProps> = ({
  rootPath,
  title,
  revealPath,
  spaceId,
  resourceId,
  kind = 'user',
  requiresSessionAuthorization = false,
  preferredView,
  contextScopeKey,
  contextTabKey,
  isPaneActive = true,
}) => {
  const { t } = useTranslation('context')
  const [probeState, setProbeState] = useState<RepoProbeState>('checking')
  const [sessionAccessState, setSessionAccessState] = useState<SessionAccessState>(
    requiresSessionAuthorization ? 'authorizing' : 'ready',
  )
  const [sessionAccessError, setSessionAccessError] = useState<unknown>(null)
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0)
  const authorizedIdentityRef = useRef<string | null>(null)
  const failedIdentityRef = useRef<string | null>(null)
  const isHidden = useGitFlowPreference((s) => s.isGitFlowHidden(rootPath))
  const setGitFlowHidden = useGitFlowPreference((s) => s.setGitFlowHidden)
  const appendSessionAllowedPath = (window.tabtin?.workspace as {
    appendSessionAllowedPath?: (payload: { spaceId: string; path: string }) => Promise<unknown>
  } | undefined)?.appendSessionAllowedPath
  const sessionAuthorizationIdentity =
    requiresSessionAuthorization
    && spaceId
    && rootPath
    && appendSessionAllowedPath
      ? `${spaceId}\0${rootPath}`
      : null
  const hasCurrentSessionAuthorization =
    !sessionAuthorizationIdentity
    || authorizedIdentityRef.current === sessionAuthorizationIdentity

  const normalizedRootPath = useMemo(
    () => normalizePathSeparators(rootPath).replace(/\/+$/, ''),
    [rootPath],
  )
  const relocateMode = resolveRelocateMode(resourceId)
  const { status: rootHealth, retry: retryRootHealth } = useLocalDirRootHealth(
    hasCurrentSessionAuthorization && sessionAccessState === 'ready' ? normalizedRootPath : null,
  )

  const handleUserRelocate = useCallback(async (newPath: string) => {
    if (!resourceId?.startsWith('user::') || !spaceId) return
    const relocated = useFolderContextStore.getState().relocateUserFolder(
      resourceId,
      newPath,
      getBaseName(newPath) || newPath,
    )
    if (!relocated) {
      throw new Error('folder not found for relocate')
    }
    const tabScopeKey = resolveForegroundTabScopeKey(spaceId)
    const tabsStore = useSpaceContextTabsStore.getState()
    tabsStore.closeTab(tabScopeKey, `tabfolder:${relocated.oldFolderId}`)
    tabsStore.openResourceTab(tabScopeKey, {
      type: 'tabfolder',
      id: relocated.newFolderId,
      title: relocated.title,
      meta: {
        path: relocated.rootPath,
        kind: 'user',
      },
    })
    // session 授权新路径（旧 path 已失效）
    if (appendSessionAllowedPath) {
      try {
        await appendSessionAllowedPath({ spaceId, path: relocated.rootPath })
      } catch (err) {
        log.warn('appendSessionAllowedPath after relocate failed', {
          errorType: err instanceof Error ? err.name : typeof err,
        })
      }
    }
  }, [appendSessionAllowedPath, resourceId, spaceId])

  useEffect(() => {
    if (!sessionAuthorizationIdentity || !spaceId) {
      if (requiresSessionAuthorization && spaceId && rootPath && !appendSessionAllowedPath) {
        log.warn('session directory authorization bridge unavailable; using existing path policy', {
          spaceId,
        })
      }
      setSessionAccessState('ready')
      setSessionAccessError(null)
      return
    }

    if (!appendSessionAllowedPath) {
      setSessionAccessState('ready')
      setSessionAccessError(null)
      return
    }

    if (authorizedIdentityRef.current === sessionAuthorizationIdentity) {
      setSessionAccessState('ready')
      return
    }

    let cancelled = false
    failedIdentityRef.current = null
    setSessionAccessState('authorizing')
    setSessionAccessError(null)
    void appendSessionAllowedPath({ spaceId, path: rootPath })
      .then(() => {
        if (cancelled) return
        authorizedIdentityRef.current = sessionAuthorizationIdentity
        failedIdentityRef.current = null
        setSessionAccessState('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        log.error('failed to authorize local directory before mounting file access', {
          spaceId,
          errorType: error instanceof Error ? error.name : typeof error,
        })
        failedIdentityRef.current = sessionAuthorizationIdentity
        setSessionAccessError(error)
        setSessionAccessState('failed')
      })

    return () => {
      cancelled = true
    }
  }, [
    appendSessionAllowedPath,
    authorizationAttempt,
    requiresSessionAuthorization,
    rootPath,
    sessionAuthorizationIdentity,
    spaceId,
  ])

  useEffect(() => {
    if (preferredView === 'code') {
      setProbeState('repo')
      return
    }
    if (preferredView === 'folder') {
      setProbeState('not-repo')
      return
    }
    let cancelled = false
    setProbeState('checking')
    if (!hasCurrentSessionAuthorization || sessionAccessState !== 'ready') return
    if (rootHealth === 'missing') return
    const git = window.tabtin?.git
    if (!git?.isGitRepo || !rootPath) {
      setProbeState('not-repo')
      return
    }
    void git.isGitRepo(rootPath)
      .then((result) => {
        if (cancelled) return
        setProbeState(result?.success && result.isRepo ? 'repo' : 'not-repo')
      })
      .catch(() => {
        if (cancelled) return
        setProbeState('not-repo')
      })
    return () => { cancelled = true }
  }, [hasCurrentSessionAuthorization, preferredView, rootHealth, rootPath, sessionAccessState])

  // 关 Git 流程模式停在普通目录时预热 TabCode chunk，开开关时少闪一次 Suspense loading。
  useEffect(() => {
    if (probeState !== 'repo' || !isHidden) return
    void loadTabCodePaneHost()
  }, [probeState, isHidden])

  if (!hasCurrentSessionAuthorization && (
    sessionAccessState !== 'failed'
    || failedIdentityRef.current !== sessionAuthorizationIdentity
  )) {
    return (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
        {t('label.loading')}
      </div>
    )
  }

  if (!hasCurrentSessionAuthorization && sessionAccessState === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-body font-medium text-foreground">
          {t('folder.errors.openFolderTitle', { defaultValue: '打开文件夹失败' })}
        </div>
        <div className="max-w-md text-caption text-muted-foreground">
          {formatIpcErrorForUser(
            sessionAccessError,
            t('folder.errors.openFolderDescription', {
              defaultValue: '当前环境不支持文件夹选择。',
            }),
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAuthorizationAttempt(attempt => attempt + 1)}
        >
          {t('folder.actions.retryAuthorization', { defaultValue: '重试' })}
        </Button>
      </div>
    )
  }

  if (rootHealth === 'missing') {
    return (
      <LocalDirPathMissing
        rootPath={normalizedRootPath}
        relocateMode={relocateMode}
        spaceId={spaceId}
        onRetry={retryRootHealth}
        onUserRelocate={relocateMode === 'user' ? handleUserRelocate : undefined}
      />
    )
  }

  const gitFlowSwitch = preferredView !== 'folder' && probeState === 'repo'
    ? {
        checked: !isHidden,
        onChange: (checked: boolean) => setGitFlowHidden(rootPath, !checked),
      }
    : undefined

  const showCodePane = preferredView === 'folder'
    ? false
    : probeState === 'repo' && !isHidden

  if (showCodePane) {
    return (
      <React.Suspense
        key={`code:${rootPath}`}
        fallback={
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {t('label.loading')}
          </div>
        }
      >
        <LazyTabCodePaneHost
          rootPath={rootPath}
          spaceId={spaceId}
          resourceId={resourceId}
          gitFlowSwitch={gitFlowSwitch}
          assumeGitRepo
          isPaneActive={isPaneActive}
          tabScopeKey={contextScopeKey}
          contextTabKey={contextTabKey}
        />
      </React.Suspense>
    )
  }

  return (
    <FileExplorerPane
      key={`folder:${rootPath}`}
      rootPath={rootPath}
      kind={kind}
      title={title}
      revealPath={revealPath}
      className="h-full w-full"
      gitFlowSwitch={gitFlowSwitch}
      spaceId={spaceId}
      relocateMode={relocateMode}
      onUserRelocate={relocateMode === 'user' ? handleUserRelocate : undefined}
      contextScopeKey={contextScopeKey}
      contextTabKey={contextTabKey}
    />
  )
}
