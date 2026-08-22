/**
 * RelaySessionOrchestrator —— 收拢两端 Host（Electron / Daemon）里
 * 「relay outbox recover + 活跃 session backfill」的胶水。
 *
 * 之前双端各自实现：
 *   1. 启动时：resolveOwnerBestEffort → activateOwner → outbox.recover
 *      → reconcileAllSessionsRelayBackfill；
 *   2. WS 重连时：outbox.recover → reconcileAllSessionsRelayBackfill；
 *   3. 每轮 query 前置：单 session backfill（reconcileSessionRelay）；
 *   4. session 换主 owner 时：activateOwner + 上面 (2)。
 *
 * 三段流程完全同源、只在 platform 层（token / apiBase / logger）不同——本编排
 * 器把「recover + backfill 顺序 / SingleFlight 去重 / SessionMessagesNotFoundError
 * 静默」统一到 agent-host，宿主只喂：
 *   - {@link RelaySessionOrchestratorDeps.outbox}：`MessageDeliveryOutbox`
 *     （持久化 + recover）；
 *   - {@link RelaySessionOrchestratorDeps.listStorage}：迭代当前活跃 session
 *     的存储句柄（transcript + block records + events.jsonl）；
 *   - {@link RelaySessionOrchestratorDeps.resolveOwner}：宿主端 owner 解析
 *     （Electron 走 IPC，Daemon 走 config，best-effort）；
 *   - {@link RelaySessionOrchestratorDeps.getApiBaseUrl} + `getAccessToken`：
 *     REST fetch 参数；
 *   - {@link RelaySessionOrchestratorDeps.logger}：结构化日志。
 *
 * `sessionId` 由本模块统一从 `mapKey + businessThreadId` 解析（
 * {@link resolveRelaySessionIdForReconcile}），与 host 内部 abort / cancel 用
 * 同一 helper，不再由两端 host 重复调用/漂移。
 */

import type {
  MessageBlockRecord,
  PersistedEntryOwner,
  TranscriptEntry,
} from '@tabtin/agent-runtime'

import type { MessageDeliveryOutbox } from './message-delivery-outbox.js'
import {
  SessionMessagesNotFoundError,
  fetchAllServerMessageRefs,
  reconcileSessionRelay,
  resolveRelaySessionIdForReconcile,
  type RelayReconcileResult,
} from './relay-reconcile.js'
import { SingleFlight } from './relay-transport.js'

/**
 * 单 session 的存储视图，恰好是 `reconcileSessionRelay` 需要的输入。
 * host 侧 SessionStorage 通过 adapter 转成这个契约。
 */
export interface RelaySessionStorageView {
  /** `sessions` Map 的原生 key。 */
  mapKey: string
  /** 稳定业务 thread ID（chat-session-<uuid> / 回落 mapKey）。 */
  businessThreadId?: string | null
  /** 落 outbox / relay 时的 owner；`undefined` 表示当前不知归属，跳过。 */
  owner?: PersistedEntryOwner
  /** events.jsonl 绝对路径（EventStorage.filePath）。 */
  eventsFilePath: string
  /** 加载 transcript entries（SessionStorage.loadTranscript）。 */
  loadTranscript(): Promise<TranscriptEntry[]>
  /** 加载 block records（SessionStorage.blockStorage.load，失败允许返回 []）。 */
  loadBlockRecords(): Promise<MessageBlockRecord[]>
}

export interface RelaySessionOrchestratorLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

export interface RelaySessionOrchestratorDeps {
  outbox: MessageDeliveryOutbox
  logger: RelaySessionOrchestratorLogger
  /**
   * 返回当前活跃 session 的存储视图；顺序不影响正确性（单 session 失败不阻断
   * 其余，与老实现一致）。
   */
  listStorage(): Iterable<RelaySessionStorageView>
  /** 生成 REST base URL（Electron 用全局常量、Daemon 由 config 派生）。 */
  getApiBaseUrl(): string
  /** best-effort 拿当前主 owner（未登录 / 未鉴权时可返回 null/undefined）。 */
  resolveOwner(): Promise<PersistedEntryOwner | undefined>
  /** REST 取 token。返回 null 表示未鉴权，本轮 backfill skip。 */
  getAccessToken(): Promise<string | null>
}

/**
 * 编排 relay outbox recover 与活跃 session backfill，做单飞去重。
 *
 * 该类**不**订阅 gateway.reconnect —— 订阅归属宿主（Electron / Daemon 用各自的
 * gateway 接口），宿主收到 reconnect 时调 {@link kickRecoverAndBackfill} 即可。
 */
export class RelaySessionOrchestrator {
  private readonly reconcileGuard = new SingleFlight()

  constructor(private readonly deps: RelaySessionOrchestratorDeps) {}

  /**
   * 启动 / 重连使用：resolveOwner → activateOwner → outbox.recover → 活跃
   * session backfill。所有异常都进 warn 日志，不抛出——宿主 fire-and-forget 调用。
   */
  async kickRecoverAndBackfill(options: {
    /** 是否在 recover 前尝试 activateOwner（启动路径需要，reconnect 路径可传 false）。 */
    activateOwner: boolean
  }): Promise<void> {
    try {
      if (options.activateOwner) {
        const owner = await this.deps.resolveOwner()
        if (owner) this.deps.outbox.activateOwner(owner)
      }
      await this.deps.outbox.recover()
    } catch (err) {
      this.deps.logger.warn(
        `[RelaySessionOrchestrator] recover failed: ${errMessage(err)}`,
      )
      // recover 失败仍尝试 backfill —— backfill 依赖内存 session，不受落盘残留影响。
    }
    await this.reconcileAllSessions()
  }

  /**
   * 遍历活跃 session 做 backfill，用 SingleFlight 防重入。单 session 失败不阻断
   * 其余；`SessionMessagesNotFoundError` 视作「服务端已彻底删掉该 session」正常态。
   */
  reconcileAllSessions(): Promise<void> {
    return this.reconcileGuard.run(async () => {
      for (const view of this.deps.listStorage()) {
        const relaySessionId = resolveRelaySessionIdForReconcile({
          mapKey: view.mapKey,
          businessThreadId: view.businessThreadId ?? undefined,
        })
        if (!relaySessionId) continue
        try {
          await this.reconcileSession(view, relaySessionId)
        } catch (err) {
          this.handleReconcileError(err, relaySessionId, 'batch backfill')
        }
      }
    })
  }

  /**
   * 单 session backfill（pre-query 使用）。
   *
   * @param relaySessionId 若已知，由调用方传入避免重复解析；缺省时按 view 派生。
   */
  async reconcileOne(
    view: RelaySessionStorageView,
    relaySessionId?: string,
  ): Promise<RelayReconcileResult | undefined> {
    const sessionId =
      relaySessionId
      ?? resolveRelaySessionIdForReconcile({
        mapKey: view.mapKey,
        businessThreadId: view.businessThreadId ?? undefined,
      })
    if (!sessionId) return undefined
    return this.reconcileSession(view, sessionId)
  }

  private async reconcileSession(
    view: RelaySessionStorageView,
    relaySessionId: string,
  ): Promise<RelayReconcileResult | undefined> {
    const token = await this.deps.getAccessToken()
    if (!token) return undefined
    if (!view.owner) return undefined

    const transcriptEntries = await view.loadTranscript()
    // block 文件失败允许回退，与旧实现一致。
    const blockRecords = await view.loadBlockRecords().catch(() => [])

    const owner = view.owner
    const result = await reconcileSessionRelay({
      sessionId: relaySessionId,
      eventsFilePath: view.eventsFilePath,
      transcriptEntries,
      blockRecords,
      fetchServerMessageRefs: () =>
        fetchAllServerMessageRefs({
          apiBaseUrl: this.deps.getApiBaseUrl(),
          sessionId: relaySessionId,
          getAccessToken: () => this.deps.getAccessToken(),
          organizationId: owner.organizationId,
        }),
      sendRelayEvents: (events) =>
        this.deps.outbox.send(owner, relaySessionId, events, {
          deliveryMetadata: { deliveryMode: 'backfill' },
        }),
    })

    if (result.sent > 0) {
      this.deps.logger.info(
        `[RelaySessionOrchestrator] backfilled session=${shortId(relaySessionId)} `
          + `planned=${result.planned} sent=${result.sent} skipped=${result.skipped}`,
      )
    }
    return result
  }

  private handleReconcileError(
    err: unknown,
    relaySessionId: string,
    context: string,
  ): void {
    if (err instanceof SessionMessagesNotFoundError) {
      this.deps.logger.debug(
        `[RelaySessionOrchestrator] session gone, skip ${context} session=${shortId(relaySessionId)}`,
      )
      return
    }
    this.deps.logger.warn(
      `[RelaySessionOrchestrator] ${context} failed session=${shortId(relaySessionId)}: ${errMessage(err)}`,
    )
  }
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
