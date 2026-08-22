/**
 * sessionCodeRootBinding —  会话代码根绑定（TabCode worktree
 * session root）的 renderer 薄封装。
 *
 * 只做一件事：调 `window.tabtin.agent.{bind,get,clear}SessionCodeRoot` IPC，
 * 成功后把结果同步进本地镜像 `useSessionBoundCodeRootStore`——UI（文件树 /
 * TabFolder / ChatInput 执行根展示）读这个 store，不必等下一轮 query 的
 * `boundCodeRootRevision` 往返才刷新。
 *
 * main 端权威校验（路径存在 / 是 Git 工作树 / 会话未 busy）见
 * `main/agent/session-code-root-binding.ts`；本文件不重复校验、不碰文件系统。
 *
 * **对接点**：`WorktreeSection`（TabCode Git 面板 → 高级 → Worktree）在用户点
 * 「设为对话代码根」时调用 `bindSessionCodeRoot`，失败时按 `reason` 展示对应文案
 * （尤其 `session_busy`：提示"先停止当前运行再切换目录"）；成功后由调用方
 * 触发 `pruneCodeRefsForRootChange` 清理旧根的未发送代码引用。
 */

import { createLogger } from '@/utils/logger'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'

const log = createLogger('SessionCodeRootBinding')

export type BindSessionCodeRootFailureReason =
  | 'invalid_session_id'
  | 'invalid_root_path'
  | 'not_found'
  | 'not_a_directory'
  | 'not_git_worktree'
  | 'session_busy'
  /** renderer 侧附加：preload API 未就绪（极早期启动 / 非 Electron 环境）。 */
  | 'ipc_unavailable'

export interface BindSessionCodeRootParams {
  sessionId: string
  rootPath: string
  revision?: number
  tabKey?: string | null
  branch?: string | null
  title?: string | null
}

export interface BindSessionCodeRootOutcome {
  success: boolean
  rootPath?: string
  revision?: number
  error?: string
  reason?: BindSessionCodeRootFailureReason
}

export interface SessionCodeRootBindingSnapshot {
  rootPath: string
  revision: number
  tabKey?: string
  branch?: string
  title?: string
  boundAt: number
}

function api() {
  return window.tabtin?.agent
}

/** main 已提交绑定后的 renderer 镜像入口（IPC ack 与 main push 共用）。 */
export function mirrorSessionCodeRootBinding(
  sessionId: string,
  binding: {
    rootPath: string
    tabKey?: string | null
    branch?: string | null
    title?: string | null
  },
): void {
  useSessionBoundCodeRootStore.getState().setBindingLocal(sessionId, {
    rootPath: binding.rootPath,
    tabKey: binding.tabKey,
    branch: binding.branch,
    title: binding.title,
    status: 'active',
  })
}

/**
 * 绑定当前 chat 会话的代码执行根。main 端拒绝时返回
 * `{ success: false, reason }`（不抛异常），成功时立即写入
 * `useSessionBoundCodeRootStore`（`status: 'active'`）。
 */
export async function bindSessionCodeRoot(
  params: BindSessionCodeRootParams,
): Promise<BindSessionCodeRootOutcome> {
  const agent = api()
  if (!agent) {
    log.warn('bindSessionCodeRoot: agent IPC not available')
    return { success: false, error: 'agent IPC not available', reason: 'ipc_unavailable' }
  }
  try {
    const result = await agent.bindSessionCodeRoot({
      sessionId: params.sessionId,
      rootPath: params.rootPath,
      revision: params.revision,
      tabKey: params.tabKey ?? undefined,
      branch: params.branch ?? undefined,
      title: params.title ?? undefined,
    })
    if (result?.success && result.rootPath) {
      mirrorSessionCodeRootBinding(params.sessionId, {
        rootPath: result.rootPath,
        tabKey: params.tabKey,
        branch: params.branch,
        title: params.title,
      })
      log.info(
        `bound session=${params.sessionId.slice(0, 8)}… root=${result.rootPath} revision=${result.revision ?? '?'}`,
      )
      return result as BindSessionCodeRootOutcome
    }
    // success 但缺 rootPath：不能当成功，否则 UI 误报「已切换」却不更新
    if (result?.success && !result.rootPath) {
      log.warn(`bind claimed success without rootPath session=${params.sessionId.slice(0, 8)}…`)
      return {
        success: false,
        error: 'missing rootPath in bind response',
        reason: 'invalid_root_path',
      }
    }
    log.warn(`bind failed session=${params.sessionId.slice(0, 8)}… reason=${result?.reason ?? 'unknown'}`)
    return (result as BindSessionCodeRootOutcome) ?? {
      success: false,
      error: 'no response from main process',
      reason: 'ipc_unavailable',
    }
  } catch (err) {
    log.error('bindSessionCodeRoot threw', {
      errorType: err instanceof Error ? err.name : typeof err,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      success: false,
      error: err instanceof Error ? err.message : 'bindSessionCodeRoot failed',
      reason: 'ipc_unavailable',
    }
  }
}

/**
 * 清除当前 chat 会话的代码根绑定——main 权威态与 renderer 本地镜像一并清空。
 * main 端调用失败（如 IPC 不可用）时仍清本地镜像，避免 UI 卡在一个无法确认
 * 的绑定态上（fail-soft：宁可"看起来未绑定"，也不要"看起来绑定但已失效"）。
 */
export async function clearSessionCodeRoot(
  sessionId: string,
): Promise<{ success: boolean; cleared?: boolean; error?: string }> {
  const agent = api()
  useSessionBoundCodeRootStore.getState().clearBinding(sessionId)
  if (!agent) {
    log.warn('clearSessionCodeRoot: agent IPC not available')
    return { success: false, error: 'agent IPC not available' }
  }
  const result = await agent.clearSessionCodeRoot({ sessionId })
  return result ?? { success: false, error: 'no response from main process' }
}

/**
 * 从 main 权威态拉取当前会话的绑定，并回填本地镜像。
 *
 * 用于进程重启 / 新窗口打开等 renderer 本地镜像丢失场景——`useSessionBoundCodeRootStore`
 * 不持久化（见其文件头注释），需要主动拉取一次才能恢复展示。
 */
export async function fetchSessionCodeRoot(
  sessionId: string,
): Promise<SessionCodeRootBindingSnapshot | null> {
  const agent = api()
  if (!agent) return null
  const result = await agent.getSessionCodeRoot({ sessionId })
  if (!result?.success || !result.binding) return null
  const { binding } = result
  useSessionBoundCodeRootStore.getState().setBindingLocal(sessionId, {
    rootPath: binding.rootPath,
    tabKey: binding.tabKey,
    branch: binding.branch,
    title: binding.title,
    status: 'active',
  })
  return binding
}

/**
 * 批量回填：会话列表恢复后一次 IPC，把 main 已 restore 的绑定写入本地镜像。
 * 无效 / 缺失记录不会写入；重复调用对同一批 ID 幂等（以 main 返回为准覆盖）。
 */
export async function hydrateSessionCodeRoots(
  sessionIds: readonly string[],
): Promise<number> {
  const unique = [...new Set(sessionIds.map((id) => id?.trim()).filter(Boolean))] as string[]
  if (unique.length === 0) return 0
  const agent = api()
  if (!agent?.listSessionCodeRoots) {
    log.warn('hydrateSessionCodeRoots: listSessionCodeRoots IPC not available')
    return 0
  }
  try {
    const result = await agent.listSessionCodeRoots({ sessionIds: unique })
    if (!result?.success || !result.bindings) return 0
    const store = useSessionBoundCodeRootStore.getState()
    let count = 0
    for (const [sessionId, binding] of Object.entries(result.bindings)) {
      if (!binding?.rootPath) continue
      store.setBindingLocal(sessionId, {
        rootPath: binding.rootPath,
        tabKey: binding.tabKey,
        branch: binding.branch,
        title: binding.title,
        status: 'active',
      })
      count += 1
    }
    if (count > 0) {
      log.info(`hydrated ${count} session code root binding(s)`)
    }
    return count
  } catch (err) {
    log.error('hydrateSessionCodeRoots threw', {
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

/**
 * 草稿转正：renderer 镜像 + main 权威态一并原子迁移，to 为真 session 时落盘。
 */
export async function rehomeSessionCodeRoot(
  fromSessionId: string,
  toSessionId: string,
): Promise<SessionCodeRootBindingSnapshot | null> {
  const fromId = fromSessionId?.trim()
  const toId = toSessionId?.trim()
  if (!fromId || !toId || fromId === toId) return null

  const local = useSessionBoundCodeRootStore.getState().rehomeBinding(fromId, toId)
  const agent = api()
  if (!agent?.rehomeSessionCodeRoot) {
    if (local) {
      log.warn('rehomeSessionCodeRoot: IPC unavailable; local mirror moved only')
    }
    return local
      ? {
          rootPath: local.rootPath,
          revision: local.revision,
          tabKey: local.tabKey ?? undefined,
          branch: local.branch ?? undefined,
          title: local.title ?? undefined,
          boundAt: Date.now(),
        }
      : null
  }
  try {
    const result = await agent.rehomeSessionCodeRoot({
      fromSessionId: fromId,
      toSessionId: toId,
    })
    if (result?.success && result.binding) {
      useSessionBoundCodeRootStore.getState().setBindingLocal(toId, {
        rootPath: result.binding.rootPath,
        tabKey: result.binding.tabKey,
        branch: result.binding.branch,
        title: result.binding.title,
        status: 'active',
      })
      useSessionBoundCodeRootStore.getState().clearBinding(fromId)
      return result.binding
    }
    return local
      ? {
          rootPath: local.rootPath,
          revision: local.revision,
          tabKey: local.tabKey ?? undefined,
          branch: local.branch ?? undefined,
          title: local.title ?? undefined,
          boundAt: Date.now(),
        }
      : null
  } catch (err) {
    log.error('rehomeSessionCodeRoot threw', {
      error: err instanceof Error ? err.message : String(err),
    })
    return local
      ? {
          rootPath: local.rootPath,
          revision: local.revision,
          tabKey: local.tabKey ?? undefined,
          branch: local.branch ?? undefined,
          title: local.title ?? undefined,
          boundAt: Date.now(),
        }
      : null
  }
}
