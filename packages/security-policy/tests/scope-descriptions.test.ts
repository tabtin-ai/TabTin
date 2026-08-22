import { describe, it, expect } from 'vitest';
import { buildScopeDescription } from '../src/scope-descriptions';

describe('buildScopeDescription', () => {
  it('shell command with subcmd', () => {
    expect(buildScopeDescription('run_terminal_command', 'npm', 'workspace-internal'))
      .toBe('执行 shell 命令 npm');
  });

  it('shell wildcard scope', () => {
    expect(buildScopeDescription('run_terminal_command', '', '*'))
      .toBe('执行任意 shell 命令');
  });

  it('file read', () => {
    expect(buildScopeDescription('read_file', 'read', 'exact:abc'))
      .toBe('读取文件');
  });

  it('file read wildcard', () => {
    expect(buildScopeDescription('read_file', 'read', '*'))
      .toBe('读取任意文件');
  });

  it('mcp with subcmd', () => {
    expect(buildScopeDescription('mcp_call_tool', 'stripe-list', '*'))
      .toBe('调用 MCP 工具 stripe-list');
  });

  it('device action', () => {
    expect(buildScopeDescription('device_action', 'screen_capture', 'exact:x'))
      .toBe('设备操作 screen_capture');
  });

  it('device action no subcmd', () => {
    expect(buildScopeDescription('device_action', '_', 'exact:x'))
      .toBe('执行设备操作');
  });

  it('tabdoc write', () => {
    expect(buildScopeDescription('tabdoc_write', '', ''))
      .toBe('编辑文档');
  });

  it('tabdata read', () => {
    expect(buildScopeDescription('tabdata_read', '', ''))
      .toBe('读取表格数据');
  });

  it('memory delete', () => {
    expect(buildScopeDescription('memory_delete', '', ''))
      .toBe('删除记忆');
  });

  it('fallback unknown tool', () => {
    expect(buildScopeDescription('my_custom_tool', 'sub', 'exact:x'))
      .toBe('my custom tool sub');
  });

  it('fallback unknown tool no subcmd', () => {
    expect(buildScopeDescription('my_custom_tool', '', ''))
      .toBe('my custom tool');
  });

  // M4.1 P0-2 fix 验证：handleAlwaysAllow('exact') 时传 scope='exact'（非 '*'）
  // → TEMPLATES.run_terminal_command 走非通配分支，生成包含 subcmd 的精确文案，
  // 不生成"执行任意 shell 命令"（反语义 bug）。
  it('run_terminal_command exact scope 含 subcmd 而不含"任意"', () => {
    const desc = buildScopeDescription('run_terminal_command', 'rm', 'exact');
    expect(desc).toContain('rm');
    expect(desc).not.toContain('任意');
  });

  it('run_terminal_command exact scope 无 subcmd 时走非通配分支', () => {
    const desc = buildScopeDescription('run_terminal_command', '', 'exact');
    expect(desc).not.toContain('任意');
    expect(desc).toBe('执行 shell 命令');
  });

  it('run_terminal_command workspace-internal scope 含 subcmd 且不含"任意"', () => {
    const desc = buildScopeDescription('run_terminal_command', 'git', 'workspace-internal');
    expect(desc).toContain('git');
    expect(desc).not.toContain('任意');
  });
});
