/** @store-category session */

/**
 * Session-scoped 代码执行根绑定（「会话代码根」基础层）。
 *
 * 每个会话（含草稿 `local-pending-*` / `conversation:draft:*`）可显式绑定一个
 * 本地代码目录作为执行根，不再依赖 Canvas/TabCode tab 的 `activeKeyBySpace`
 * 这类"谁最后被点亮"的 UI 态（旧路径见 `utils/resolveSpaceExecutionPath.ts`）。
 *
 * 数据特点与 `useChatRuntimeStore` 的 `*BySessionId` 一致：
 * 1. 按 sessionId 隔离；renderer 侧不落盘——权威态在 main 本机 sidecar
 *    （`session-code-root-bindings.json`），这里是 ack / hydrate 后的本地镜像。
 * 2. 草稿转正（local-pending → 真 session）用 `rehomeBinding` + main rehome IPC，
 *    调用位置见 `stores/chat/session/actions/sessionLifecycleAction.ts`。
 * 3. 会话永久删除时由 `clearBindingsForSession` + clear IPC 清理三端。
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

export type BoundCodeRootStatus = 'active' | 'tab_closed' | 'path_missing'

export interface BoundCodeRootBinding {
  rootPath: string
  tabKey?: string | null
  branch?: string | null
  title?: string | null
  revision: number
  status: BoundCodeRootStatus
}

export interface SetBindingLocalInput {
  rootPath: string
  tabKey?: string | null
  branch?: string | null
  title?: string | null
  /** 默认 'active'——重新绑定视为恢复可用 */
  status?: BoundCodeRootStatus
}

interface GetBindingOptions {
  /** subagent 会话无自身绑定时，回退读取 parent 绑定 */
  parentSessionId?: string | null
}

interface SessionBoundCodeRootState {
  bindingsBySessionId: Record<string, BoundCodeRootBinding>
  nextRevision: number

  getBinding: (
    sessionId: string | null | undefined,
    opts?: GetBindingOptions,
  ) => BoundCodeRootBinding | null
  setBindingLocal: (sessionId: string, binding: SetBindingLocalInput) => BoundCodeRootBinding | null
  clearBinding: (sessionId: string) => void
  rehomeBinding: (fromSessionId: string, toSessionId: string) => BoundCodeRootBinding | null
  markTabClosed: (sessionId: string, tabKey?: string | null) => void
  markPathMissing: (sessionId: string) => void
  clearBindingsForSession: (sessionId: string) => void
  reset: () => void
}

const INITIAL_STATE = {
  bindingsBySessionId: {} as Record<string, BoundCodeRootBinding>,
  nextRevision: 1,
}

function deleteFromMap(
  map: Record<string, BoundCodeRootBinding>,
  sessionId: string,
): Record<string, BoundCodeRootBinding> {
  if (!(sessionId in map)) return map
  const next = { ...map }
  delete next[sessionId]
  return next
}

export const useSessionBoundCodeRootStore = create<SessionBoundCodeRootState>()((set, get) => ({
  ...INITIAL_STATE,

  getBinding: (sessionId, opts) => {
    if (!sessionId) return null
    const map = get().bindingsBySessionId
    if (map[sessionId]) return map[sessionId]
    const parentSessionId = opts?.parentSessionId
    if (parentSessionId && map[parentSessionId]) return map[parentSessionId]
    return null
  },

  setBindingLocal: (sessionId, binding) => {
    if (!sessionId) return null
    const rootPath = binding.rootPath.trim()
    if (!rootPath) return null
    let result: BoundCodeRootBinding | null = null
    set((state) => {
      const revision = state.nextRevision
      const next: BoundCodeRootBinding = {
        rootPath,
        tabKey: binding.tabKey ?? null,
        branch: binding.branch ?? null,
        title: binding.title ?? null,
        revision,
        status: binding.status ?? 'active',
      }
      result = next
      return {
        bindingsBySessionId: { ...state.bindingsBySessionId, [sessionId]: next },
        nextRevision: revision + 1,
      }
    })
    return result
  },

  clearBinding: (sessionId) => {
    if (!sessionId) return
    set((state) => ({
      bindingsBySessionId: deleteFromMap(state.bindingsBySessionId, sessionId),
    }))
  },

  /** 草稿转正：原子迁移绑定，旧 sessionId 解绑；目标已有绑定时以 from 覆盖并递增 revision */
  rehomeBinding: (fromSessionId, toSessionId) => {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return null
    let result: BoundCodeRootBinding | null = null
    set((state) => {
      const existing = state.bindingsBySessionId[fromSessionId]
      if (!existing) return state
      const revision = state.nextRevision
      const rehomed: BoundCodeRootBinding = { ...existing, revision }
      result = rehomed
      const nextMap = deleteFromMap(
        { ...state.bindingsBySessionId, [toSessionId]: rehomed },
        fromSessionId,
      )
      return { bindingsBySessionId: nextMap, nextRevision: revision + 1 }
    })
    return result
  },

  markTabClosed: (sessionId, tabKey) => {
    if (!sessionId) return
    set((state) => {
      const existing = state.bindingsBySessionId[sessionId]
      if (!existing) return state
      // 显式传 tabKey 时只对匹配的 tab 生效，避免旧 tab 的关闭事件误标新绑定
      if (tabKey != null && existing.tabKey != null && existing.tabKey !== tabKey) return state
      const revision = state.nextRevision
      return {
        bindingsBySessionId: {
          ...state.bindingsBySessionId,
          [sessionId]: { ...existing, status: 'tab_closed', revision },
        },
        nextRevision: revision + 1,
      }
    })
  },

  markPathMissing: (sessionId) => {
    if (!sessionId) return
    set((state) => {
      const existing = state.bindingsBySessionId[sessionId]
      if (!existing) return state
      const revision = state.nextRevision
      return {
        bindingsBySessionId: {
          ...state.bindingsBySessionId,
          [sessionId]: { ...existing, status: 'path_missing', revision },
        },
        nextRevision: revision + 1,
      }
    })
  },

  clearBindingsForSession: (sessionId) => {
    if (!sessionId) return
    set((state) => ({
      bindingsBySessionId: deleteFromMap(state.bindingsBySessionId, sessionId),
    }))
  },

  reset: () => set({ ...INITIAL_STATE }),
}))

/**
 * subagent 会话继承 parent 绑定的判定：自身有绑定则用自身，否则回退 parent。
 * 供 resolver 与 store getter 复用，避免两处实现口径不一致。
 */
export function resolveEffectiveSessionId(
  sessionId: string | null | undefined,
  opts?: { parentSessionId?: string | null },
): string | null {
  if (!sessionId) return null
  const bindings = useSessionBoundCodeRootStore.getState().bindingsBySessionId
  if (bindings[sessionId]) return sessionId
  const parentSessionId = opts?.parentSessionId
  if (parentSessionId && bindings[parentSessionId]) return parentSessionId
  return sessionId
}

// 组织切换 / 登出：绑定是会话级瞬态镜像，随身份切换清空，避免跨账号串目录。
registerResetAction('session-bound-code-root', 'reset', () => {
  useSessionBoundCodeRootStore.getState().reset()
})
