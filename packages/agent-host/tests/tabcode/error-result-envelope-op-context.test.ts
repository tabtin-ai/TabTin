/**
 * 2026-05-13 重构：errorResultEnvelope 新增 op + context 字段回归测试
 *
 * 配合 PRD 07 partial_success 哲学，工具错误从单字段 message 升级到结构化
 * 四元组 (error_kind, op, context, cause-via-message)。本测试钉死：
 *   1. op 字段仅在 caller 显式传入时进 metadata，未传不污染（兼容旧调用方）
 *   2. context 字段透传调用方塞的任意 key，且自动合并 path 入参（向后兼容）
 *   3. 顶层 path 字段保留兼容（前端 / 老归档可能仍消费此字段）
 *
 * Wave 3：不再写 numeric / 结构化 `error_code`。
 * 不验证 hint / error_kind 全集——那些有专门的回归测试。
 */
import { describe, it, expect } from 'vitest';

import { errorResultEnvelope } from '../../src/tools/read-file-state.js';

interface ParsedEnvelope {
  success: boolean;
  error: string;
  error_kind: string;
  hint: string;
  op?: string;
  context?: Record<string, unknown>;
  path?: string;
}

function parse(result: { content: unknown; isError: boolean }): ParsedEnvelope {
  expect(result.isError).toBe(true);
  expect(typeof result.content).toBe('string');
  return JSON.parse(result.content as string) as ParsedEnvelope;
}

describe('errorResultEnvelope (W12 → 2026-05-13 op + context 增强)', () => {
  it('未传 op → metadata 不包含 op 字段（向后兼容旧调用方）', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'permission_denied',
        message: 'Path is outside the allowed workspace.',
      }),
    );
    expect('op' in env).toBe(false);
  });

  it('显式传 op → metadata.op 完整透传（让前端按 op 分组渲染）', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'permission_denied',
        message: 'Path is outside the allowed workspace.',
        op: 'write_file',
      }),
    );
    expect(env.op).toBe('write_file');
  });

  it('context 字段直接透传调用方塞的任意 key（path / reason / target / 其它）', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'permission_denied',
        message: 'symlink target blocked',
        op: 'delete_file',
        context: {
          path: '/tmp/link-here',
          reason: 'symlink_target_blocked',
          target: '/etc/passwd',
        },
      }),
    );
    expect(env.context).toEqual({
      path: '/tmp/link-here',
      reason: 'symlink_target_blocked',
      target: '/etc/passwd',
    });
  });

  it('仅传旧 path 入参 → context 自动派生 { path }（兼容旧 caller）', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'file_not_found',
        message: 'File does not exist',
        path: '/workspace/missing.ts',
      }),
    );
    expect(env.context).toEqual({ path: '/workspace/missing.ts' });
    // 顶层 path 字段保留：前端历史代码 / 测试可能仍消费
    expect(env.path).toBe('/workspace/missing.ts');
  });

  it('同时传 path + context.path：显式 context.path 优先（不被 path 入参覆盖）', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'file_not_found',
        message: 'File does not exist',
        path: '/raw/input/path',
        context: { path: '/canonical/path', reason: 'missing' },
      }),
    );
    // context.path 是显式 caller 决定的（已 canonicalize），优先于原始 path 入参
    expect(env.context).toEqual({ path: '/canonical/path', reason: 'missing' });
    // 顶层 path 仍透传 caller 给的 path 入参（旧契约不破）
    expect(env.path).toBe('/raw/input/path');
  });

  it('context 含 path / 入参未传 path → context 不被自动覆盖', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'permission_denied',
        message: 'symlink chain rejected',
        op: 'delete_file',
        context: { path: '/intermediate/link', reason: 'symlink_chain' },
      }),
    );
    expect(env.context?.path).toBe('/intermediate/link');
    // 顶层 path 不存在（caller 没显式传 path 入参，仅塞 context.path）
    expect('path' in env).toBe(false);
  });

  it('context 为空对象 → metadata 不写 context（避免 noise）', () => {
    const env = parse(
      errorResultEnvelope({
        errorKind: 'upstream_error',
        message: 'something went wrong',
        context: {},
      }),
    );
    // 空 context 不进 metadata，避免 LLM 看到 noise key
    expect('context' in env).toBe(false);
  });

  it('write_file / edit_file / delete_file 三件套同款 op 字段格式', () => {
    const cases: Array<{ op: string; errorKind: string }> = [
      { op: 'write_file', errorKind: 'invalid_param_format' },
      { op: 'edit_file', errorKind: 'invalid_param_format' },
      { op: 'delete_file', errorKind: 'permission_denied' },
    ];
    for (const { op, errorKind } of cases) {
      const env = parse(
        errorResultEnvelope({
          errorKind,
          message: `${op} test message`,
          op,
          context: { path: '/test/file', reason: 'test' },
        }),
      );
      expect(env.op).toBe(op);
      expect(env.error_kind).toBe(errorKind);
      expect('error_code' in env).toBe(false);
      expect(env.context).toEqual({ path: '/test/file', reason: 'test' });
    }
  });
});
