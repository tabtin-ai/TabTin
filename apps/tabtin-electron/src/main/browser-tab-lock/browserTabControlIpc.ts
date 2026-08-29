import { ipcMain } from 'electron'
import { okResponse } from '@tabtin/agent-wire'
import { electronAgentHost } from '../agent/ElectronAgentHost'
import { createLogger } from '../logger'
import { guardedHandle } from '../utils/guarded-handle'
import {
  captureBrowserTabControlViewState,
  collectHandBackGroup,
  collectTakeOverGroup,
  handBackToAgent,
  restoreBrowserTabControlViewState,
  takeOverByUser,
  type BrowserTabControlViewState,
} from './browserTabInputLock'

const log = createLogger('BrowserTabControlIpc')

export const BROWSER_TAB_CONTROL_IPC_CHANNELS = [
  'browser-tab-control:take-over',
  'browser-tab-control:hand-back',
] as const

interface BrowserTabControlIpcResult {
  success: boolean
  sessionIds: string[]
  releasedSessionIds?: string[]
}

const EMPTY_RESULT: BrowserTabControlIpcResult = {
  success: false,
  sessionIds: [],
}

function browserTabControlResponse(result: BrowserTabControlIpcResult) {
  return okResponse(result)
}

function normalizeViewId(viewId: unknown): string | null {
  if (typeof viewId !== 'string') return null
  const normalized = viewId.trim()
  return normalized || null
}

function rollbackTakeOver(
  viewStates: BrowserTabControlViewState[],
  sessionIds: readonly string[],
  previouslyOwnedSessionIds: readonly string[],
  newlyParkedSessionIds: readonly string[],
): number {
  const primaryViewId = viewStates[0]?.viewId ?? ''
  const previouslyOwned = new Set(previouslyOwnedSessionIds)
  const ownershipsToRelease = new Set(
    newlyParkedSessionIds.filter((sessionId) => !previouslyOwned.has(sessionId)),
  )
  try {
    const current = electronAgentHost.getBrowserControlStatus(sessionIds)
    for (const sessionId of current.ownedSessionIds) {
      if (!previouslyOwned.has(sessionId)) ownershipsToRelease.add(sessionId)
    }
  } catch {
    log.error('浏览器接管回滚查询 ownership 失败', {
      viewId: primaryViewId,
      viewCount: viewStates.length,
      requestedCount: sessionIds.length,
    })
  }

  try {
    electronAgentHost.releaseBrowserControl([...ownershipsToRelease])
  } catch {
    log.error('浏览器接管回滚释放 park 失败', {
      viewId: primaryViewId,
      viewCount: viewStates.length,
      releaseCount: ownershipsToRelease.size,
    })
  } finally {
    for (const state of viewStates) restoreBrowserTabControlViewState(state)
  }
  return ownershipsToRelease.size
}

export function registerBrowserTabControlIpc(): void {
  guardedHandle(BROWSER_TAB_CONTROL_IPC_CHANNELS[0], (_event, rawViewId: unknown) => {
    const viewId = normalizeViewId(rawViewId)
    if (!viewId) return browserTabControlResponse(EMPTY_RESULT)

    const group = collectTakeOverGroup(viewId)
    const candidateSessionIds = group.sessionIds
    if (candidateSessionIds.length === 0) {
      log.warn('浏览器接管失败，view 无持锁会话（无主锁）', { viewId })
      return browserTabControlResponse(EMPTY_RESULT)
    }
    const viewStates = group.viewIds.map(captureBrowserTabControlViewState)

    let previouslyOwnedSessionIds: string[] = []
    let newlyParkedSessionIds: string[] = []
    let sessionIds: string[] = []
    let takeOverAttempted = false
    let hostMutationStarted = false
    try {
      const before = electronAgentHost.getBrowserControlStatus(candidateSessionIds)
      if (before.unresolvedSessionIds.length > 0) {
        log.warn('浏览器接管失败，session 无法唯一解析', {
          viewId,
          viewCount: group.viewIds.length,
          requestedCount: candidateSessionIds.length,
          unresolvedCount: before.unresolvedSessionIds.length,
        })
        return browserTabControlResponse(EMPTY_RESULT)
      }
      previouslyOwnedSessionIds = before.ownedSessionIds
      takeOverAttempted = true
      sessionIds = takeOverByUser(viewId)
      if (sessionIds.length === 0) return browserTabControlResponse(EMPTY_RESULT)

      hostMutationStarted = true
      newlyParkedSessionIds = electronAgentHost.parkBrowserControl(sessionIds)
      const after = electronAgentHost.getBrowserControlStatus(sessionIds)
      if (
        after.unresolvedSessionIds.length > 0
        || after.parkedSessionIds.length !== sessionIds.length
      ) {
        throw new Error('browser_control_park_incomplete')
      }

      log.info('用户接管浏览器', {
        viewId,
        viewCount: group.viewIds.length,
        sessionCount: sessionIds.length,
      })
      return browserTabControlResponse({
        success: true,
        sessionIds,
      })
    } catch {
      let rollbackCount = 0
      if (hostMutationStarted) {
        rollbackCount = rollbackTakeOver(
          viewStates,
          sessionIds.length > 0 ? sessionIds : candidateSessionIds,
          previouslyOwnedSessionIds,
          newlyParkedSessionIds,
        )
      } else if (takeOverAttempted) {
        for (const state of viewStates) restoreBrowserTabControlViewState(state)
      }
      log.warn('浏览器接管失败，已回滚', {
        viewId,
        viewCount: group.viewIds.length,
        requestedCount: sessionIds.length || candidateSessionIds.length,
        parkedCount: rollbackCount,
      })
      return browserTabControlResponse(EMPTY_RESULT)
    }
  })

  guardedHandle(BROWSER_TAB_CONTROL_IPC_CHANNELS[1], (_event, rawViewId: unknown) => {
    const viewId = normalizeViewId(rawViewId)
    if (!viewId) return browserTabControlResponse(EMPTY_RESULT)

    const group = collectHandBackGroup(viewId)
    if (group.viewIds.length === 0) return browserTabControlResponse(EMPTY_RESULT)
    const viewStates = group.viewIds.map(captureBrowserTabControlViewState)
    let before: ReturnType<typeof electronAgentHost.getBrowserControlStatus>
    try {
      before = electronAgentHost.getBrowserControlStatus(group.sessionIds)
      if (before.unresolvedSessionIds.length > 0) {
        log.warn('浏览器交还失败，session 无法唯一解析', {
          viewId,
          viewCount: group.viewIds.length,
          requestedCount: group.sessionIds.length,
          unresolvedCount: before.unresolvedSessionIds.length,
        })
        return browserTabControlResponse({
          success: false,
          sessionIds: [],
          releasedSessionIds: [],
        })
      }
    } catch {
      log.warn('浏览器交还失败，无法读取初始 ownership', {
        viewId,
        viewCount: group.viewIds.length,
        requestedCount: group.sessionIds.length,
      })
      return browserTabControlResponse({
        success: false,
        sessionIds: [],
        releasedSessionIds: [],
      })
    }
    const { affectedSessionIds, releaseSessionIds } = handBackToAgent(viewId)
    if (affectedSessionIds.length === 0) return browserTabControlResponse(EMPTY_RESULT)
    const previouslyOwned = new Set(before.ownedSessionIds)
    const ownershipsToRestore =
      releaseSessionIds.filter((sessionId) => previouslyOwned.has(sessionId))

    try {
      const releasedOwnershipIds =
        electronAgentHost.releaseBrowserControl(releaseSessionIds)
      const after = electronAgentHost.getBrowserControlStatus(releaseSessionIds)
      if (
        after.unresolvedSessionIds.length > 0
        || after.ownedSessionIds.length > 0
        || after.parkedSessionIds.length > 0
      ) {
        throw new Error('browser_control_release_incomplete')
      }

      log.info('用户交还浏览器', {
        viewId,
        viewCount: group.viewIds.length,
        sessionCount: affectedSessionIds.length,
        finalReleaseCount: releaseSessionIds.length,
        releasedParkCount: releasedOwnershipIds.length,
      })
      return browserTabControlResponse({
        success: true,
        sessionIds: affectedSessionIds,
        releasedSessionIds: releaseSessionIds,
      })
    } catch {
      let restoredParkCount = 0
      try {
        electronAgentHost.parkBrowserControl(ownershipsToRestore)
        const restored = electronAgentHost.getBrowserControlStatus(ownershipsToRestore)
        restoredParkCount = restored.parkedSessionIds.length
        if (
          restored.unresolvedSessionIds.length > 0
          || restoredParkCount !== ownershipsToRestore.length
        ) {
          log.error('浏览器交还回滚未能恢复全部 park', {
            viewId,
            viewCount: group.viewIds.length,
            expectedCount: ownershipsToRestore.length,
            restoredCount: restoredParkCount,
            unresolvedCount: restored.unresolvedSessionIds.length,
          })
        }
      } catch {
        log.error('浏览器交还回滚恢复 park 异常', {
          viewId,
          viewCount: group.viewIds.length,
          expectedCount: ownershipsToRestore.length,
        })
      } finally {
        for (const state of viewStates) restoreBrowserTabControlViewState(state)
      }
      log.warn('浏览器交还失败，已恢复用户控制', {
        viewId,
        viewCount: group.viewIds.length,
        affectedCount: affectedSessionIds.length,
        finalReleaseCount: releaseSessionIds.length,
        restoredParkCount,
      })
      return browserTabControlResponse({
        success: false,
        sessionIds: [],
        releasedSessionIds: [],
      })
    }
  })
}

export function unregisterBrowserTabControlIpc(): void {
  for (const channel of BROWSER_TAB_CONTROL_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
}
