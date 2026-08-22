import WebSocket from 'ws';
import { WsGatewayClient, AgentActionEvents, LocalRuntimeEvents, type GatewayEnvelope } from '@tabtin/ws-gateway-client';
import type { DaemonConfig, FatalExitHandler } from '../../base/types/daemon-config.js';
import type { Logger } from '../../platform/observability/logging/logger.js';
import { OfflineState } from '../../base/errors/offline-state.js';

export type EventCallback = (envelope: GatewayEnvelope) => void;
export type AsyncEventCallback = (envelope: GatewayEnvelope) => Promise<void>;

const AGENT_ENVELOPE_EVENT_TYPES = new Set<string>([
  'agent.prompt.forward',
  'agent.prompt.cancel',
  'agent.prompt.pause',
  'agent.prompt.resume',
  'agent.subagent.cancel',
  'agent.permission.response',
  'agent.permission.reset_session',
  'agent.permission.mode_update',
  LocalRuntimeEvents.USER_RESPONSE,
  AgentActionEvents.APPROVAL_MEMO_UPDATED,
]);

export class DaemonGatewayClient {
  private readonly client: WsGatewayClient;
  private readonly config: DaemonConfig;
  private readonly logger: Logger;
  private onAction: EventCallback | null;
  private onAgentEnvelope: EventCallback | null = null;
  private onGitDiffRequest: AsyncEventCallback | null = null;
  private onCapabilityRefreshRequest: AsyncEventCallback | null = null;
  private acceptingWorkIngress = true;
  private subscribedTopics = new Set<string>();
  private readonly offlineState: OfflineState;
  private reconnectCallbacks: Array<() => void | Promise<void>> = [];
  private currentAccessToken: string;
  private reconnectCount = 0;

  /** WS auth permanently failed — Daemon should trigger fatal exit (WS-C8-P1-1). */
  onFatalAuthError: FatalExitHandler | null = null;

  constructor(
    config: DaemonConfig,
    logger: Logger,
    onAction?: EventCallback,
  ) {
    this.config = config;
    this.logger = logger;
    this.onAction = onAction ?? null;
    this.offlineState = new OfflineState(logger);
    this.currentAccessToken = config.credential;

    this.client = new WsGatewayClient({
      role: 'daemon',
      capabilities: ['agent.action'],
      deviceId: config.fingerprint,
      wsBaseUrl: config.ws_url,
      WebSocketImpl: WebSocket as any,
      reconnectMinDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      reconnectFactor: 1.5,
      healthCheckIntervalMs: 10_000,
      idleTimeoutMs: 45_000,
      refreshAuth: async () => ({
        token: this.currentAccessToken,
        organizationId: this.config.organization_id,
      }),
      tokenRevalidateIntervalMs: 5 * 60 * 1000,
      onEvent: (envelope) => this.handleEvent(envelope),
      onStatusChange: (status) => {
        if (status !== 'ready') {
          this.offlineState.fail('ws', `status: ${status}`);
        }
        this.logger.debug(`WS status: ${status}`);
      },
      onReady: (info) => {
        this.offlineState.recover();
        this.logger.info(`WS connected${info.reconnected ? ' (reconnected)' : ''}`);
        if (info.reconnected) {
          this.reconnectCount++;
          this.resubscribeAllTopics()
            .then(() => {
              this.fireReconnectCallbacks();
            })
            .catch((err) => {
              this.logger.error(
                `[WS] Resubscribe after reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              this.fireReconnectCallbacks();
            });
        }
      },
      onError: (error) => {
        this.offlineState.fail('ws', error.message);
        if (
          'code' in error &&
          (error as Error & { code?: string }).code === 'WS_RESUME_OVERFLOW'
        ) {
          this.logger.warn('[WS] Resume overflow detected — triggering compensating sync');
          this.fireReconnectCallbacks();
        }
      },
      onAuthFailed: (error) => {
        this.logger.error(`[WS] Auth permanently failed: ${error.message} (code: ${error.code ?? 'unknown'})`);
        this.offlineState.fail('ws_auth', error.message);
        this.onFatalAuthError?.();
      },
    });
  }

  /** Bind the action consumer before connect; explicit wiring avoids constructor cycles. */
  bindActionHandler(handler: EventCallback): void {
    if (this.onAction) throw new Error('Gateway action handler is already bound');
    this.onAction = handler;
  }

  async connect(): Promise<void> {
    this.logger.info(`Connecting to ${this.config.ws_url}...`);
    const ok = await this.client.connect({
      token: this.currentAccessToken,
      organizationId: this.config.organization_id,
    });
    if (!ok) {
      throw new Error('Failed to connect to TabTin backend');
    }
    this.logger.info('WS authenticated successfully');
    await this.subscribeDeviceTopic();
  }

  private async resubscribeAllTopics(): Promise<void> {
    const topics = Array.from(this.subscribedTopics);
    this.subscribedTopics.clear();

    // Always re-subscribe the device topic first
    await this.subscribeDeviceTopic();

    // Re-subscribe any remaining action topics (e.g. active thread topics)
    const remaining = topics.filter(t => !this.subscribedTopics.has(t));
    if (remaining.length === 0) return;
    const res = await this.client.subscribe(remaining);
    if (res.ok) {
      for (const t of remaining) this.subscribedTopics.add(t);
      this.logger.info(`Re-subscribed ${remaining.length} topic(s) after reconnect`);
    } else {
      this.logger.warn(`Failed to re-subscribe topics after reconnect: ${res.error?.message}`);
    }
  }

  private async subscribeDeviceTopic(): Promise<void> {
    const topic = `agent.action.device.${this.config.fingerprint}`;
    const res = await this.client.subscribe([topic]);
    if (res.ok) {
      this.subscribedTopics.add(topic);
      this.logger.info(`Subscribed to device action topic: ${topic}`);
    } else {
      throw new Error(`Failed to subscribe to device topic ${topic}: ${res.error?.message}`);
    }
  }

  async subscribeToActionTopic(threadId: string): Promise<void> {
    const topic = `agent.action.${threadId}`;
    if (this.subscribedTopics.has(topic)) return;
    const res = await this.client.subscribe([topic]);
    if (res.ok) {
      this.subscribedTopics.add(topic);
      this.logger.debug(`Subscribed to ${topic}`);
    } else {
      this.logger.warn(`Failed to subscribe to ${topic}: ${res.error?.message}`);
    }
  }

  async unsubscribeFromActionTopic(threadId: string): Promise<void> {
    const topic = `agent.action.${threadId}`;
    if (!this.subscribedTopics.has(topic)) return;
    try {
      await this.client.unsubscribe([topic]);
      this.subscribedTopics.delete(topic);
      this.logger.debug(`Unsubscribed from ${topic}`);
    } catch (err) {
      this.logger.warn(`Failed to unsubscribe from ${topic}: ${err}`);
    }
  }

  /**
   * AgentHost / AgentRealtime 用的通用 topic 订阅（幂等）。
   * 设备 topic 已在 connect 时订阅；此处对已登记 topic 直接跳过。
   */
  async subscribeTopics(topics: string[]): Promise<void> {
    const fresh = topics.filter((topic) => topic && !this.subscribedTopics.has(topic));
    if (fresh.length === 0) return;
    const res = await this.client.subscribe(fresh);
    if (!res.ok) {
      throw new Error(res.error?.message ?? 'Agent topic subscription failed');
    }
    for (const topic of fresh) this.subscribedTopics.add(topic);
  }

  async unsubscribeTopics(topics: string[]): Promise<void> {
    const existing = topics.filter((topic) => topic && this.subscribedTopics.has(topic));
    if (existing.length === 0) return;
    try {
      await this.client.unsubscribe(existing);
      for (const topic of existing) this.subscribedTopics.delete(topic);
    } catch (err) {
      this.logger.warn(`Failed to unsubscribe Agent topics: ${err}`);
    }
  }

  async sendActionResult(
    threadId: string,
    taskId: string,
    result: Record<string, any>,
    traceId?: string,
  ): Promise<void> {
    const response = await this.client.request(
      { token: this.currentAccessToken, organizationId: this.config.organization_id },
      AgentActionEvents.RESULT,
      {
        task_id: taskId,
        ...result,
        ...(traceId ? { trace_id: traceId } : {}),
      },
      { threadId },
    );
    if (!response.ok) {
      this.logger.warn(`Failed to send action result: ${response.error?.message}`);
    }
  }

  /**
   * Register a callback for agent envelope messages (prompt forward, cancel,
   * permission response, approval response, local-runtime HITL responses).
   * Called by the Daemon during startup to dispatch agent-related envelopes.
   */
  setAgentEnvelopeHandler(handler: EventCallback): void {
    this.onAgentEnvelope = handler;
  }

  /**
   * Register handler for on-demand git diff requests from the frontend (Phase 4).
   */
  setGitDiffHandler(handler: AsyncEventCallback): void {
    this.onGitDiffRequest = handler;
  }

  setCapabilityRefreshHandler(handler: AsyncEventCallback): void {
    this.onCapabilityRefreshRequest = handler;
  }

  /** Stop accepting inbound work while keeping the socket available for final outbound flushes. */
  suspendIngress(): void {
    this.acceptingWorkIngress = false;
  }

  /**
   * Send git diff response back to backend for relay to the requesting frontend.
   */
  async sendGitDiffResponse(
    replyTo: string,
    filePath: string,
    diff: string,
  ): Promise<void> {
    try {
      const response = await this.client.request(
        { token: this.currentAccessToken, organizationId: this.config.organization_id },
        'git.diff.response',
        { reply_to: replyTo, file_path: filePath, diff },
      );
      if (!response.ok) {
        this.logger.debug(`git.diff.response rejected: ${response.error?.message}`);
      }
    } catch {
      this.logger.debug('git.diff.response send failed');
    }
  }

  /**
   * Push fresh git status to backend for immediate broadcast (Phase 2).
   * Best-effort: failures are logged but not thrown — heartbeat will sync eventually.
   */
  async sendGitStatus(gitStatus: Record<string, any>): Promise<void> {
    try {
      const response = await this.client.request(
        { token: this.currentAccessToken, organizationId: this.config.organization_id },
        'git.status.report',
        { git_status: gitStatus },
      );
      if (!response.ok) {
        this.logger.debug(`git.status.report rejected: ${response.error?.message}`);
      }
    } catch {
      this.logger.debug('git.status.report send failed — heartbeat will sync');
    }
  }

  async sendDeviceCapabilitiesReport(
    capabilities: string[],
    systemInfo: Record<string, any>,
    status: 'online' | 'busy' | 'offline' = 'online',
  ): Promise<void> {
    const response = await this.client.request(
      { token: this.currentAccessToken, organizationId: this.config.organization_id },
      'device.capabilities.report',
      {
        status,
        capabilities,
        system_info: systemInfo,
      },
    );
    if (!response.ok) {
      this.logger.warn(`Failed to send device.capabilities.report: ${response.error?.message}`);
    }
  }

  async sendCapabilityRefreshAck(refreshRequestId: string, payload: Record<string, any> = {}): Promise<void> {
    const response = await this.client.request(
      { token: this.currentAccessToken, organizationId: this.config.organization_id },
      'device.capabilities.refresh.ack',
      {
        refresh_request_id: refreshRequestId,
        ...payload,
      },
    );
    if (!response.ok) {
      this.logger.warn(`Failed to send capability refresh ack: ${response.error?.message}`);
    }
  }

  async sendCapabilityRefreshResult(refreshRequestId: string, payload: Record<string, any> = {}): Promise<void> {
    const response = await this.client.request(
      { token: this.currentAccessToken, organizationId: this.config.organization_id },
      'device.capabilities.refresh.result',
      {
        refresh_request_id: refreshRequestId,
        ...payload,
      },
    );
    if (!response.ok) {
      this.logger.warn(`Failed to send capability refresh result: ${response.error?.message}`);
    }
  }

  /**
   * Batch-relay local Runtime stream events to Django for frontend broadcast.
   * Equivalent to Electron's `electronWsGateway.request('relay_events', ...)`.
   *
   * Django receives these and broadcasts them on the `agent.stream.{sessionId}`
   * topic so mobile/web frontends see live stream updates.
   */
  async relayEvents(
    sessionId: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ): Promise<void> {
    const response = await this.client.request(
      { token: this.currentAccessToken, organizationId: this.config.organization_id },
      'relay_events',
      { session_id: sessionId, events },
    );
    if (!response.ok) {
      throw new Error(`Failed to relay events: ${response.error?.message}`);
    }
  }

  /**
   * Send a runtime event back to the backend.
   * Used by the local agent runtime to report output (text, tool calls, etc.).
   */
  async sendAgentEvent(
    threadId: string,
    messageType: string,
    payload: Record<string, any>,
  ): Promise<void> {
    const response = await this.client.request(
      { token: this.currentAccessToken, organizationId: this.config.organization_id },
      messageType,
      payload,
      { threadId },
    );
    if (!response.ok) {
      throw new Error(`Failed to send agent event ${messageType}: ${response.error?.message}`);
    }
  }

  /**
   * Register a callback to be invoked after a successful WS reconnection.
   * Used to replay buffered offline messages or refresh subscription state.
   */
  onReconnect(callback: () => void | Promise<void>): void {
    this.reconnectCallbacks.push(callback);
  }

  private fireReconnectCallbacks(): void {
    for (const cb of this.reconnectCallbacks) {
      try {
        const result = cb();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            this.logger.warn(`Reconnect callback failed: ${err}`);
          });
        }
      } catch (err) {
        this.logger.warn(`Reconnect callback error: ${err}`);
      }
    }
  }

  close(): void {
    this.client.close();
    this.subscribedTopics.clear();
  }

  getStatus(): string {
    return this.client.getStatus();
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }

  getAccessToken(): string {
    return this.currentAccessToken;
  }

  acknowledgeApplicationEvent(eventId: string, topic: string): void {
    this.client.acknowledgeApplicationEvent(eventId, topic);
  }

  /**
   * Update the in-memory access token after successful renewal (CD-006).
   * All subsequent WS requests and getAccessToken() calls will use the new value.
   */
  updateAccessToken(token: string): void {
    this.currentAccessToken = token;
    this.logger.info('[Gateway] Access token updated dynamically');
  }

  private handleEvent(envelope: GatewayEnvelope): void {
    // ── 通道 A：Agent 任务执行通道 ────────────────────────────────────────────
    // agent.action.request（AgentActionEvents.REQUEST）
    // 由后端 Backend 发出，触发 Daemon 执行一个 Agent 任务（工具调用、代码执行等）。
    // 路由到 onAction，由 DaemonActionBridge 处理。
    if (envelope.type === AgentActionEvents.REQUEST) {
      if (!this.acceptingWorkIngress) return;
      this.dispatchAction(envelope);
      return;
    }

    if (envelope.type === 'agent.action.cancel') {
      this.dispatchAction(envelope);
      return;
    }

    // ── 通道 B：Agent Envelope 通道（多个语义不同的子通道，统一路由到 onAgentEnvelope）──
    //
    // 子通道 B1：提示转发通道（Prompt Relay）
    //   - agent.prompt.forward  — Backend 将前端用户输入转发给本地 runtime
    //   - agent.prompt.cancel   — 前端/其他设备取消当前推理
    //   语义：单向的用户输入中继，Daemon/Electron 收到后驱动本地 runtime。
    //
    // 子通道 B3：会话权限通道（Session-Level Permission）
    //   - agent.permission.response      — 前端对实时权限请求的应答（允许/拒绝）
    //   - agent.permission.reset_session — 前端重置当前 Agent 会话的权限状态
    //   - agent.permission.mode_update   — 前端更新权限模式（如 auto/manual/readonly）
    //   语义：会话粒度 的持久权限策略配置，不绑定具体任务，影响后续所有操作的判断。
    //
    // ── 通道 B4：本地 Runtime HITL 回传 ───────────────────────────────────────
    //   - localrt.user_response — 前端用户对 review_required / ask_user_required
    //     做出的决策回传（经 Django WS 中继），语义为单次 HITL 交互回答。
    //     B4 是本地 Runtime PermissionHandler / ask_user 的回传。
    // ── 通道 B5：跨设备 always memo 缓存失效广播（W2-轮 2 / PRD 05 §7.3）─────
    //   - agent.action.approval_memo_updated — Django 在 Agent.agent_config.
    //     approval_memo 写入后广播到 organization.{wid} + agent.action.{aid} topic；
    //     payload: { agent_id, generation }；客户端按 generation 比对触发
    //     ApprovalMemoStore.maybeRefetch。Daemon 通过 setAgentEnvelopeHandler
    //     拿到，再分发到 DaemonAgentHost.handleApprovalMemoUpdated。
    if (AGENT_ENVELOPE_EVENT_TYPES.has(envelope.type)) {
      if (envelope.type === 'agent.prompt.forward' && !this.acceptingWorkIngress) return;
      if (this.onAgentEnvelope) {
        this.onAgentEnvelope(envelope);
      } else {
        this.logger.warn(`Agent bridge message received but no handler registered: ${envelope.type}`);
      }
      return;
    }

    if (envelope.type === 'git.diff.request') {
      if (!this.acceptingWorkIngress) return;
      if (this.onGitDiffRequest) {
        this.onGitDiffRequest(envelope).catch((err) => {
          this.logger.warn(`git.diff.request handler failed: ${err}`);
        });
      }
      return;
    }

    if (envelope.type === 'device.capabilities.refresh.request') {
      if (!this.acceptingWorkIngress) return;
      if (this.onCapabilityRefreshRequest) {
        this.onCapabilityRefreshRequest(envelope).catch((err) => {
          this.logger.warn(`device.capabilities.refresh.request handler failed: ${err}`);
        });
      } else {
        this.logger.warn('Capability refresh request received but no handler registered');
      }
      return;
    }

    if (envelope.type === 'subscribe.notify') {
      this.logger.debug(`Subscription event: ${JSON.stringify(envelope.payload)}`);
      return;
    }

    this.logger.debug(`Unhandled event: ${envelope.type}`);
  }

  private dispatchAction(envelope: GatewayEnvelope): void {
    if (!this.onAction) {
      this.logger.error(`[Gateway] Action received before handler binding: ${envelope.type}`);
      return;
    }
    this.onAction(envelope);
  }
}
