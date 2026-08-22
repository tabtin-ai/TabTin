/**
 * runtimeStoreAccess — hub 访问 `useChatRuntimeStore` 的依赖倒置汇合点（零依赖 leaf）。
 *
 * ## 为什么
 *
 * agentService 属于比 store 更底层的传输/编排层，不应静态 import
 * `useChatRuntimeStore`（否则形成 hub → store 反向依赖）。与 `messageWriteGate`
 * 同款：store 侧在 module body 注册实现，hub 通过本 leaf 读出——依赖方向恒为
 * store → hub。
 *
 * ## 注册时机
 *
 * `useChatRuntimeStore.ts` module body 末尾调 `runtimeStoreAccess.registerAccess`。该模块
 * 被 `useChatStore` 静态 import（app 启动即加载），注册早于任何用户触发的
 * `attachStream` / 后台 push 到达，故 hub 取用时恒已就绪。
 */

import type {
  AgentStreamMessage,
  StreamHandlerStore,
  StreamHandlerDeps,
} from '@/stores/chat/stream/handlers/streamMessageHandler'

export interface RuntimeStoreAccess {
  /** 运行时 store 快照（stream handler 读侧）。 */
  get: () => StreamHandlerStore
  /** 运行时 store 写入（stream handler 写侧，含 zustand replace 重载）。 */
  set: StreamHandlerDeps['set']
  /**
   * 同步刷出 rAF 批量的 runState / tools / steps 等 pending 写入。
   * hub 读 `runStateBySessionId` 前必须先调（见 envelope.terminal / ），
   * 否则会读到 flush 前的旧快照、误把 lifecycle 的 `phase:done` 盖成 `cancelled`。
   */
  flushRuntimeBatch: () => void
  /** push 通知到达时按 archive 对账子 Agent runs。 */
  reconcileSubagentRunsFromArchive: (
    sessionId: string,
    options?: { organizationId?: string; spaceId?: string },
  ) => Promise<void>
}

// ── stream handler 工厂（ 阶段B：hub 不静态 import store 层 createStreamMessageHandler）──
//
// 单独一个注册槽（不并入 RuntimeStoreAccess）——工厂需 import streamMessageHandler，
// 而 streamMessageHandler → lifecycleHandler → useChatStore 是条延迟环。若从
// useChatRuntimeStore module body 注册，会让「approvalSlice → sessionRunProjection →
// useChatRuntimeStore」这条早加载链**静态**拉进 streamMessageHandler → useChatStore，
// 在 useChatStore 尚未装配完时触发其 create()（createApprovalActions 未定义即崩）。
// 故改由 chatStoreBootstrap（useChatStore 末尾运行、延迟环安全）注册。

type StreamHandlerFactory = (deps: StreamHandlerDeps) => (message: AgentStreamMessage) => void

/**
 * hub 访问运行时 store 的单例注册表，持两个独立注册槽：
 *   - `access`：`useChatRuntimeStore` module body 注册的读写实现；
 *   - `streamHandlerFactory`：`chatStoreBootstrap` 注册的 stream handler 工厂（见上方注释）。
 *
 * 全局唯一一份状态，class 只为给这两槽一个明确宿主（与 streamControlPorts /
 * rollbackRegistry 风格统一）。两槽各有独立的 test-only 重置，以对齐现有测试的按槽重置语义。
 */
class RuntimeStoreAccessRegistry {
  private access: RuntimeStoreAccess | null = null
  private streamHandlerFactory: StreamHandlerFactory | null = null

  // ── stream handler 工厂槽 ──

  /** 由 chatStoreBootstrap 注册（app 启动、useChatStore 装配完成后）。 */
  registerStreamHandlerFactory(fn: StreamHandlerFactory): void {
    this.streamHandlerFactory = fn
  }

  /** 取 stream handler 工厂；未注册即抛（attachStream 关键路径，fail-fast）。 */
  requireStreamHandlerFactory(): StreamHandlerFactory {
    if (!this.streamHandlerFactory) {
      throw new Error('[agentService] stream handler factory 尚未注册（chatStoreBootstrap 未运行？）')
    }
    return this.streamHandlerFactory
  }

  /** Test-only：重置工厂注册。 */
  resetStreamHandlerFactoryForTest(): void {
    this.streamHandlerFactory = null
  }

  // ── 运行时 store 访问槽 ──

  /** 由 `useChatRuntimeStore.ts` module body 注册。 */
  registerAccess(access: RuntimeStoreAccess): void {
    this.access = access
  }

  /** 读出运行时 store 访问实现（未注册时返回 null，仅非关键 fire-and-forget 路径可容忍）。 */
  getAccess(): RuntimeStoreAccess | null {
    return this.access
  }

  /**
   * 读出运行时 store 访问实现，未注册即抛。
   *
   * 用于 stream handler 构造这类**关键路径**——必须有 store 才能处理事件；未注册
   * 属编程/加载顺序错误，fail-fast 而非静默降级。
   */
  requireAccess(): RuntimeStoreAccess {
    if (!this.access) {
      throw new Error('[agentService] runtime store access 尚未注册（useChatRuntimeStore 未加载？）')
    }
    return this.access
  }

  /** Test-only：重置访问注册。 */
  resetAccessForTest(): void {
    this.access = null
  }
}

export const runtimeStoreAccess = new RuntimeStoreAccessRegistry()
