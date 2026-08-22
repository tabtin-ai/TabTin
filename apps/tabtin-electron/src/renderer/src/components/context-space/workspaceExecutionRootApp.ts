/**
 * Workspace 执行根在工作台中的常驻应用入口。
 *
 * - `working_dir_type === 'code'` → TabCode（IDE）
 * - 其余（doc / mixed / 未设）→ TabFolder（目录浏览）
 *
 * CollapsedCanvasRail、DesktopHomePane 等 UI 共用同一套解析与打开逻辑。
 */
import type { TFunction } from 'i18next'
import type { Agent } from '@tabtin/app-shell'
import { contextRegistry } from './registry'
import { useFolderContextStore } from './folder/useFolderStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'

export type WorkingDirType = 'code' | 'doc' | 'mixed' | ''
export type WorkspaceExecutionView = 'code' | 'folder'

export interface WorkspaceExecutionRootEntry {
  workingDir: string
  view: WorkspaceExecutionView
  appId: 'tabcode' | 'tabfolder'
  label: string
  tabKey: string
}

interface SpaceLike {
  id?: string
  type?: string
  working_dir?: string | null
  working_dir_type?: string | null
  execution_agent_id?: string | null
  agent_id?: string | null
}

export function normalizeWorkingDirType(raw: string | null | undefined): WorkingDirType {
  if (raw === 'code' || raw === 'doc' || raw === 'mixed') return raw
  return ''
}

export function resolveExecutionView(workingDirType: WorkingDirType): WorkspaceExecutionView {
  return workingDirType === 'code' ? 'code' : 'folder'
}

export function resolveWorkspaceWorkingDir(
  space: SpaceLike | null | undefined,
  agent: Agent | null | undefined,
): string {
  if (space?.working_dir) return space.working_dir
  if (space?.type !== 'workspace') return ''
  return agent?.working_dir || ''
}

export function resolveWorkspaceWorkingDirType(
  space: SpaceLike | null | undefined,
  agent: Agent | null | undefined,
): WorkingDirType {
  return normalizeWorkingDirType(
    space?.working_dir_type ?? agent?.working_dir_type ?? '',
  )
}

export function encodeTabCodeResourceId(localPath: string): string {
  return btoa(unescape(encodeURIComponent(localPath)))
}

function workingDirBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export function buildWorkspaceExecutionRootEntry(input: {
  spaceId: string
  workingDir: string
  workingDirType: WorkingDirType
  t: TFunction<'context'>
}): WorkspaceExecutionRootEntry | null {
  const workingDir = input.workingDir.trim()
  if (!workingDir) return null

  const view = resolveExecutionView(input.workingDirType)
  if (view === 'code') {
    const id = encodeTabCodeResourceId(workingDir)
    return {
      workingDir,
      view,
      appId: 'tabcode',
      label: input.t('canvasRail.executionRootIde', { defaultValue: 'IDE' }),
      tabKey: contextRegistry.buildTabKey('tabcode', id),
    }
  }

  const tabKey = resolveWorkspaceExecutionRootTabKey(input.spaceId, workingDir, view)
  return {
    workingDir,
    view,
    appId: 'tabfolder',
    label: input.t('canvasRail.executionRootFolder', { defaultValue: '目录' }),
    tabKey,
  }
}

export function resolveWorkspaceExecutionRootTabKey(
  spaceId: string,
  workingDir: string,
  view: WorkspaceExecutionView,
): string {
  if (view === 'code') {
    return contextRegistry.buildTabKey('tabcode', encodeTabCodeResourceId(workingDir))
  }
  const folderId = useFolderContextStore.getState().findFolderByPathForSpace(spaceId, workingDir)
    ?? useFolderContextStore.getState().addSpaceFolder(spaceId, {
      rootPath: workingDir,
      kind: 'user',
      title: workingDirBasename(workingDir),
    }).folderId
  return contextRegistry.buildTabKey('tabfolder', folderId)
}

export function openWorkspaceExecutionRoot(input: {
  tabScopeKey: string
  spaceId: string
  workingDir: string
  view: WorkspaceExecutionView
}): void {
  const workingDir = input.workingDir.trim()
  if (!workingDir) return

  if (input.view === 'code') {
    const id = encodeTabCodeResourceId(workingDir)
    const title = workingDirBasename(workingDir)
    useSpaceContextTabsStore.getState().openResourceTab(input.tabScopeKey, {
      type: 'tabcode',
      id,
      title,
      meta: { path: workingDir, preferredView: 'code' },
    })
    return
  }

  const title = workingDirBasename(workingDir)
  const { folderId } = useFolderContextStore.getState().addSpaceFolder(input.spaceId, {
    rootPath: workingDir,
    kind: 'user',
    title,
  })
  useSpaceContextTabsStore.getState().openResourceTab(input.tabScopeKey, {
    type: 'tabfolder',
    id: folderId,
    title,
    meta: {
      path: workingDir,
      kind: 'user',
      preferredView: 'folder',
    },
  })
}
