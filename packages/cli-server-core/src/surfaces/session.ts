/**
 * session 模块 — 4 个 PlatformSurface。
 *
 * 将原 `apps/tabtin-electron/src/main/session/ipc.ts` 中的
 * session:create / session:get / session:list / session:delete
 * 四个 IPC handler 迁移到 PlatformSurface 框架。
 *
 * 设计：采用工厂模式 `createSessionSurfaces(ops)`，handler 通过闭包
 * 捕获 SessionManager 操作接口，避免 surface 定义耦合 Electron 特有类。
 * Daemon 侧传入自己的 SessionManager 实现即可。
 *
 * 迁移后 channel 名不变（`session:create` 等），renderer 调用方无需改动。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ─────────────────────────────────────────────────────

/** Session 上下文对象（与 Electron SessionManager.SessionContext 对齐） */
export interface SessionRecord {
  sessionId: string
  name: string
  mode: string
  threadIdGeneratedBy: 'frontend' | 'backend'
  currentTraceId: string | null
  traces: Array<{
    traceId: string
    runId: string
    status: 'running' | 'completed' | 'error'
    startedAt: number
    endedAt: number | null
    error?: string
  }>
  sseStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  createdAt: number
  updatedAt: number
}

/**
 * SessionManager 操作接口——工厂依赖。
 *
 * 只暴露 surface 需要的最小方法集，不耦合 Electron 的
 * `SessionManager` class 全量 API。
 */
export interface SessionOps {
  create(config: {
    sessionId: string
    name: string
    mode: 'chat'
    threadIdGeneratedBy: 'frontend' | 'backend'
  }): SessionRecord
  get(sessionId: string): SessionRecord | null
  list(): SessionRecord[]
  delete(sessionId: string): boolean
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface SessionCreateInput {
  sessionId: string
  name: string
  mode: 'chat'
  threadIdGeneratedBy: 'frontend' | 'backend'
}

export interface SessionCreateOutput {
  session: SessionRecord
}

export interface SessionGetInput {
  sessionId: string
}

export interface SessionDeleteInput {
  sessionId: string
}

export interface SessionDeleteOutput {
  success: boolean
}

// ─── 工厂 ─────────────────────────────────────────────────────────

/**
 * 创建 session 模块的 4 个 PlatformSurface。
 *
 * 调用时机：宿主启动阶段（Electron startup-services / Daemon 启动链路）。
 * 内部调用 `definePlatformSurface` 自动注册到全局 registry。
 */
export function createSessionSurfaces(ops: SessionOps) {
  const sessionCreate = definePlatformSurface({
    module: 'session',
    verb: 'create',
    kind: 'local',
    risk: 'write', // ：创建 session 记录，属状态写
    errorCodes: ['VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: SessionCreateInput): Promise<SessionCreateOutput> => {
      if (!input?.sessionId) {
        throw new SurfaceError('VALIDATION_ERROR', 'sessionId 是必填参数')
      }
      const session = ops.create(input)
      return { session }
    },
  })

  const sessionGet = definePlatformSurface({
    module: 'session',
    verb: 'get',
    kind: 'local',
    errorCodes: ['NOT_FOUND'] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: SessionGetInput): Promise<SessionRecord> => {
      if (!input?.sessionId) {
        throw new SurfaceError('NOT_FOUND', 'sessionId 是必填参数')
      }
      const session = ops.get(input.sessionId)
      if (!session) {
        throw new SurfaceError('NOT_FOUND', `session ${input.sessionId} 不存在`)
      }
      return session
    },
  })

  const sessionList = definePlatformSurface({
    module: 'session',
    verb: 'list',
    kind: 'local',
    errorCodes: [] as const,
    bindings: { ipc: true, http: true },

    handler: async (): Promise<SessionRecord[]> => {
      return ops.list()
    },
  })

  const sessionDelete = definePlatformSurface({
    module: 'session',
    verb: 'delete',
    kind: 'local',
    risk: 'high-risk-write', // ：删除 session 不可逆
    errorCodes: ['NOT_FOUND'] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: SessionDeleteInput): Promise<SessionDeleteOutput> => {
      if (!input?.sessionId) {
        throw new SurfaceError('NOT_FOUND', 'sessionId 是必填参数')
      }
      const success = ops.delete(input.sessionId)
      return { success }
    },
  })

  return { sessionCreate, sessionGet, sessionList, sessionDelete }
}
