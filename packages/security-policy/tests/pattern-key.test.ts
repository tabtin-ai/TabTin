/**
 * pattern-key.test.ts — 附录 B pattern_key 规范单测
 *
 * 覆盖：
 *   - hash16 跨端等价（fixture）
 *   - canonicalInput 规范化（shell wrapper 剥离 / file path NFC / mcp sorted keys）
 *   - buildApprovalKey 三段式 + scope 三档
 *   - lookupMemo specificity 顺序（exact > scoped > wildcard）
 *   - lookupMemo deny-wins 策略验证
 */

import { describe, it, expect } from 'vitest';
import {
  hash16,
  canonicalInput,
  canonicalizeShellCommand,
  stableStringify,
  buildApprovalKey,
  lookupMemo,
} from '../src/pattern-key';
import type { ApprovalMemoEntry } from '../src/types-v3';

// ---------------------------------------------------------------------------
// hash16
// ---------------------------------------------------------------------------

describe('hash16', () => {
  it('返回 16 位十六进制', () => {
    const h = hash16('abc');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('确定性：同 input 产出相同 hash', () => {
    expect(hash16('foo')).toBe(hash16('foo'));
  });

  it('UTF-8 编码：中文 input 与 Python 等价', () => {
    // Python 验证：
    //   import hashlib; hashlib.sha256("你好".encode('utf-8')).hexdigest()[:16]
    //   = '670d9743542cae3e'
    expect(hash16('你好')).toBe('670d9743542cae3e');
  });

  it('空字符串', () => {
    // Python: hashlib.sha256(b'').hexdigest()[:16] = 'e3b0c44298fc1c14'
    expect(hash16('')).toBe('e3b0c44298fc1c14');
  });

  it('SHA256("abc") prefix 16', () => {
    // Python: hashlib.sha256(b'abc').hexdigest()[:16] = 'ba7816bf8f01cfea'
    expect(hash16('abc')).toBe('ba7816bf8f01cfea');
  });
});

// ---------------------------------------------------------------------------
// canonicalizeShellCommand
// ---------------------------------------------------------------------------

describe('canonicalizeShellCommand', () => {
  it('trim + 多空格合一', () => {
    expect(canonicalizeShellCommand('  rm    -rf   ./build  ')).toBe('rm -rf ./build');
  });
  it('剥 nice', () => {
    expect(canonicalizeShellCommand('nice rm -rf ./build')).toBe('rm -rf ./build');
  });
  it('剥 timeout 5s', () => {
    expect(canonicalizeShellCommand('timeout 5s pnpm test')).toBe('pnpm test');
  });
  it('剥 nice -n10 timeout 30s 串联', () => {
    expect(canonicalizeShellCommand('nice -n10 timeout 30 git push')).toBe('git push');
  });
  it('剥 env KEY=v', () => {
    expect(canonicalizeShellCommand('env DEBUG=1 NODE_ENV=test pnpm test')).toBe('pnpm test');
  });
  it('剥 nohup / stdbuf', () => {
    expect(canonicalizeShellCommand('nohup pnpm dev')).toBe('pnpm dev');
    expect(canonicalizeShellCommand('stdbuf -oL pnpm dev')).toBe('pnpm dev');
  });
  it('NFC 归一', () => {
    const nfd = 'echo caf\u0065\u0301';
    const nfc = 'echo caf\u00e9';
    expect(canonicalizeShellCommand(nfd)).toBe(canonicalizeShellCommand(nfc));
  });
  it('非 string 返回空串', () => {
    expect(canonicalizeShellCommand(null as unknown as string)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// canonicalInput
// ---------------------------------------------------------------------------

describe('canonicalInput', () => {
  it('shell：从 input.command 抽取并规范化', () => {
    const c = canonicalInput('shell', { command: '  nice rm -rf ./build  ' });
    expect(c).toBe('rm -rf ./build');
  });
  it('shell：opts.command 优先', () => {
    const c = canonicalInput('shell', { command: 'fallback' }, { command: 'rm x' });
    expect(c).toBe('rm x');
  });
  it('file：opts.path 优先', () => {
    const c = canonicalInput('file', { path: 'fallback' }, { path: '/Users/me/x' });
    expect(c).toBe('/Users/me/x');
  });
  it('file：从 input.path / file_path 抽', () => {
    expect(canonicalInput('file', { path: '/a' })).toBe('/a');
    expect(canonicalInput('file', { file_path: '/b' })).toBe('/b');
  });
  it('mcp：稳定排序的 JSON', () => {
    const a = canonicalInput('mcp', { z: 1, a: 2 });
    const b = canonicalInput('mcp', { a: 2, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"z":1}');
  });
  it('object / device 与 mcp 同走 stableStringify', () => {
    expect(canonicalInput('object', { foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(canonicalInput('device', { device_action: 'screen_capture' })).toBe(
      '{"device_action":"screen_capture"}',
    );
  });
});

describe('stableStringify', () => {
  it('深度 sortKeys', () => {
    const a = stableStringify({ b: { y: 1, x: 2 }, a: 1 });
    expect(a).toBe('{"a":1,"b":{"x":2,"y":1}}');
  });
  it('array 保持原序（语义顺序）', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
  it('null / number / string', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hi')).toBe('"hi"');
  });
});

// ---------------------------------------------------------------------------
// buildApprovalKey
// ---------------------------------------------------------------------------

describe('buildApprovalKey', () => {
  it('exact 三段式：tool::subcmd:exact:<hex16>', () => {
    const k = buildApprovalKey('run_terminal_command', 'rm', { command: 'rm -rf ./build' }, true, {
      kind: 'shell',
    });
    expect(k).toMatch(/^run_terminal_command::rm:exact:[0-9a-f]{16}$/);
  });

  it('scoped 三段式：workspace-internal / workspace-external', () => {
    const a = buildApprovalKey('run_terminal_command', 'rm', {}, true, { scope: 'scoped' });
    const b = buildApprovalKey('run_terminal_command', 'rm', {}, false, { scope: 'scoped' });
    expect(a).toBe('run_terminal_command::rm:workspace-internal');
    expect(b).toBe('run_terminal_command::rm:workspace-external');
  });

  it('wildcard 三段式：tool::subcmd:*', () => {
    const k = buildApprovalKey('run_terminal_command', 'git-push', {}, false, { scope: 'wildcard' });
    expect(k).toBe('run_terminal_command::git-push:*');
  });

  it('subcmd 为空时回退到 _', () => {
    const k = buildApprovalKey('write_file', '', {}, true, { scope: 'wildcard' });
    expect(k).toBe('write_file::_:*');
  });

  it('exact key 不依赖 inWorkspace', () => {
    const k1 = buildApprovalKey('x', 'y', { command: 'cmd' }, true, { kind: 'shell' });
    const k2 = buildApprovalKey('x', 'y', { command: 'cmd' }, false, { kind: 'shell' });
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// lookupMemo
// ---------------------------------------------------------------------------

function entry(decision: 'allow' | 'deny', desc = ''): ApprovalMemoEntry {
  return {
    decision,
    created_at: '2026-05-02T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
    approver_user_id: 'u-1',
    scope_description: desc || `${decision}-entry`,
  };
}

describe('lookupMemo · specificity 顺序', () => {
  const tool = 'run_terminal_command';
  const subcmd = 'rm';
  const input = { command: 'rm -rf ./build' };

  it('exact 优先于 scoped', () => {
    const exactKey = buildApprovalKey(tool, subcmd, input, true, {
      kind: 'shell',
      scope: 'exact',
    });
    const scopedKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'scoped' });
    const entries = {
      [exactKey]: entry('allow'),
      [scopedKey]: entry('deny'),
    };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: true, kind: 'shell' });
    expect(r?.decision).toBe('allow');
    expect(r?.specificity).toBe('exact');
  });

  it('scoped 优先于 wildcard', () => {
    const scopedKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'scoped' });
    const wildKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'wildcard' });
    const entries = {
      [scopedKey]: entry('allow'),
      [wildKey]: entry('deny'),
    };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: true, kind: 'shell' });
    expect(r?.decision).toBe('allow');
    expect(r?.specificity).toBe('scoped');
  });

  it('只有 wildcard 时命中 wildcard', () => {
    const wildKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'wildcard' });
    const entries = { [wildKey]: entry('deny') };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: true, kind: 'shell' });
    expect(r?.decision).toBe('deny');
    expect(r?.specificity).toBe('wildcard');
  });

  it('无任何匹配返回 null', () => {
    const r = lookupMemo({}, { toolName: tool, subcmd, input, inWorkspace: true });
    expect(r).toBeNull();
  });

  it('scoped 工作区内 entry 不命中工作区外查询', () => {
    const scopedKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'scoped' });
    const entries = { [scopedKey]: entry('allow') };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: false, kind: 'shell' });
    expect(r).toBeNull();
  });

  it('matchedKey 与实际 key 完全一致', () => {
    const exactKey = buildApprovalKey(tool, subcmd, input, true, {
      kind: 'shell',
      scope: 'exact',
    });
    const entries = { [exactKey]: entry('allow') };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: true, kind: 'shell' });
    expect(r?.matchedKey).toBe(exactKey);
  });
});

describe('lookupMemo · deny 优先 / 具体优先（行为澄清）', () => {
  const tool = 'run_terminal_command';
  const subcmd = 'rm';
  const input = { command: 'rm -rf ./build' };

  it('exact deny + scoped allow → exact deny 胜（具体优先）', () => {
    const exactKey = buildApprovalKey(tool, subcmd, input, true, {
      kind: 'shell',
      scope: 'exact',
    });
    const scopedKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'scoped' });
    const entries = {
      [exactKey]: entry('deny'),
      [scopedKey]: entry('allow'),
    };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: true, kind: 'shell' });
    expect(r?.decision).toBe('deny');
    expect(r?.specificity).toBe('exact');
  });

  it('scoped allow + wildcard deny → scoped allow 胜（具体优先；spec §B.5）', () => {
    const scopedKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'scoped' });
    const wildKey = buildApprovalKey(tool, subcmd, input, true, { scope: 'wildcard' });
    const entries = {
      [scopedKey]: entry('allow'),
      [wildKey]: entry('deny'),
    };
    const r = lookupMemo(entries, { toolName: tool, subcmd, input, inWorkspace: true, kind: 'shell' });
    expect(r?.decision).toBe('allow');
    expect(r?.specificity).toBe('scoped');
  });
});
