/**
 * FileSystemCap 单测 —— W1 清理 + 阶段 2.3 instructions 下线后版本。
 *
 * list_directory / mkdir 工具已在工具系统宪法 W1 中删除
 * （LLM 通过 run_terminal_command ls/mkdir 完成同等操作）。
 * `instructions()` 已随 `Capability.instructions?()` 接口于阶段 2.3 下线。
 *
 * 覆盖：
 *   1. type / category 静态契约
 *   2. tools() 返回空数组
 *   3. getConfig() 返回构造期传入的配置（供 W3 HITL Pipeline 读）
 *   4. clone() 后配置字段被深拷贝
 *   5. required_capability_types 返回空 Set
 */

import { describe, expect, it } from 'vitest';
import { FileSystemCap } from '../filesystem.js';

// ─── 1. 静态契约 ──────────────────────────────────────────────────────

describe('FileSystemCap 静态契约', () => {
  it('type === "filesystem" / category === "core"', () => {
    const cap = new FileSystemCap();
    expect(cap.type).toBe('filesystem');
    expect(cap.category).toBe('core');
  });

  it('required_capability_types 返回空 Set（不依赖任何 cap）', () => {
    const cap = new FileSystemCap();
    expect(cap.required_capability_types?.()).toBeInstanceOf(Set);
    expect(cap.required_capability_types?.()?.size).toBe(0);
  });
});

// ─── 2. tools() 返回空数组（W1 清理后） ──────────────────────────────

describe('FileSystemCap tools()', () => {
  it('返回空数组（list_directory / mkdir 已在 W1 删除）', () => {
    const cap = new FileSystemCap();
    expect(cap.tools()).toEqual([]);
  });
});

// ─── 3. getConfig() 暴露配置（供 W3 HITL 读）────────────────────────

describe('FileSystemCap getConfig()', () => {
  it('无构造参数时返回空对象', () => {
    const cap = new FileSystemCap();
    expect(cap.getConfig()).toEqual({});
  });

  it('返回构造期传入的字段', () => {
    const cap = new FileSystemCap({
      deny_read_paths: ['~/.ssh'],
      deny_write_paths: ['.env'],
      custom_write_paths: ['/tmp/out'],
      sandbox_level: 'filesystem',
      file_access: 'workspace',
    });
    const cfg = cap.getConfig();
    expect(cfg.deny_read_paths).toEqual(['~/.ssh']);
    expect(cfg.deny_write_paths).toEqual(['.env']);
    expect(cfg.custom_write_paths).toEqual(['/tmp/out']);
    expect(cfg.sandbox_level).toBe('filesystem');
    expect(cfg.file_access).toBe('workspace');
  });
});

// ─── 4. clone 行为 ───────────────────────────────────────────────────

describe('FileSystemCap clone()', () => {
  it('配置字段在 clone 后仍可读（getConfig 验证深拷贝）', () => {
    const cap = new FileSystemCap({
      deny_read_paths: ['~/.ssh', '~/.aws'],
      custom_write_paths: ['/tmp/out'],
    });
    const cloned = cap.clone() as FileSystemCap;
    const cfg = cloned.getConfig();
    expect(cfg.deny_read_paths).toEqual(['~/.ssh', '~/.aws']);
    expect(cfg.custom_write_paths).toEqual(['/tmp/out']);
  });

  it('clone 后 tools() 仍返回空数组', () => {
    const cap = new FileSystemCap();
    const cloned = cap.clone() as FileSystemCap;
    expect(cloned.tools()).toEqual([]);
  });
});
