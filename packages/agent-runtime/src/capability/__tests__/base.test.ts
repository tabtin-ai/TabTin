/**
 * CapabilityBase 测试 —— 对应 M1 §6.2。
 *
 * 验证：
 *   - 默认 bind 同 sessionId 多次 OK
 *   - 默认 bind 不同 sessionId 抛 Error（并发保护）
 *   - 默认 clone 跳过 SKIP_KEYS（_session / _activeLocks 等）
 *   - 默认 clone 对不可 structuredClone 字段（函数）原样引用
 *   - clone 后 _session 被重置为 null
 */

import { describe, expect, it } from 'vitest';
import { CapabilityBase } from '../base.js';
import {
  FakeFileSystemCap,
  FakeShellCap,
  makeFakeSession,
} from './fixtures/fake-capabilities.js';

describe('CapabilityBase.bind 并发保护', () => {
  it('同 sessionId 多次 bind OK', async () => {
    const cap = new FakeFileSystemCap();
    const session = makeFakeSession('s1');
    await cap.bind(session);
    await cap.bind(session); // 同一个对象
    await cap.bind(makeFakeSession('s1')); // 不同对象但同 sessionId
    // 不抛错
    expect(true).toBe(true);
  });

  it('不同 sessionId 抛 Error', async () => {
    const cap = new FakeFileSystemCap();
    await cap.bind(makeFakeSession('s1'));
    await expect(cap.bind(makeFakeSession('s2'))).rejects.toThrow(
      /cannot be reused across concurrent sessions/,
    );
  });

  it('错误信息包含 capability type 与两个 sessionId', async () => {
    const cap = new FakeFileSystemCap();
    await cap.bind(makeFakeSession('alpha'));
    try {
      await cap.bind(makeFakeSession('beta'));
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('filesystem');
      expect(msg).toContain('alpha');
      expect(msg).toContain('beta');
    }
  });
});

describe('CapabilityBase.clone 默认实现', () => {
  it('clone 后 _session 被重置为 null', async () => {
    const cap = new FakeFileSystemCap();
    await cap.bind(makeFakeSession('s1'));
    const cloned = cap.clone() as FakeFileSystemCap;
    // @ts-expect-error - 访问 protected for test
    expect(cloned._session).toBeNull();
    // 原 cap 不动
    // @ts-expect-error - 访问 protected for test
    expect(cap._session).not.toBeNull();
  });

  it('clone 后 cloned 是独立实例 —— 修改 cloned 不影响 cap', () => {
    const cap = new FakeFileSystemCap();
    cap.internalState.counter = 42;
    const cloned = cap.clone() as FakeFileSystemCap;
    cloned.internalState.counter = 99;
    expect(cap.internalState.counter).toBe(42);
    expect(cloned.internalState.counter).toBe(99);
  });

  it('clone 后 cloned 的 prototype 链正确（保留 type / category / 方法）', () => {
    const cap = new FakeFileSystemCap();
    const cloned = cap.clone() as FakeFileSystemCap;
    expect(cloned.type).toBe('filesystem');
    expect(cloned.category).toBe('core');
    expect(typeof cloned.tools).toBe('function');
    expect(typeof cloned.bind).toBe('function');
    // tools 函数仍可调用
    const tools = cloned.tools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('list_directory');
  });

  it('clone 后 cloned 可以独立 bind 不同 session', async () => {
    const cap = new FakeFileSystemCap();
    await cap.bind(makeFakeSession('s1'));
    const cloned = cap.clone() as FakeFileSystemCap;
    // cloned 的 _session 是 null，可以绑定另一个 session
    await cloned.bind(makeFakeSession('s2'));
    // 不抛错
    expect(true).toBe(true);
  });

  it('clone 跳过 _session / _activeLocks / _subscribeHandles / _tools / _eventEmitterHandles', async () => {
    /**
     * 构造一个 capability 显式持有这些字段，验证 clone 后被重置为 null。
     */
    class CapWithSkipKeys extends CapabilityBase {
      readonly type = 'with-skip';
      readonly category = 'core' as const;
      _activeLocks: object = { lock: 'real-lock' };
      _subscribeHandles: object[] = [{ id: 1 }];
      _tools: object[] = [{ name: 't' }];
      _eventEmitterHandles: object[] = [{ emitter: 'e' }];
    }
    const cap = new CapWithSkipKeys();
    await cap.bind(makeFakeSession('s1'));
    const cloned = cap.clone() as unknown as CapWithSkipKeys;

    expect(cloned._activeLocks).toBeNull();
    expect(cloned._subscribeHandles).toBeNull();
    expect(cloned._tools).toBeNull();
    expect(cloned._eventEmitterHandles).toBeNull();
  });

  it('clone 对函数字段保留原引用（structuredClone 不接受函数）', () => {
    const sharedFn = () => 'shared';
    class CapWithFn extends CapabilityBase {
      readonly type = 'with-fn';
      readonly category = 'core' as const;
      handler = sharedFn;
      data = { value: 1 };
    }
    const cap = new CapWithFn();
    const cloned = cap.clone() as unknown as CapWithFn;
    expect(cloned.handler).toBe(sharedFn); // 引用相等
    expect(cloned.data).not.toBe(cap.data); // 普通对象深拷贝
    expect(cloned.data).toEqual({ value: 1 });
  });

  it('clone 不调用 constructor —— 子类有副作用 constructor 不会触发', () => {
    let constructorCalls = 0;
    class CapWithSideEffect extends CapabilityBase {
      readonly type = 'side-effect';
      readonly category = 'core' as const;
      constructor() {
        super();
        constructorCalls++;
      }
    }
    const cap = new CapWithSideEffect();
    expect(constructorCalls).toBe(1);
    cap.clone();
    expect(constructorCalls).toBe(1); // clone 不再触发
  });
});

describe('CapabilityBase 与 FakeShellCap 整体行为', () => {
  it('bind + clone + tools 调用链 OK', async () => {
    const cap = new FakeShellCap();
    await cap.bind(makeFakeSession('s1'));
    const cloned = cap.clone() as FakeShellCap;
    await cloned.bind(makeFakeSession('s2'));
    const tools = cloned.tools();
    expect(tools[0].name).toBe('exec_command');
  });
});
