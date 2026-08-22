/**
 * MTTR（Mean Time To Recovery）标记辅助函数。
 *
 * 用途：
 *   - 运维 / 客服 / on-call 在收到报障时调 `emitMttrStart(incidentId, description)`
 *   - 定位完成时调 `emitMttrResolved(incidentId, resolution, durationMs)`
 *   - 后续从日志 / telemetry sink 消费端聚合 duration_ms，计算 PRD §7.1 的 MTTR 指标
 *
 * 三种触发入口（与 `TELEMETRY.md §6.7` 一致）：
 *   - **Electron**：IPC `telemetry:mttr:start` / `telemetry:mttr:resolved`
 *     实现：`apps/tabtin-electron/src/main/agent/platform/telemetry-ipc.ts`
 *     preload：`window.api.telemetry.mttrStart(...)` / `mttrResolved(...)`
 *     限流：共享 120/60s 桶（与 `telemetry:event` 同桶），超限返回 `rate_limited`
 *   - **Daemon**：独立短命 CLI 子命令
 *     命令：`tabtin-daemon mttr-start --description '...' [--severity p1] ...`
 *           `tabtin-daemon mttr-resolved --incident <id> --duration-ms <ms>`
 *     实现：`apps/tabtin-daemon/src/index.ts` 末尾
 *     推荐用法：`tabtin-daemon mttr-start ... >> ~/.tabtin-daemon/daemon.log`
 *   - **程序内**：`import { emitMttrStart } from '@tabtin/agent-runtime'`
 *     运行时侧已对 `description/resolution/reporter/error_class` 做长度兜底
 *     （`MAX_MTTR_*_LEN`），与 IPC / CLI 层三重防线呼应
 */

import { TelemetryEvents } from './events.js';
import { emitTelemetryEvent } from './emitter.js';
import type { TelemetryEmitOptions } from './types.js';

/**
 * 运行时侧软上限：对 description / resolution 等自由文本字段强制截断。
 *
 * 设计意图：
 *   - Electron IPC / Daemon CLI 两个入口都已各自 truncate，但程序内直接
 *     `import { emitMttrStart }` 的调用方（如未来 orchestration / 诊断工具）
 *     若不截断，可能写入整页 stack trace / 用户消息，撑爆日志。
 *   - 这里做**最后一道防线**；与 TELEMETRY.md §6.7 的字段上限对齐。
 */
const MAX_MTTR_DESCRIPTION_LEN = 200;
const MAX_MTTR_RESOLUTION_LEN = 400;
const MAX_MTTR_NAME_LEN = 80;
const MAX_MTTR_ERROR_CLASS_LEN = 80;

function truncate(input: string | undefined, max: number): string | undefined {
  if (typeof input !== 'string') return input;
  return input.length > max ? input.slice(0, max) : input;
}

/**
 * 生成一个默认的 incident id（运维可自带自定义格式）。格式：`inc-YYYYMMDD-HHmmss-random4`。
 */
export function generateIncidentId(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return [
    'inc',
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    rand,
  ].join('-');
}

export interface MttrStartPayload {
  incident_id: string;
  /** 简短描述（建议 ≤ 120 字符）。不放用户数据，只放症状描述。 */
  description: string;
  /** 由谁报告（人名 / 组件名）。 */
  reporter?: string;
  /** 报告时对应的 session_id（非必填；用于定位具体会话）。 */
  session_id?: string;
  /** 严重级别（可选，按团队约定填：p0 / p1 / p2）。 */
  severity?: string;
}

export function emitMttrStart(
  payload: MttrStartPayload,
  options?: TelemetryEmitOptions,
): void {
  emitTelemetryEvent(
    TelemetryEvents.MTTR_START,
    {
      incident_id: payload.incident_id,
      description: truncate(payload.description, MAX_MTTR_DESCRIPTION_LEN) ?? '',
      ...(payload.reporter
        ? { reporter: truncate(payload.reporter, MAX_MTTR_NAME_LEN) }
        : {}),
      ...(payload.severity ? { severity: truncate(payload.severity, 16) } : {}),
    },
    {
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      ...options,
    },
  );
}

export interface MttrResolvedPayload {
  incident_id: string;
  /** 根因定位 / 处置结论（≤ 200 字符，不放用户数据）。 */
  resolution: string;
  /** 与 start 之间的耗时（ms）。由调用方计算。 */
  duration_ms: number;
  /** 处置方（人名 / 团队）。 */
  resolver?: string;
  /** 关联 session_id。 */
  session_id?: string;
  /** 关联的 error_class（若有，方便和 FR-06 errorClass 交叉分析）。 */
  error_class?: string;
}

export function emitMttrResolved(
  payload: MttrResolvedPayload,
  options?: TelemetryEmitOptions,
): void {
  emitTelemetryEvent(
    TelemetryEvents.MTTR_RESOLVED,
    {
      incident_id: payload.incident_id,
      resolution: truncate(payload.resolution, MAX_MTTR_RESOLUTION_LEN) ?? '',
      duration_ms: payload.duration_ms,
      ...(payload.resolver
        ? { resolver: truncate(payload.resolver, MAX_MTTR_NAME_LEN) }
        : {}),
      ...(payload.error_class
        ? { error_class: truncate(payload.error_class, MAX_MTTR_ERROR_CLASS_LEN) }
        : {}),
    },
    {
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      ...options,
    },
  );
}
