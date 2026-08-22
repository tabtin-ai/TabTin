/**
 * ProcessIsolatedBackend 隔离/降级测试（不 fork 真进程，注入假 child）。
 *
 * 核心不变量：无论子进程 load 失败 / 崩溃退出 / embed 报错，都表现为
 * `load()`/`embed()` 抛错（上层据此降级词法），**绝不把异常变成静默成功、
 * 也不可能连累宿主进程**。并验证正常路径的请求/响应与顺序。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ProcessIsolatedBackend,
  type IsolatedChild,
} from '../process-isolated-backend.js';
import type { ChildInboundMessage, ChildOutboundMessage } from '../isolation-protocol.js';

class FakeChild implements IsolatedChild {
  messageCbs: ((m: ChildOutboundMessage) => void)[] = [];
  exitCbs: ((code: number | null) => void)[] = [];
  errorCbs: ((e: Error) => void)[] = [];
  sent: ChildInboundMessage[] = [];
  killed = false;
  /** 测试可设置：收到 embed 请求时自动如何回应。 */
  onEmbed?: (msg: Extract<ChildInboundMessage, { type: 'embed' }>) => void;
  autoLoaded = true;

  send(msg: ChildInboundMessage): void {
    this.sent.push(msg);
    if (msg.type === 'load' && this.autoLoaded) {
      queueMicrotask(() => this.emit({ type: 'loaded' }));
    }
    if (msg.type === 'embed' && this.onEmbed) {
      const m = msg;
      queueMicrotask(() => this.onEmbed!(m));
    }
  }
  on(event: 'message' | 'exit' | 'error', cb: (arg?: never) => void): void {
    if (event === 'message') this.messageCbs.push(cb as never);
    else if (event === 'exit') this.exitCbs.push(cb as never);
    else this.errorCbs.push(cb as never);
  }
  kill(): void { this.killed = true; }

  emit(m: ChildOutboundMessage): void { for (const cb of this.messageCbs) cb(m); }
  emitExit(code: number | null): void { for (const cb of this.exitCbs) cb(code); }
}

function makeBackend(child: FakeChild, opts?: { embedTimeoutMs?: number; loadTimeoutMs?: number; respawnCooldownMs?: number }) {
  return new ProcessIsolatedBackend({
    childEntryPath: '/fake/onnx-embed-child.mjs',
    modelDir: '/fake/model',
    dims: 3,
    fork: () => child,
    embedTimeoutMs: opts?.embedTimeoutMs ?? 30_000,
    loadTimeoutMs: opts?.loadTimeoutMs ?? 120_000,
    respawnCooldownMs: opts?.respawnCooldownMs ?? 60_000,
  });
}

describe('ProcessIsolatedBackend', () => {
  it('正常：load 成功后 embed 请求/响应对得上', async () => {
    const child = new FakeChild();
    child.onEmbed = (m) => child.emit({ type: 'embedded', id: m.id, vectors: m.texts.map(() => Float32Array.from([1, 2, 3])) });
    const backend = makeBackend(child);
    await backend.load();
    const out = await backend.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(Array.from(out[0]!)).toEqual([1, 2, 3]);
    expect(child.sent[0]).toEqual({ type: 'load', modelDir: '/fake/model', dims: 3 });
  });

  it('空输入不发请求直接返回空', async () => {
    const child = new FakeChild();
    const backend = makeBackend(child);
    await backend.load();
    expect(await backend.embed([])).toEqual([]);
    expect(child.sent.filter((m) => m.type === 'embed')).toHaveLength(0);
  });

  it('子进程 load 阶段崩溃退出 → load() 抛错（上层降级）', async () => {
    const child = new FakeChild();
    child.autoLoaded = false; // 不回 loaded
    const backend = makeBackend(child);
    const p = backend.load();
    queueMicrotask(() => child.emitExit(134)); // SIGABRT 典型退出码
    await expect(p).rejects.toThrow(/退出/);
  });

  it('load_error → load() 抛错', async () => {
    const child = new FakeChild();
    child.autoLoaded = false;
    const backend = makeBackend(child);
    const p = backend.load();
    queueMicrotask(() => child.emit({ type: 'load_error', message: '模型缺失' }));
    await expect(p).rejects.toThrow(/模型缺失/);
  });

  it('embed 在途时子进程崩溃 → 该 embed 抛错', async () => {
    const child = new FakeChild();
    const backend = makeBackend(child);
    await backend.load();
    child.onEmbed = () => child.emitExit(139); // 崩溃，不回结果
    await expect(backend.embed(['x'])).rejects.toThrow(/退出/);
  });

  it('embed_error → 该 embed 抛错', async () => {
    const child = new FakeChild();
    const backend = makeBackend(child);
    await backend.load();
    child.onEmbed = (m) => child.emit({ type: 'embed_error', id: m.id, message: '推理失败' });
    await expect(backend.embed(['x'])).rejects.toThrow(/推理失败/);
  });

  it('崩溃后冷却期内不重启，embed 直接抛错降级', async () => {
    const child = new FakeChild();
    const backend = makeBackend(child, { respawnCooldownMs: 999_999 });
    await backend.load();
    child.emitExit(1); // 崩了
    await expect(backend.embed(['x'])).rejects.toThrow(/不可用/);
    expect(child.killed).toBe(true);
  });

  it('embed 超时 → 抛错并杀子进程', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const backend = makeBackend(child, { embedTimeoutMs: 1000 });
      await backend.load();
      child.onEmbed = () => {}; // 永不回应
      const p = backend.embed(['x']);
      const assertion = expect(p).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
