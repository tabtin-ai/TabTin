/**
 * Wave 2 silent-bypass 二代修复测试。
 *
 * 背景：W2 把 tool 执行 lifecycle 从 `'agent.stream.tool'` emit 迁到
 * `StreamEvents.SYSTEM_NOTICE`(notice_type='tool_*')，但 host 桥
 * (ElectronAgentHost / DaemonAgentHost) 的 listener 没同步迁——导致
 * `toolLogWriter` 不写、`storage.recordToolResult` 不调用、`tool_result`
 * ContentBlock 链路断。
 *
 * 这个测试守住 helper 契约：6 个已知 notice_type 都识别为 lifecycle，
 * 其他 SYSTEM_NOTICE 全拒。host 桥两端的 `appendStreamEventToSessionStorage`
 * listener 都调用本 helper —— 任何未来修改 emit 后必须保持 helper 契约
 * 同步更新，否则本测试 + host bridge 的契约测试会同时炸，定位即修。
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_LIFECYCLE_NOTICE_TYPES,
  isToolLifecycleNotice,
} from '../../src/engine/tooling/tool-lifecycle-notice.js';

describe('Wave 2 · tool-lifecycle-notice helper', () => {
  it('TOOL_LIFECYCLE_NOTICE_TYPES 含 6 个稳定值（主路径 3 + pre-started exec 优化路径 3）', () => {
    expect(TOOL_LIFECYCLE_NOTICE_TYPES).toEqual([
      'tool_started',
      'tool_completed',
      'tool_failed',
      'tool_pre_started_exec_started',
      'tool_pre_started_exec_completed',
      'tool_pre_started_exec_failed',
    ]);
  });

  it.each(TOOL_LIFECYCLE_NOTICE_TYPES)('isToolLifecycleNotice(%s) === true', (type) => {
    expect(isToolLifecycleNotice(type)).toBe(true);
  });

  it.each([
    'iteration_budget_warn',
    'tool_failure_notice',
    'subagent_spawn_blocked',
    'context_truncated',
    'model_override',
    'crash_resume_warn',
    'hook_error',
    undefined,
    '',
    'tool',
    'tool_started_extra',
    'TOOL_STARTED',
  ])('isToolLifecycleNotice(%s) === false（不会污染其他 SYSTEM_NOTICE consumer）', (type) => {
    expect(isToolLifecycleNotice(type as string | undefined)).toBe(false);
  });

  it('helper 不会因为新增 phase 字段或其他 payload 字段产生副作用（纯函数 + Set 查表）', () => {
    const before = TOOL_LIFECYCLE_NOTICE_TYPES.slice();
    isToolLifecycleNotice('tool_started');
    isToolLifecycleNotice('hook_error');
    isToolLifecycleNotice(undefined);
    expect(TOOL_LIFECYCLE_NOTICE_TYPES).toEqual(before);
  });
});
