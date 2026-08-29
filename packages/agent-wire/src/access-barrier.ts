/**
 * access-barrier.ts — Access Barrier HITL wire schema。
 *
 * 专用 HITL kind `access_barrier`：浏览器撞上登录墙 / 人机校验时，在能力出口
 * 暂停并发起本事件；用户决议写入 `AccessBarrierResolution`，走既有
 * user_response / SingleHitlResolved 管线回灌工具结果。
 *
 * **结构与 `@tabtin/browser-core::access-barrier/types.ts` 的 `AccessBarrier` /
 * `AccessBarrierResolution` 同名同形**，但本文件**不 import browser-core**——
 * `agent-wire` 是跨 daemon/backend/frontend 的协议层，不应依赖某个能力包的
 * 实现细节；两边字段名/取值域靠人工对齐（本文件与 browser-core 同一设计文档
 * 派生，变更需同步）。
 */

import { z } from 'zod';

export const AccessBarrierKindSchema = z.enum([
  'login',
  'captcha',
  'geetest',
  'mfa',
  'unknown_wall',
]);

export type AccessBarrierKind = z.infer<typeof AccessBarrierKindSchema>;

export const AccessBarrierActionIdSchema = z.enum([
  'resume_same_tab',
  'alternate_source',
  'abort_this_target',
]);

export type AccessBarrierActionId = z.infer<typeof AccessBarrierActionIdSchema>;

export const AccessBarrierSchema = z.object({
  kind: AccessBarrierKindSchema,
  reason: z.string(),
  /** hostname，未知则 `'unknown'`。 */
  domain: z.string(),
  pageUrl: z.string().optional(),
  /** 有则卡片可「提到前台」并要求复用同一 tab。 */
  tabId: z.string().optional(),
  captchaType: z.string().optional(),
  sourceTool: z.string().optional(),
  /** ISO 时间戳。 */
  detectedAt: z.string(),
  actions: z.array(AccessBarrierActionIdSchema),
}).passthrough();

export type AccessBarrier = z.infer<typeof AccessBarrierSchema>;

/**
 * 用户决议 / 系统结局判别联合（设计 §5.1）。前三种为用户主动三选一；
 * `timeout` / `skipped` / `host_unavailable` 是系统结局，须诚实失败。
 */
export const AccessBarrierResolutionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resume_same_tab'),
    tabId: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({
    action: z.literal('alternate_source'),
  }),
  z.object({
    action: z.literal('abort_this_target'),
  }),
  z.object({
    action: z.enum(['timeout', 'skipped', 'host_unavailable']),
  }),
]);

export type AccessBarrierResolution = z.infer<typeof AccessBarrierResolutionSchema>;

export const ACCESS_BARRIER_REQUIRED_EVENT_TYPE =
  'agent.stream.access_barrier_required' as const;

/**
 * `access_barrier_required` payload：`{ request_id, barrier, expires_at? }`
 * （设计 §6.2）。走既有 InterruptPort / SingleHitlResolved 管线，故补充
 * `interrupt_id` / `thread_id` / `message_id` 等与 ask 三件套同构的传输字段
 * （可选，不同 host 按需填）。
 */
export const AccessBarrierRequiredPayloadSchema = z.object({
  request_id: z.string().min(1),
  barrier: AccessBarrierSchema,
  expires_at: z.number().optional(),
  schema_version: z.literal(1).optional(),
  // wire envelope transport 字段（与 ask 三件套同构，供 UI / IPC 定位）
  interrupt_id: z.string().optional(),
  thread_id: z.string().optional(),
  message_id: z.string().optional(),
}).passthrough();

export type AccessBarrierRequiredPayload = z.infer<typeof AccessBarrierRequiredPayloadSchema>;

export const AccessBarrierRequiredEventSchema = z.object({
  type: z.literal(ACCESS_BARRIER_REQUIRED_EVENT_TYPE),
  payload: AccessBarrierRequiredPayloadSchema,
});

export type AccessBarrierRequiredEvent = z.infer<typeof AccessBarrierRequiredEventSchema>;
