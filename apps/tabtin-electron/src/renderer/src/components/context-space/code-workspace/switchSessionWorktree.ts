/**
 * 会话代码根 worktree 切换：授权 → bindSessionCodeRoot → 静默切 TabCode / 重建 Changes。
 * 不展开画布、不激活打开 TabCode；不调用 Workspace working_dir 更新 / relocate。
 */

import {
  bindSessionCodeRoot,
  type BindSessionCodeRootFailureReason,
  type BindSessionCodeRootOutcome,
} from '@/services/sessionCodeRootBinding'
import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import { createLogger } from '@/utils/logger'
import { normalizePathForCompare } from '@components/tabcode/utils/worktreePaths'
import {
  redirectCodeChangesTabsToRoot,
  silentlyRebindSessionTabCodeRoot,
} from './codeWorkspaceTab'
import { useAgentTurnDiffStore } from './agentTurnDiffSnapshots'

const log = createLogger('SwitchSessionWorktree')

export const BIND_REASON_I18N_KEY: Record<BindSessionCodeRootFailureReason, string> = {
  invalid_session_id: 'codeWorkspace.bindReason.invalidSession',
  invalid_root_path: 'codeWorkspace.bindReason.invalidPath',
  not_found: 'codeWorkspace.bindReason.notFound',
  not_a_directory: 'codeWorkspace.bindReason.notDirectory',
  not_git_worktree: 'codeWorkspace.bindReason.notGitWorktree',
  session_busy: 'codeWorkspace.bindReason.sessionBusy',
  ipc_unavailable: 'codeWorkspace.bindReason.ipcUnavailable',
}

export interface SwitchSessionWorktreeInput {
  sessionId: string
  spaceId: string
  tabScopeKey: string
  rootPath: string
  /** 切换前的会话代码根；有对应 TabCode 时静默切到新根 */
  previousRootPath?: string | null
  branch?: string | null
}

export interface ApplySessionCodeRootChangeInput {
  sessionId: string
  spaceId: string
  tabScopeKey: string
  rootPath: string
  previousRootPath?: string | null
}

/** 绑定提交后的 renderer 投影；UI 切换和 Agent CLI 切换共用同一条链。 */
export function applySessionCodeRootChange(input: ApplySessionCodeRootChangeInput): void {
  const previousRootPath = input.previousRootPath?.trim() || null
  useContextInjectionStore
    .getState()
    .pruneCodeRefsForRootChange(input.sessionId, input.rootPath)
  useAgentTurnDiffStore.getState().markCodeRootSwitched(input.sessionId)

  if (
    input.tabScopeKey
    && previousRootPath
    && normalizePathForCompare(previousRootPath) !== normalizePathForCompare(input.rootPath)
  ) {
    silentlyRebindSessionTabCodeRoot({
      tabScopeKey: input.tabScopeKey,
      previousRootPath,
      nextRootPath: input.rootPath,
      spaceId: input.spaceId,
    })
  }

  if (input.tabScopeKey) {
    redirectCodeChangesTabsToRoot({
      tabScopeKey: input.tabScopeKey,
      spaceId: input.spaceId,
      nextRootPath: input.rootPath,
      sessionId: input.sessionId,
    })
  }
}

export async function switchSessionWorktree(
  input: SwitchSessionWorktreeInput,
): Promise<BindSessionCodeRootOutcome> {
  const { sessionId, spaceId, tabScopeKey, rootPath } = input
  const previousRootPath = input.previousRootPath?.trim() || null
  try {
    if (spaceId) {
      await window.tabtin?.workspace?.appendSessionAllowedPath?.({
        spaceId,
        sessionId,
        path: rootPath,
      })
    }
  } catch (err) {
    log.warn('appendSessionAllowedPath failed', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
    return {
      success: false,
      error: 'authorize failed',
      reason: 'invalid_root_path',
    }
  }

  let result: BindSessionCodeRootOutcome
  try {
    result = await bindSessionCodeRoot({
      sessionId,
      rootPath,
      tabKey: tabScopeKey,
      branch: input.branch ?? undefined,
      title: input.branch || undefined,
    })
  } catch (err) {
    log.error('bindSessionCodeRoot threw', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
    return {
      success: false,
      error: err instanceof Error ? err.message : 'bind failed',
      reason: 'ipc_unavailable',
    }
  }

  if (!result.success) {
    return result
  }

  const boundPath = result.rootPath ?? rootPath
  try {
    applySessionCodeRootChange({
      sessionId,
      spaceId,
      tabScopeKey,
      rootPath: boundPath,
      previousRootPath,
    })
  } catch (err) {
    // 绑定已成功：侧栏/标签协调失败不应吞成「无提示」；向上抛给 UI toast
    log.error('post-bind worktree switch side effects failed', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
    throw err
  }

  return result
}
