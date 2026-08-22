/**
 * PromptForwardPayload.app_context —— FocusSnapshot 兼容 schema。
 *
 * 钉死：
 *   - 合法 Focus 子集被接受
 *   - host-only 扩展键经 passthrough 保留
 *   - 非法 Focus 降级丢弃 app_context，不阻断整包（ P1-6）
 *   - path/url 对齐 Django 2048 上限
 */
import { describe, it, expect } from 'vitest';
import { FOCUS_SNAPSHOT_LIMITS } from '@tabtin/contracts/agent';
import { PromptForwardPayloadSchema } from '../src/prompt.js';

const BASE = {
  task_id: 'task-1',
  prompt: 'hello',
  attachments: [],
  agent_config: { type: 'claude-code' },
  workspace_id: 'workspace-1',
};

describe('PromptForwardPayloadSchema — app_context FocusSnapshot', () => {
  it('accepts a FocusSnapshot subset (optional fields)', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'tabdoc',
        spaceId: 'space-1',
        userTimeZone: 'Asia/Shanghai',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app_context).toMatchObject({
        appType: 'tabdoc',
        spaceId: 'space-1',
        userTimeZone: 'Asia/Shanghai',
      });
    }
  });

  it('passthrough keeps host-only collaboration / execution ids', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'project_task',
        appMeta: { project_id: 'proj-1', task_id: 'task-1' },
        spaceId: 'ws-1',
        collaborationSpaceId: 'proj-1',
        executionSpaceId: 'ws-1',
        initiatorUserId: 'user-1',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const ctx = result.data.app_context as Record<string, unknown>;
      expect(ctx.collaborationSpaceId).toBe('proj-1');
      expect(ctx.executionSpaceId).toBe('ws-1');
      expect(ctx.initiatorUserId).toBe('user-1');
    }
  });

  it('accepts null / omitted app_context (backward compatible)', () => {
    expect(
      PromptForwardPayloadSchema.safeParse({ ...BASE, app_context: null }).success,
    ).toBe(true);
    const omitted = PromptForwardPayloadSchema.safeParse(BASE);
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.app_context).toBeUndefined();
    }
  });

  it('strips illegal appMeta body fields without failing the whole payload ( P1-6)', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'tabdoc',
        appMeta: { content: '全文正文不应进入自动上下文' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app_context).toBeUndefined();
      expect(result.data.prompt).toBe('hello');
      expect(result.data.task_id).toBe('task-1');
    }
  });

  it('strips non-object app_context without failing the whole payload ( P1-6)', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: 'tabdoc',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app_context).toBeUndefined();
      expect(result.data.prompt).toBe('hello');
    }
  });

  it('accepts string fields at Django-aligned 512 boundary ', () => {
    const title512 = 'a'.repeat(FOCUS_SNAPSHOT_LIMITS.MAX_STRING_LENGTH);
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'tabdoc',
        openTabs: [{ type: 'tabdoc', id: 'doc-1', title: title512, active: true }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('strips title above 512 without failing the whole payload', () => {
    const title513 = 'a'.repeat(FOCUS_SNAPSHOT_LIMITS.MAX_STRING_LENGTH + 1);
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'tabdoc',
        openTabs: [{ type: 'tabdoc', id: 'doc-1', title: title513, active: true }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app_context).toBeUndefined();
      expect(result.data.prompt).toBe('hello');
    }
  });

  it('accepts path/url at Django-aligned 2048 boundary ( P1-6)', () => {
    const path2048 = '/' + 'p'.repeat(FOCUS_SNAPSHOT_LIMITS.MAX_URL_OR_PATH_LENGTH - 1);
    expect(path2048.length).toBe(FOCUS_SNAPSHOT_LIMITS.MAX_URL_OR_PATH_LENGTH);
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'tabcode',
        openTabs: [{ type: 'tabcode', id: 'f1', path: path2048, active: true }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const tabs = (result.data.app_context as { openTabs?: Array<{ path?: string }> })?.openTabs;
      expect(tabs?.[0]?.path).toBe(path2048);
    }
  });

  it('strips openTabs missing required type without failing the whole payload', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      app_context: {
        appType: 'tabdoc',
        openTabs: [{ id: 'doc-1', active: true }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app_context).toBeUndefined();
      expect(result.data.prompt).toBe('hello');
    }
  });
});
