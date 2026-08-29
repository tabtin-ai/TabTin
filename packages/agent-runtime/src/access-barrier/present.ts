/**
 * presentAccessBarrier —— Access Barrier HITL 呈现辅助（非默认策略）。
 *
 * 与 `mode-tools.ts` 的 `switch_mode` 同构（都是「emit 专用卡片
 * + interrupt 挂起 + 超时」），区别是本函数**不是 Tool**——发起方是能力层
 * （`BrowserOrchestratorHostHooks.resolveAccessBarrier`），不经模型 tool_use，
 * 供 Electron CLI 编排出口直接调用（见 plan Task 5）。
 *
 * `agent-runtime` 主循环 / 默认策略栈**不装配**任何墙策略——本文件只是给
 * 宿主用的呈现辅助，不在 `default-policy-hooks.ts` 里被自动调用（设计 §8.2）。
 *
 * `AccessBarrier` / `AccessBarrierResolution` 结构与
 * `@tabtin/browser-core::access-barrier/types.ts` 同名同形，但本文件
 * **不 import browser-core**（避免 agent-runtime 生产路径依赖某个能力包
 * 实现细节——与 `agent-wire/src/access-barrier.ts` 同一策略，两边字段
 * 靠人工对齐同一设计文档）。
 */

import { randomUUID } from 'node:crypto';
import type { InterruptPort } from '../engine/contracts/hitl.js';
import type { RuntimeMode } from '../engine/contracts/tools.js';
import type { StreamEvent } from '../engine/contracts/wire-protocol.js';
import { StreamEvents } from '../engine/contracts/stream-events.js';
import { SingleHitlResolvedEvent } from '../event/events/hitl-events.js';
import { TelemetryEvents } from '../telemetry/events.js';
import type { ObserveFn } from '../engine/contracts/kernel.js';

export type AccessBarrierKind = 'login' | 'captcha' | 'geetest' | 'mfa' | 'unknown_wall';

export type AccessBarrierActionId =
  | 'resume_same_tab'
  | 'alternate_source'
  | 'abort_this_target';

export interface AccessBarrier {
  kind: AccessBarrierKind;
  reason: string;
  /** hostname，未知则 `'unknown'`。 */
  domain: string;
  pageUrl?: string;
  /** 有则卡片可「提到前台」并要求复用同一 tab。 */
  tabId?: string;
  captchaType?: string;
  /** glance / act / open / run_terminal_command … */
  sourceTool?: string;
  /** ISO 时间戳。 */
  detectedAt: string;
  actions: AccessBarrierActionId[];
}

/**
 * 用户决议 / 系统结局判别联合（设计 §5.1）。前三种为用户主动三选一；
 * `timeout` / `skipped` / `host_unavailable` 是系统结局，须诚实失败。
 */
export type AccessBarrierResolution =
  | { action: 'resume_same_tab'; tabId?: string; note?: string }
  | { action: 'alternate_source' }
  | { action: 'abort_this_target' }
  | { action: 'timeout' | 'skipped' | 'host_unavailable' };

const VALID_RESOLUTION_ACTIONS = new Set<string>([
  'resume_same_tab',
  'alternate_source',
  'abort_this_target',
  'timeout',
  'skipped',
  'host_unavailable',
]);

/** scheduled/batch 无人值守、或宿主 HITL 不可用时的诚实失败决议（设计 §7.2 / §7.3）。 */
export function buildUnattendedResolution(_barrier: AccessBarrier): AccessBarrierResolution {
  return { action: 'host_unavailable' };
}

/**
 * 把 host resolve 回来的任意值归一为 `AccessBarrierResolution`；不认识的
 * 形状 fail-closed 落 `host_unavailable`（禁止假装成功——设计 §7.3）。
 */
function coerceResolution(value: unknown): AccessBarrierResolution {
  if (
    value
    && typeof value === 'object'
    && 'action' in value
    && typeof (value as { action?: unknown }).action === 'string'
    && VALID_RESOLUTION_ACTIONS.has((value as { action: string }).action)
  ) {
    return value as AccessBarrierResolution;
  }
  return { action: 'host_unavailable' };
}

/** 卡片请求 HITL 超时（默认 10 分钟——比 ask 三件套的 30 分钟短，撞墙场景通常等不了那么久）。 */
const DEFAULT_ACCESS_BARRIER_TIMEOUT_MS = 10 * 60 * 1000;

export interface PresentAccessBarrierArgs {
  interrupt: InterruptPort;
  barrier: AccessBarrier;
  runtimeMode: RuntimeMode;
  timeoutMs?: number;
  generateId?: () => string;
  /** telemetry 出口；缺省则不打点（供无 observe 的直调测试用）。 */
  observe?: ObserveFn;
  /** telemetry session 标识；缺省不附加。 */
  sessionId?: string;
  /**
   * 对称补发 `single_hitl_resolved` 的出口（对齐 ask 三件套 #2843）。
   * 缺省则只返回决议、不主动收卡——直调测试可不传；宿主生产路径必须注入，
   * 否则超时/取消后前端会留下孤儿 hard 卡挡发送。
   */
  emitStreamEvent?: (event: StreamEvent) => void;
}

/** 卡片已打开后，按 interrupt 结局映射 single_hitl_resolved.outcome。 */
function hitlResolvedOutcome(
  interruptStatus: 'resolved' | 'timeout',
  resolution: AccessBarrierResolution,
  rawValue: unknown,
): 'answered' | 'skipped' | 'expired' | 'cancelled' {
  if (interruptStatus === 'timeout' || resolution.action === 'timeout') {
    return 'expired';
  }
  if (resolution.action === 'skipped') return 'skipped';
  if (rawValue && typeof rawValue === 'object') {
    const record = rawValue as Record<string, unknown>;
    if (record.cancelled === true) return 'cancelled';
    const decisions = record.decisions;
    if (
      Array.isArray(decisions)
      && decisions.some(
        (d) => d && typeof d === 'object' && (d as { outcome?: unknown }).outcome === 'cancelled',
      )
    ) {
      return 'cancelled';
    }
  }
  // fail-closed coerce / 宿主不可用：卡已开过，按 cancelled 收口以免孤儿面板。
  if (resolution.action === 'host_unavailable') return 'cancelled';
  return 'answered';
}

function emitSingleHitlResolved(
  args: PresentAccessBarrierArgs,
  requestId: string,
  outcome: 'answered' | 'skipped' | 'expired' | 'cancelled',
): void {
  args.emitStreamEvent?.(
    new SingleHitlResolvedEvent({
      request_id: requestId,
      interrupt_id: requestId,
      ...(args.sessionId ? { thread_id: args.sessionId } : {}),
      outcome,
      schema_version: 1,
    }).toStreamEvent(),
  );
}

function emitTelemetry(
  args: PresentAccessBarrierArgs,
  eventName: string,
  payload: Record<string, unknown>,
): void {
  args.observe?.(
    eventName,
    payload,
    args.sessionId ? { session_id: args.sessionId } : undefined,
  );
}

/**
 * 呈现访问障碍并等待决议（设计 §7）：
 * - `scheduled` | `batch`（无人值守）→ 不 interrupt，直接诚实失败。
 * - `!interrupt.isAvailable()`（宿主未注入 HITL 通道）→ 诚实失败。
 * - 否则 emit `access_barrier_required` 专用卡片，挂起等用户三选一或超时。
 */
export async function presentAccessBarrier(
  args: PresentAccessBarrierArgs,
): Promise<AccessBarrierResolution> {
  const { interrupt, barrier, runtimeMode } = args;

  if (runtimeMode === 'scheduled' || runtimeMode === 'batch') {
    emitTelemetry(args, TelemetryEvents.ACCESS_BARRIER_HOST_UNAVAILABLE, {
      kind: barrier.kind,
      domain: barrier.domain,
      runtime_mode: runtimeMode,
      reason: 'scheduled_or_batch',
    });
    return buildUnattendedResolution(barrier);
  }

  if (!interrupt.isAvailable()) {
    emitTelemetry(args, TelemetryEvents.ACCESS_BARRIER_HOST_UNAVAILABLE, {
      kind: barrier.kind,
      domain: barrier.domain,
      runtime_mode: runtimeMode,
      reason: 'host_unavailable',
    });
    return buildUnattendedResolution(barrier);
  }

  const requestId = args.generateId ? args.generateId() : randomUUID();
  const timeoutMs = args.timeoutMs ?? DEFAULT_ACCESS_BARRIER_TIMEOUT_MS;

  emitTelemetry(args, TelemetryEvents.ACCESS_BARRIER_PRESENTED, {
    kind: barrier.kind,
    domain: barrier.domain,
    source_tool: barrier.sourceTool,
  });

  const presentedAt = Date.now();
  const outcome = await interrupt.interrupt<AccessBarrierResolution>({
    kind: 'access_barrier',
    interruptId: requestId,
    requestEvent: {
      type: StreamEvents.ACCESS_BARRIER_REQUIRED,
      payload: {
        request_id: requestId,
        barrier,
        expires_at: timeoutMs > 0 ? presentedAt + timeoutMs : undefined,
      },
    },
    timeoutMs,
  });

  const durationMs = Date.now() - presentedAt;

  if (outcome.status === 'timeout') {
    emitTelemetry(args, TelemetryEvents.ACCESS_BARRIER_TIMEOUT, {
      kind: barrier.kind,
      domain: barrier.domain,
      duration_ms: durationMs,
    });
    // 与解 park 同拍：先收卡再返回 timeout 决议（host finally 随后 releaseHitlPark）。
    emitSingleHitlResolved(args, requestId, 'expired');
    return { action: 'timeout' };
  }

  const resolution = coerceResolution(outcome.value);
  emitTelemetry(args, TelemetryEvents.ACCESS_BARRIER_RESOLVED, {
    kind: barrier.kind,
    domain: barrier.domain,
    action: resolution.action,
    duration_ms: durationMs,
  });
  emitSingleHitlResolved(
    args,
    requestId,
    hitlResolvedOutcome('resolved', resolution, outcome.value),
  );
  return resolution;
}
