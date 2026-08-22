/**
 * MessageStart payload 本地自检（ Stage 5c）。
 *
 * 替代生产路径对 `@tabtin/agent-wire` `MessageStartSchema.parse` 的依赖；
 * 规则与 wire `MESSAGE_KIND_ALLOWED_ROLES` + 必填字段对齐。完整 Zod 校验
 * 仍由 wire 包在跨端消费 / 测试侧承担。
 */

import type { MessageKind, MessageStart } from './wire-payloads.js';

const MESSAGE_KIND_ALLOWED_ROLES: Record<
  MessageKind,
  ReadonlyArray<'assistant' | 'user' | 'system'>
> = {
  llm: ['assistant', 'user', 'system'],
  tool_artifact: ['assistant', 'user'],
  error_envelope: ['assistant'],
  environment_context: ['user'],
  agent_profile_context: ['user'],
  system_prompt_context: ['user'],
};

export function assertMessageStartPayload(payload: MessageStart): void {
  const required = [
    'protocol_version',
    'min_compatible_version',
    'trace_id',
    '_seq',
    'thread_id',
    'event_type',
    'message_id',
    'role',
    'model_id',
    'model_name',
    'started_at',
    'run_id',
    'message_kind',
  ] as const;
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      throw new Error(`MessageStart payload missing required field: ${key}`);
    }
  }
  if (payload.event_type !== 'agent.stream.message_start') {
    throw new Error(`MessageStart event_type mismatch: ${payload.event_type}`);
  }
  const allowed = MESSAGE_KIND_ALLOWED_ROLES[payload.message_kind];
  if (!allowed) {
    throw new Error(`MessageStart unknown message_kind: ${payload.message_kind}`);
  }
  if (!allowed.includes(payload.role)) {
    throw new Error(
      `illegal role=${payload.role} for message_kind=${payload.message_kind}; `
        + `allowed roles: [${allowed.join(', ')}]`,
    );
  }
}
