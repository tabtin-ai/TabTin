/**
 * Tool 执行 lifecycle 元事件 helper（W2 silent-bypass 修复产物）。
 *
 * 上游 emit 路径（runtime 内部）：
 *   - `tool-orchestration.ts::makeToolLifecycleNotice` 主路径 → 'tool_started' / 'tool_completed' / 'tool_failed'
 *   - `query.ts` pre-started exec 优化路径 → 'tool_pre_started_exec_started' / 'tool_pre_started_exec_completed' / 'tool_pre_started_exec_failed'
 *
 * 下游 consumer 路径（host 桥）：
 *   - `apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts::appendStreamEventToSessionStorage`
 *   - `apps/tabtin-daemon/src/agent/DaemonAgentHost.ts::appendStreamEventToSessionStorage`
 *
 * 这两条路径共用 SystemNoticeEvent + payload.notice_type 路由。本 helper
 * 集中维护"哪些 notice_type 属于 tool lifecycle"——避免在 host 桥两端各
 * hardcode 一份字符串列表（W2 silent-bypass 二代根因之一）。
 *
 * Wave 7 决策点（见 §0.6 W2-L3）：是否要把 tool lifecycle 从 SYSTEM_NOTICE
 * 拆出到专用 `agent.stream.tool_execution` 元事件类型；那时本 helper 的
 * 调用方只需改 import 路径，notice_type 列表本身可平滑迁移。
 */

export const TOOL_LIFECYCLE_NOTICE_TYPES = [
  'tool_started',
  'tool_completed',
  'tool_failed',
  'tool_pre_started_exec_started',
  'tool_pre_started_exec_completed',
  'tool_pre_started_exec_failed',
] as const;

/** 工具参数完整、调用目的已可展示，但尚不代表权限已通过或执行已开始。 */
export const TOOL_INTENT_AVAILABLE_NOTICE_TYPE = 'tool_intent_available' as const;

export type ToolLifecycleNoticeType = (typeof TOOL_LIFECYCLE_NOTICE_TYPES)[number];

const TOOL_LIFECYCLE_NOTICE_TYPE_SET: ReadonlySet<string> = new Set(TOOL_LIFECYCLE_NOTICE_TYPES);

export function isToolLifecycleNotice(noticeType: string | undefined): noticeType is ToolLifecycleNoticeType {
  return typeof noticeType === 'string' && TOOL_LIFECYCLE_NOTICE_TYPE_SET.has(noticeType);
}
