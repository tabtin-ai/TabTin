/**
 * CapabilityRegistry 测试 —— 对应 M1 §6.3。
 *
 * 验证：
 *   - register / create / has / list 基本功能
 *   - validateDependencies 缺依赖时抛 CapabilityDependencyError 并包含缺失项
 *   - 重复 register 同一 type 抛 Error
 *   - list 按 type 字典序稳定输出
 *   - factory throws 在 register 时被包装报告
 *   - factory 产出 type 不一致 → 抛错
 */

import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../registry.js';
import { CapabilityDependencyError } from '../errors.js';
import type { Capability } from '../capability.js';
import {
  FakeFileSystemCap,
  FakeMemoryCap,
  FakeNoOpCap,
  FakeShellCap,
} from './fixtures/fake-capabilities.js';

describe('CapabilityRegistry basic CRUD', () => {
  it('register + create 返回新实例', () => {
    const r = new CapabilityRegistry();
    r.register('filesystem', () => new FakeFileSystemCap());
    const cap = r.create('filesystem');
    expect(cap.type).toBe('filesystem');
    expect(cap).toBeInstanceOf(FakeFileSystemCap);

    const cap2 = r.create('filesystem');
    expect(cap2).not.toBe(cap); // 不同实例
  });

  it('has 返回正确状态', () => {
    const r = new CapabilityRegistry();
    expect(r.has('filesystem')).toBe(false);
    r.register('filesystem', () => new FakeFileSystemCap());
    expect(r.has('filesystem')).toBe(true);
  });

  it('create 未知 type 抛错并列出已知', () => {
    const r = new CapabilityRegistry();
    r.register('filesystem', () => new FakeFileSystemCap());
    r.register('shell', () => new FakeShellCap());
    expect(() => r.create('unknown')).toThrow(/unknown type "unknown"/);
    try {
      r.create('unknown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('filesystem');
      expect(msg).toContain('shell');
    }
  });

  it('unregister 是幂等的', () => {
    const r = new CapabilityRegistry();
    r.register('filesystem', () => new FakeFileSystemCap());
    expect(r.has('filesystem')).toBe(true);
    r.unregister('filesystem');
    expect(r.has('filesystem')).toBe(false);
    r.unregister('filesystem'); // 再次 unregister 不抛
    expect(r.has('filesystem')).toBe(false);
  });
});

describe('CapabilityRegistry register 校验', () => {
  it('重复 register 同 type 抛错', () => {
    const r = new CapabilityRegistry();
    r.register('filesystem', () => new FakeFileSystemCap());
    expect(() =>
      r.register('filesystem', () => new FakeFileSystemCap()),
    ).toThrow(/already registered/);
  });

  it('factory 抛错时被包装为友好错误', () => {
    const r = new CapabilityRegistry();
    expect(() =>
      r.register('boom', () => {
        throw new Error('boom');
      }),
    ).toThrow(/factory for type "boom" threw on invocation/);
  });

  it('factory 产出 type 与注册 type 不一致时抛错', () => {
    const r = new CapabilityRegistry();
    expect(() =>
      r.register('expected-name', () => {
        const cap: Capability = {
          type: 'wrong-name',
          category: 'core',
        };
        return cap;
      }),
    ).toThrow(/Factory output type must match registration type/);
  });

  it('factory 返回 null / undefined 抛友好错误', () => {
    const r = new CapabilityRegistry();
    expect(() =>
      r.register('null-cap', () => null as unknown as Capability),
    ).toThrow(/returned null\/undefined/);
    expect(() =>
      r.register('undef-cap', () => undefined as unknown as Capability),
    ).toThrow(/returned null\/undefined/);
  });

  it('factory 产出无 type 字段或非字符串 type 抛错', () => {
    const r = new CapabilityRegistry();
    expect(() =>
      r.register('bad-type', () => ({} as unknown as Capability)),
    ).toThrow(/missing\/invalid `type` field/);
    expect(() =>
      r.register('bad-type', () =>
        ({ type: 42, category: 'core' }) as unknown as Capability,
      ),
    ).toThrow(/missing\/invalid `type` field/);
  });

  it('factory 产出非法 category 抛错', () => {
    const r = new CapabilityRegistry();
    expect(() =>
      r.register('bad-cat', () =>
        ({ type: 'bad-cat', category: 'xxx' }) as unknown as Capability,
      ),
    ).toThrow(/invalid category "xxx"/);
  });
});

describe('CapabilityRegistry.list', () => {
  it('按 type 字典序稳定输出', () => {
    const r = new CapabilityRegistry();
    r.register('shell', () => new FakeShellCap());
    r.register('filesystem', () => new FakeFileSystemCap());
    r.register('tab-memo', () => new FakeMemoryCap());
    const list = r.list();
    expect(list.map((e) => e.type)).toEqual(['filesystem', 'shell', 'tab-memo']);
  });

  it('list 包含 category', () => {
    const r = new CapabilityRegistry();
    r.register('filesystem', () => new FakeFileSystemCap());
    r.register('tab-memo', () => new FakeMemoryCap());
    const list = r.list();
    const fs = list.find((e) => e.type === 'filesystem');
    const mm = list.find((e) => e.type === 'tab-memo');
    expect(fs?.category).toBe('core');
    expect(mm?.category).toBe('app');
  });

  it('空 registry list 返回空数组', () => {
    const r = new CapabilityRegistry();
    expect(r.list()).toEqual([]);
  });
});

describe('CapabilityRegistry.validateDependencies', () => {
  it('依赖完整时不抛错', () => {
    const r = new CapabilityRegistry();
    const fs = new FakeFileSystemCap();
    const sh = new FakeShellCap();
    expect(() => r.validateDependencies([fs, sh])).not.toThrow();
  });

  it('缺依赖时抛 CapabilityDependencyError 含 capType / missingDep', () => {
    const r = new CapabilityRegistry();
    const sh = new FakeShellCap(); // 依赖 filesystem 但不传
    try {
      r.validateDependencies([sh]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDependencyError);
      const e = err as CapabilityDependencyError;
      expect(e.capType).toBe('shell');
      expect(e.missingDep).toBe('filesystem');
    }
  });

  it('多依赖只缺一个 —— 报告缺失的那个', () => {
    const fs = new FakeFileSystemCap();
    const mm = new FakeMemoryCap(); // 依赖 filesystem + shell；只给 filesystem
    const r = new CapabilityRegistry();
    try {
      r.validateDependencies([fs, mm]);
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as CapabilityDependencyError;
      expect(e.capType).toBe('tab-memo');
      expect(e.missingDep).toBe('shell');
    }
  });

  it('无依赖声明的 cap 不被卡住', () => {
    const noop = new FakeNoOpCap();
    const r = new CapabilityRegistry();
    expect(() => r.validateDependencies([noop])).not.toThrow();
  });

  it('空数组合法', () => {
    const r = new CapabilityRegistry();
    expect(() => r.validateDependencies([])).not.toThrow();
  });
});
