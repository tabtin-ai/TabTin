/**
 * Capability 接口契约测试 —— 对应 M1 §6.1。
 *
 * 验证：
 *   - 最小 Capability 通过 tsc（运行时 instantiate 即可）
 *   - 全 hooks 都实现时按正确顺序调用
 *   - required_capability_types 三种返回情况
 *   - sampling_params deep merge 行为
 *
 * 阶段 2.3 清理（2026-05-20）：`Capability.instructions?()` 接口下线，
 * `describe('instructions return semantics')` 整段删除。
 */

import { describe, expect, it } from 'vitest';
import type { Capability } from '../capability.js';
import type {
  EngineState,
} from '../../engine/contracts/kernel.js';
import {
  FakeFileSystemCap,
  FakeMemoryCap,
  FakeNoOpCap,
  FakeShellCap,
  makeFakeSession,
  makeIterationCtx,
  makeRecorder,
  makeRunCtx,
} from './fixtures/fake-capabilities.js';

describe('Capability interface contract', () => {
  it('minimal Capability with only type/category compiles & instantiates', () => {
    const cap: Capability = {
      type: 'minimal',
      category: 'core',
    };
    expect(cap.type).toBe('minimal');
    expect(cap.category).toBe('core');
  });

  it('FakeNoOpCap 不实现任何 hook 时各 hook 调用都是 undefined', () => {
    const cap = new FakeNoOpCap();
    expect(cap.tools).toBeUndefined();
    expect(cap.hooks).toBeUndefined();
    expect(cap.sampling_params).toBeUndefined();
    expect(cap.process_manifest).toBeUndefined();
    expect(cap.on_session_stop).toBeUndefined();
    expect(cap.required_capability_types).toBeUndefined();
  });

  it('hooks() 返回的 EngineHooks 按正常方式被外部调用并记录顺序', async () => {
    const recorder = makeRecorder();
    const fs = new FakeFileSystemCap(recorder);
    const sh = new FakeShellCap(recorder);

    const fsHooks = fs.hooks();
    const shHooks = sh.hooks();
    expect(fsHooks).toBeTruthy();
    expect(shHooks).toBeTruthy();

    // 模拟外部调用顺序：fs 先 sh 后
    const fakeState = {} as EngineState;
    await fsHooks.beforeRun?.(makeRunCtx(fakeState));
    await shHooks.beforeRun?.(makeRunCtx(fakeState));
    await fsHooks.beforeIteration?.(makeIterationCtx(fakeState, 1));
    await shHooks.beforeIteration?.(makeIterationCtx(fakeState, 1));

    expect(recorder.calls).toEqual([
      { cap: 'filesystem', hook: 'beforeRun' },
      { cap: 'shell', hook: 'beforeRun' },
      { cap: 'filesystem', hook: 'beforeIteration', iteration: 1 },
      { cap: 'shell', hook: 'beforeIteration', iteration: 1 },
    ]);
  });

  describe('required_capability_types', () => {
    it('返回空 Set —— 视为无依赖', () => {
      const cap: Capability = {
        type: 't1',
        category: 'core',
        required_capability_types: () => new Set(),
      };
      const deps = cap.required_capability_types?.();
      expect(deps).toBeInstanceOf(Set);
      expect(deps?.size).toBe(0);
    });

    it('未实现 —— 视为无依赖', () => {
      const cap: Capability = { type: 't2', category: 'core' };
      expect(cap.required_capability_types).toBeUndefined();
    });

    it('返回 ReadonlySet 含多依赖', () => {
      const cap = new FakeMemoryCap();
      const deps = cap.required_capability_types();
      expect(deps).toBeInstanceOf(Set);
      expect(deps.size).toBe(2);
      expect(deps.has('filesystem')).toBe(true);
      expect(deps.has('shell')).toBe(true);
    });
  });

  // instructions return semantics 整段已删除 —— 阶段 2.3 接口下线。

  describe('sampling_params merge cooperation', () => {
    it('单 cap 返回字段直接生效', () => {
      const cap = new FakeFileSystemCap();
      const out = cap.sampling_params({});
      expect(out).toEqual({ temperature: 0.3, fs_extra: { from: 'filesystem' } });
    });

    it('调用方应把 current 透传 —— cap 内部只 return delta', () => {
      // 测试 sampling_params 自身契约：cap 不做 merge，只返回它要贡献的 delta。
      // 阶段 2 已删除 prepareAgentSampling 装配函数（0 production caller），
      // 但 Capability.sampling_params?() 接口本身仍保留 —— 未来若需要把 cap
      // 贡献的 sampling 字段拼起来，由宿主层显式 merge 而非走隐式装配函数。
      const cap = new FakeFileSystemCap();
      const out = cap.sampling_params({ existing: 'keep' });
      expect(out).toEqual({ temperature: 0.3, fs_extra: { from: 'filesystem' } });
    });
  });

  describe('on_session_stop', () => {
    it('被调用时会触发 capability 的清理逻辑', async () => {
      const cap = new FakeMemoryCap();
      expect(cap.stopped).toBe(false);
      await cap.on_session_stop(makeFakeSession('s1'));
      expect(cap.stopped).toBe(true);
    });
  });
});
