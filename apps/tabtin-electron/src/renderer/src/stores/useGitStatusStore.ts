/** @store-category domain */

/**
 * Git Status Store — 远程 Daemon Git 状态管理
 *
 * 通过 WS 监听 git.status 事件，维护每个 Space 的 Git 状态。
 * 仅用于远程 Daemon 上报的 Git 状态，本地 TabCode 的 Git 状态由 useGitStatus hook 管理。
 */

import { create } from 'zustand'
import type { AgentConfig, RemoteGitStatus, GitStatusEventPayload } from '@tabtin/app-shell'
import { getChatClient } from '@/services/chatApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('GitStatus')

interface FileDiffResult {
  file_path: string
  diff: string
}

function resolveSpaceId(payload?: GitStatusEventPayload): string | undefined {
  return payload?.space_id
}

interface GitStatusState {
  /** 按 Space ID 索引的 Git 状态 */
  statusBySpaceId: Record<string, RemoteGitStatus>

  /** 按需拉取的文件 diff 缓存：key = `${spaceId}:${filePath}:${staged}` */
  diffCache: Record<string, { diff: string; fetchedAt: number }>

  /** 当前正在加载 diff 的 key 集合 */
  diffLoading: Set<string>

  /** 更新指定 Space 的 Git 状态 */
  setGitStatus: (spaceId: string, status: RemoteGitStatus) => void

  /** 从 Agent 的 agent_config 中恢复 Git 状态（初始加载） */
  restoreFromAgentConfig: (spaceId: string, agentConfig?: AgentConfig) => void

  /** 清除指定 Space 的 Git 状态 */
  clearGitStatus: (spaceId: string) => void

  /** 按需拉取文件 diff（Phase 4） */
  requestFileDiff: (spaceId: string, filePath: string, staged?: boolean) => Promise<string>

  /** 设置 WS 监听 */
  setupWsListener: () => void
  teardownWsListener: () => void

  /** 全量重置（organization 切换时调用） */
  reset: () => void
}

let _wsListener: ((envelope: any) => void) | null = null
let _wsReconnectHandler: (() => void) | null = null
let _wsListenerRefCount = 0

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statusBySpaceId: {},
  diffCache: {},
  diffLoading: new Set(),

  setGitStatus: (spaceId, status) => {
    set((state) => ({
      statusBySpaceId: {
        ...state.statusBySpaceId,
        [spaceId]: status,
      },
    }))
  },

  restoreFromAgentConfig: (spaceId, agentConfig) => {
    const gitStatus = agentConfig?.git_status
    if (!gitStatus || !gitStatus.is_repo) return

    set((state) => ({
      statusBySpaceId: {
        ...state.statusBySpaceId,
        [spaceId]: gitStatus,
      },
    }))
  },

  clearGitStatus: (spaceId) => {
    set((state) => {
      const next = { ...state.statusBySpaceId }
      delete next[spaceId]
      return { statusBySpaceId: next }
    })
  },

  requestFileDiff: async (spaceId, filePath, staged = false) => {
    const cacheKey = `${spaceId}:${filePath}:${staged}`

    const cached = get().diffCache[cacheKey]
    if (cached && Date.now() - cached.fetchedAt < 10_000) {
      return cached.diff
    }

    if (get().diffLoading.has(cacheKey)) return ''

    set((state) => ({ diffLoading: new Set(state.diffLoading).add(cacheKey) }))

    try {
      const gateway = getChatClient().getGateway()
      const response = await gateway.request('git.diff.request', {
        space_id: spaceId,
        file_path: filePath,
        staged,
      }, { timeoutMs: 20_000 })
      if (!response.ok) {
        throw new Error(response.error?.message || 'git diff request failed')
      }
      const diff = response.payload?.diff ?? ''

      set((state) => {
        const loading = new Set(state.diffLoading)
        loading.delete(cacheKey)
        return {
          diffLoading: loading,
          diffCache: {
            ...state.diffCache,
            [cacheKey]: { diff, fetchedAt: Date.now() },
          },
        }
      })

      return diff
    } catch (error) {
      log.warn('requestFileDiff failed:', { spaceId, filePath, staged, error })
      set((state) => {
        const loading = new Set(state.diffLoading)
        loading.delete(cacheKey)
        return { diffLoading: loading }
      })
      return ''
    }
  },

  setupWsListener: () => {
    _wsListenerRefCount++
    if (_wsListener) return

    try {
      const gateway = getChatClient().getGateway()

      _wsListener = (envelope: any) => {
        if (envelope?.type !== 'git.status') return

        const payload = envelope.payload as GitStatusEventPayload | undefined
        const spaceId = resolveSpaceId(payload)
        if (!spaceId || !payload?.git_status) return

        set((state) => ({
          statusBySpaceId: {
            ...state.statusBySpaceId,
            [spaceId]: payload.git_status,
          },
        }))
      }

      gateway.addListener(_wsListener)

      _wsReconnectHandler = () => {
        log.info('WS reconnected — clearing stale git status cache')
        // 断线期间 Daemon 可能已推送新状态，清空旧缓存避免前端展示过时数据。
        // 清空后前端会短暂显示空状态，等待 Daemon 下一次心跳推送新的 git.status 事件。
        const knownSpaceIds = Object.keys(get().statusBySpaceId)
        set({ statusBySpaceId: {}, diffCache: {} })

        // 主动向 Daemon 请求最新 git status（逐个 Space 发起，容错处理）
        if (knownSpaceIds.length > 0) {
          try {
            const gw = getChatClient().getGateway()
            for (const spaceId of knownSpaceIds) {
              gw.request('git.status.request', { space_id: spaceId }, { timeoutMs: 10_000 })
                .then((res: any) => {
                  if (res?.ok && res.payload?.git_status) {
                    set((state) => ({
                      statusBySpaceId: {
                        ...state.statusBySpaceId,
                        [spaceId]: res.payload.git_status,
                      },
                    }))
                  }
                })
                .catch(() => {
                  // Daemon 不支持该请求类型时静默忽略，等待下次心跳推送
                })
            }
          } catch {
            // getChatClient/getGateway 初始化异常时静默忽略
          }
        }
      }
      gateway.onReconnectedEvent(_wsReconnectHandler)
    } catch {
      // ChatClient 尚未初始化
    }
  },

  teardownWsListener: () => {
    _wsListenerRefCount = Math.max(0, _wsListenerRefCount - 1)
    if (_wsListenerRefCount > 0 || !_wsListener) return
    try {
      const gateway = getChatClient().getGateway()
      if (_wsListener) gateway.removeListener(_wsListener)
      if (_wsReconnectHandler) gateway.offReconnectedEvent(_wsReconnectHandler)
    } catch {
      // ignore
    }
    _wsListener = null
    _wsReconnectHandler = null
  },

  reset: () => {
    _wsListenerRefCount = 0
    get().teardownWsListener()
    set({ statusBySpaceId: {}, diffCache: {}, diffLoading: new Set() })
  },
}))

import { registerResetAction } from './sessionResetRegistry'
registerResetAction('git-status', 'reset', () => useGitStatusStore.getState().reset())
