/**
 * @tabtin/agent-runtime/telemetry — 结构化埋点契约（类型定义）
 *
 * 设计目标：
 *   1. Runtime 核心代码只依赖 `emitTelemetryEvent`，不关心落地渠道。
 *   2. 宿主（Electron / Daemon / 未来 Cloud）在启动时注入 sink，决定记录落地到哪里
 *      （electron-log 文件 / stdout / 云端 telemetry endpoint / OTel exporter 等）。
 *   3. 单条事件即一条 JSON 记录，下游运维可用 `grep` / `tail -f | jq` 消费。
 *
 * 契约文档：`packages/agent-runtime/TELEMETRY.md`
 */

/**
 * 单条埋点记录。宿主 sink 接收到后负责序列化与落地。
 */
export interface TelemetryRecord {
  /** 事件名（namespace.action 风格，如 `persona.applied` / `api.error.400`）。 */
  event_name: string;
  /** 产生时间戳（ms since epoch）。 */
  timestamp: number;
  /** 当前 Runtime 会话（如未知可省略）。 */
  session_id?: string;
  /** 触发 Agent（如未知可省略，例如 LLM 请求错误埋点）。 */
  agent_id?: string;
  /** OTel/AdminDash trace id（FR-06/FR-10 交付后全链路贯通）。 */
  trace_id?: string;
  /** 事件业务字段。**严禁**放入敏感原文（persona/custom_rules/user message content），参见 `redact.ts`。 */
  payload: Record<string, unknown>;
}

/**
 * Sink 是一个"傻接收器"——拿到 record 后做序列化 + 写日志 / 上报。
 * - **不抛异常**：emitter 自带 try/catch 兜底，但 sink 仍应自行吞异常。
 * - **允许同步**：当前宿主（Electron / Daemon）用 `electron-log` / 本地 Logger，
 *   一次 emit 的开销 = `JSON.stringify` + `log.info`（electron-log 内部有 buffer），
 *   对业务主循环的影响可忽略。**但不要**在 sink 里做昂贵的网络 I/O / 文件 flush，
 *   若未来需要上报云端，请用 `setImmediate` / `queueMicrotask` 或把 record 扔到
 *   独立 worker / queue，避免阻塞业务线程。
 * - **不递归**：sink 内不得再调 `emitTelemetryEvent`，否则可能栈溢出。
 * - **返回值忽略**：emitter 不 await 返回值；若 sink 返回 Promise，其 rejection
 *   会被吞掉（emitter 层没法 `.catch`），请 sink 自己 `.catch`。
 */
export type TelemetrySink = (record: TelemetryRecord) => void;

/**
 * emit 调用点可携带的上下文（所有字段均可选）。
 */
export interface TelemetryEmitOptions {
  session_id?: string;
  agent_id?: string;
  trace_id?: string;
}
