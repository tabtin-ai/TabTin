/**
 * @tabtin/resource-router · events
 *
 * 埋点事件 emit helper。
 *
 * 设计取向（RFC §8）：
 *   - 客户端不直接 HTTP POST——通过 IPC 把事件发给 main 进程的 telemetry queue
 *     （5s flush 或 100 条 flush）后再批量 POST；本包不实现这条上报通路
 *     （那是 W7 的事），只提供事件构造 + 发射 hook。
 *   - 失败永远不能阻塞 UI——任何 emit 抛错调用方都应 catch 后 best-effort。
 *   - 事件 schema 跟后端
 *     `apps/tabtin_django/apps/services/agent_engine/models.py:ResourceOpenEvent`
 *     字段对齐。
 *
 * 本文件主要 re-export 类型 + 提供 console fallback emitter（用于 W3 之前的
 * 单元测试 & smoke）。真实 emitter 由 W3 在 renderer 接 IPC 后注入。
 */

export type {
  ResourceOpenEvent,
  ResourceOpenEventName,
  ResourceOpenTriggerSource,
} from './types.js'

import type { ResourceOpenEvent } from './types.js'

/**
 * 默认 console emitter（仅供 W2 单元测试 / smoke；W3+ 应替换为真实 IPC emitter）。
 * 永不抛 error。
 */
export function consoleEventEmitter(event: ResourceOpenEvent): void {
  try {
    // eslint-disable-next-line no-console
    console.debug('[resource-router][telemetry]', JSON.stringify(event))
  } catch {
    // 忽略 console 自身的潜在错误
  }
}

/**
 * 收集型 emitter（测试用）。
 *
 * 用法：
 *   const collector = new EventCollector()
 *   const router = new ResourceRouter({ ..., emitEvent: collector.emit }, registry)
 *   await router.open(spaceId, pointer)
 *   expect(collector.events).toHaveLength(1)
 */
export class EventCollector {
  readonly events: ResourceOpenEvent[] = []
  emit = (event: ResourceOpenEvent): void => {
    this.events.push(event)
  }
  clear(): void {
    this.events.length = 0
  }
}
