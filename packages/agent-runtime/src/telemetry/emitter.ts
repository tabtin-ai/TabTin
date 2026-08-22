/**
 * Telemetry emitter——Runtime 内部全局单例。
 *
 * 关键契约：
 *   - 默认 sink 是 no-op，**导入 Runtime 不会产生任何副作用**（避免测试/SDK 消费者意外落盘）。
 *   - 宿主在启动时显式调用 `setTelemetrySink(sink)` 注入实际落地逻辑。
 *   - `emitTelemetryEvent` 永不抛异常；sink 抛异常会被吞掉并可选打印到 stderr（仅 debug 模式）。
 *
 * 为什么是"全局单例"而非"通过 EngineConfig 注入"：
 *   - 补埋点位置（proxy-provider / doom-loop-guard / compaction-orchestrator）散落在多处，
 *     每处都透传 sink 对象会让签名膨胀、破坏既有接口。
 *   - 每个宿主进程只有一个事实上的埋点目的地，单例语义与事实匹配。
 *   - 测试场景可用 `resetTelemetrySink()` 复位。
 */

import type { TelemetryEmitOptions, TelemetryRecord, TelemetrySink } from './types.js';

const NOOP_SINK: TelemetrySink = () => {
  /* no-op */
};

let activeSink: TelemetrySink = NOOP_SINK;
let debugEnabled = false;

/**
 * 注入 sink。传入 `null` 等价于复位为 no-op。
 *
 * 调用时机：宿主进程启动阶段，越早越好（在 `createRuntime` 之前）。
 */
export function setTelemetrySink(sink: TelemetrySink | null): void {
  activeSink = sink ?? NOOP_SINK;
}

/**
 * 测试专用复位。生产代码不要调用。
 */
export function resetTelemetrySink(): void {
  activeSink = NOOP_SINK;
  debugEnabled = false;
}

/**
 * 打开 debug 模式：sink 抛异常时转发到 stderr，便于排查埋点错误。
 * 生产环境保持关闭，避免暴露栈信息。
 */
export function setTelemetryDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * 发送一条埋点。**永不抛异常**——埋点失败不应影响业务。
 *
 * ## 参数类型设计（Review #11）
 *
 * 形参声明为 `string` 而非 `TelemetryEventName`，原因：
 *   - **业务代码入口**：`Runtime` / `middleware` / `providers` / `compact` / 宿主
 *     **必须**传 `TelemetryEvents.XXX` 常量；若传字面量则放弃 IDE 跳转 +
 *     rename refactor，Code Review 一定打回——通过 `TELEMETRY.md §8` 强制。
 *   - **逃生出口**：以下场景保留字符串入口：
 *     1. IPC 通用通道（`telemetry-ipc.ts` 的 `telemetry:event` handler）——
 *        事件名来自 renderer，且有 allowlist/rate-limit/sanitizer 三重防线
 *     2. 单元测试（`'test.noop'` / `'unit.phase1'` 等）
 *     3. 临时诊断（`manual.*` 前缀 for DevTools ad-hoc）
 *
 * **若要机械防止字面量**：可在 repo 级 ESLint 配置 `no-restricted-syntax`
 * 规则（示例见 `TELEMETRY.md §8`）；本包不引入以免对消费者生效。
 *
 * @param eventName  事件名。业务调用**必须**走 `TelemetryEvents.XXX`；仅 IPC/测试可用字面量。
 * @param payload    事件业务字段。敏感信息必须先经 `redact.ts` 脱敏。
 * @param options    可选上下文（session_id / agent_id / trace_id）。
 */
export function emitTelemetryEvent(
  eventName: string,
  payload: Record<string, unknown>,
  options?: TelemetryEmitOptions,
): void {
  const record: TelemetryRecord = {
    event_name: eventName,
    timestamp: Date.now(),
    payload,
    ...(options?.session_id ? { session_id: options.session_id } : {}),
    ...(options?.agent_id ? { agent_id: options.agent_id } : {}),
    ...(options?.trace_id ? { trace_id: options.trace_id } : {}),
  };

  try {
    activeSink(record);
  } catch (err) {
    if (debugEnabled) {
      try {
        process.stderr.write(
          `[telemetry:sink_error] ${eventName}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      } catch {
        /* 连 stderr 也写不了就放弃 */
      }
    }
  }
}
