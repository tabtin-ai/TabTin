/**
 * State 层公共类型与约定（正典：docs/agent/agent-host-state-layer.md）。
 *
 * 子域通过 StateRoot 持有实例；禁止模块顶层权威 Map。
 */

/** 子域名称（与目录 / StateRoot 字段对齐） */
export type StateDomainName =
  | 'owner'
  | 'turn'
  | 'conversation'
  | 'session'
  | 'delivery'
  | 'hitl'
  | 'skills'
  | 'catalog'
  | 'prewarm'
  | 'attribution'
  | 'realtime'
  | 'lease'
  | 'model'
