/**
 * subagent-stream-sink —— 子 Agent 实时流的 **session 级统一出口**（W4a S2）。
 *
 * ## 为什么需要它
 *
 * 现状：子 Agent 的实时事件（`SUBAGENT_PROGRESS` / `SUBAGENT_STREAM_EVENT` 等）
 * 经 `context.emitStreamEvent` → host 的 `emitStreamEvent` 闭包，再分两路：
 *   - Electron：`sender.send(IPC)` + `session.eventInterceptor`（per-query
 *     relayBuffer → Django）；
 *   - Daemon：仅 `session.eventInterceptor`（per-query relayBuffer → gateway）。
 *
 * 关键缺陷：`eventInterceptor` 是 **per-query** 的——query 结束的 finally 里被
 * 清成 `undefined`（Electron `:3296` / Daemon `:2009`）。于是「后台子 outlive 父
 * turn」时，子完成后的实时事件打到一个已失效 / 不存在的通道 → 实时面板黑屏到
 * 完成（plan 第六节「致命 1」之一）。
 *
 * S2 把出口收敛成一个 **跨 query 存活的 sink**（挂 HostState.subagentStreamSink）：
 *   - **query 内**：行为与现有 `interceptor + sender` **逐字节一致**（前台不变）；
 *   - **query 外**：不再丢，改走 session 级直接 relay（`relayOutOfQuery`），让
 *     后台子的事件「始终」到达观测层。
 *
 * 本工厂是 **两端共用的纯路由器**——Electron / Daemon 各自注入自己的
 * `sendToActiveClient` / `getInQueryRelay` / `relayOutOfQuery`，路由决策单一来源、
 * 天然对称、可单测。
 *
 * **PR1 范围**：建立 sink + 路由 + 两端注入 + 让 `emitStreamEvent` 经此出口。
 * 后台 producer（真正在 query 外 emit 子事件）在 S5 接入；S3 负责 resume / 后台子
 * 的 sink **重绑定**（rebindLiveDeps）。PR1 不改任何前台 LLM 行为。
 */

import type { StreamEvent } from '@tabtin/agent-runtime'
import {
  routeDeliveryEvent,
  type DeliveryEventSource,
} from './delivery-event-routing.js'

export interface SubagentStreamRouterDeps {
  /**
   * 推给「当前活跃客户端」的通道（Electron：IPC `sender.send`，且自带
   * `isDestroyed` 守门；Daemon：无此概念，省略）。每个事件都尝试推一次——
   * 与现有 `emitStreamEvent` 的 `sender.send` 路径语义一致。
   */
  sendToActiveClient?: (event: StreamEvent) => void;
  /**
   * 取「当前 in-query relay」——即 `HostState.eventInterceptor`。**仅 query 内
   * 非空**（query 结束 finally 清空）。非空时走它（= 现有 per-query relayBuffer
   * + sessionStorage 落盘路径，前台行为不变）。
   *
   * 用 getter 而非直接传函数：sink 跨 query 存活，但 eventInterceptor 每轮
   * query 重建——getter 让 sink 每次调用都读到「当下」的 interceptor。
   */
  getInQueryRelay: () => ((event: StreamEvent) => void) | undefined;
  /**
   * query 外的 session 级直接 relay（后台子事件「始终」送到观测层 / Django）。
   * 仅在 `getInQueryRelay()` 返回 undefined（无活跃 query）时调用，避免与
   * per-query relayBuffer 双发。
   */
  relayOutOfQuery: (event: StreamEvent) => void;
  /** Source used by the host delivery routing policy. */
  source?: DeliveryEventSource;
  /** 路由异常日志（默认静默；两端注入 logger）。 */
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 构造 session 级子 Agent 流出口。返回的函数即 `HostState.subagentStreamSink`，
 * 也是 `emitStreamEvent` 的统一入口。
 *
 * 路由（顺序与现有 `emitStreamEvent` 一致）：
 *   1. `sendToActiveClient?(event)` —— 推给活跃客户端（Electron IPC）；
 *   2. in-query relay 存在 → 走它（前台 query 内：等同 interceptor）；
 *      否则 → `relayOutOfQuery(event)`（后台子：始终 relay，不丢）。
 */
export function createSubagentStreamRouter(
  deps: SubagentStreamRouterDeps,
): (event: StreamEvent) => void {
  const log = deps.log ?? (() => {});
  const source = deps.source ?? 'subagent_stream';
  return (event: StreamEvent): void => {
    if (deps.sendToActiveClient) {
      try {
        deps.sendToActiveClient(event);
      } catch (err) {
        log('sendToActiveClient threw', err);
      }
    }

    let inQueryRelay: ((event: StreamEvent) => void) | undefined;
    try {
      inQueryRelay = deps.getInQueryRelay();
    } catch (err) {
      log('getInQueryRelay threw', err);
      inQueryRelay = undefined;
    }

    if (inQueryRelay) {
      // 前台 query 内：等同现有 eventInterceptor（per-query relayBuffer + 落盘）。
      try {
        inQueryRelay(event);
      } catch (err) {
        log('inQueryRelay threw', err);
      }
    } else {
      // 后台子（query 外）：只有 durable 事件进入 relay；transient observer 流
      // 仍已推给活跃客户端，不能绕过 host routing policy 写进远端历史。
      if (routeDeliveryEvent(event, source) === 'transient') return;
      try {
        deps.relayOutOfQuery(event);
      } catch (err) {
        log('relayOutOfQuery threw', err);
      }
    }
  };
}
