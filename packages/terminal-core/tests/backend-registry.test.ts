import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionBackendRegistry } from '../src/backend/registry';
import type {
  BackendCapabilities,
  BackendFactory,
  ExecutionBackend,
  BackendConfig,
} from '../src/backend/types';

function makeBackend(overrides: Partial<ExecutionBackend> = {}): ExecutionBackend {
  return {
    id: overrides.id ?? 'test',
    capabilities: overrides.capabilities ?? {
      supportsInteractive: false,
      supportsSandbox: false,
      supportsNetworkIsolation: false,
      supportsFileSystemIsolation: false,
      latencyClass: 'local',
      platforms: ['darwin', 'linux', 'win32'],
    },
    execute: overrides.execute ?? vi.fn(),
    cleanup: overrides.cleanup ?? vi.fn(async () => {}),
  };
}

function makeFactory(backend: ExecutionBackend): BackendFactory {
  return { create: vi.fn(async (_: BackendConfig) => backend) };
}

describe('ExecutionBackendRegistry', () => {
  let registry: ExecutionBackendRegistry;

  beforeEach(() => {
    registry = new ExecutionBackendRegistry();
  });

  // ── register ──────────────────────────────────────────────────────

  it('注册后端并通过 list 列出', () => {
    const backend = makeBackend({ id: 'alpha' });
    registry.register('alpha', makeFactory(backend), backend.capabilities);

    const items = registry.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('alpha');
    expect(items[0].capabilities).toEqual(backend.capabilities);
  });

  it('重复注册同一 id 抛出错误', () => {
    const backend = makeBackend({ id: 'dup' });
    registry.register('dup', makeFactory(backend), backend.capabilities);
    expect(() => registry.register('dup', makeFactory(backend), backend.capabilities))
      .toThrowError('Backend "dup" is already registered');
  });

  // ── get ───────────────────────────────────────────────────────────

  it('按 id 获取已注册后端', async () => {
    const backend = makeBackend({ id: 'b1' });
    registry.register('b1', makeFactory(backend), backend.capabilities);

    const resolved = await registry.get('b1');
    expect(resolved).toBe(backend);
  });

  it('获取不存在的 id 返回 null', async () => {
    expect(await registry.get('nonexistent')).toBeNull();
  });

  // ── resolve ───────────────────────────────────────────────────────

  it('无条件 resolve 返回第一个本地后端', async () => {
    const b = makeBackend({ id: 'local1' });
    registry.register('local1', makeFactory(b), b.capabilities);

    const resolved = await registry.resolve();
    expect(resolved).toBe(b);
  });

  it('requireSandbox 过滤不支持沙箱的后端', async () => {
    const noSandbox = makeBackend({
      id: 'no-sandbox',
      capabilities: {
        supportsInteractive: true,
        supportsSandbox: false,
        supportsNetworkIsolation: false,
        supportsFileSystemIsolation: false,
        latencyClass: 'local',
        platforms: ['darwin'],
      },
    });
    const withSandbox = makeBackend({
      id: 'with-sandbox',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: true,
        supportsFileSystemIsolation: true,
        latencyClass: 'local',
        platforms: ['darwin'],
      },
    });

    registry.register('no-sandbox', makeFactory(noSandbox), noSandbox.capabilities);
    registry.register('with-sandbox', makeFactory(withSandbox), withSandbox.capabilities);

    const resolved = await registry.resolve({ requireSandbox: true });
    expect(resolved?.id).toBe('with-sandbox');
  });

  it('requireNetworkIsolation 过滤不支持网络隔离的后端', async () => {
    const noNet = makeBackend({
      id: 'no-net',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: false,
        supportsFileSystemIsolation: true,
        latencyClass: 'local',
        platforms: ['linux'],
      },
    });
    const withNet = makeBackend({
      id: 'with-net',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: true,
        supportsFileSystemIsolation: true,
        latencyClass: 'local',
        platforms: ['linux'],
      },
    });

    registry.register('no-net', makeFactory(noNet), noNet.capabilities);
    registry.register('with-net', makeFactory(withNet), withNet.capabilities);

    const resolved = await registry.resolve({ requireNetworkIsolation: true });
    expect(resolved?.id).toBe('with-net');
  });

  it('platform 过滤不支持的平台', async () => {
    const darwinOnly = makeBackend({
      id: 'darwin-only',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: false,
        supportsFileSystemIsolation: true,
        latencyClass: 'local',
        platforms: ['darwin'],
      },
    });

    registry.register('darwin-only', makeFactory(darwinOnly), darwinOnly.capabilities);

    expect(await registry.resolve({ platform: 'linux' })).toBeNull();
    expect((await registry.resolve({ platform: 'darwin' }))?.id).toBe('darwin-only');
  });

  it('preferInteractive 优先返回交互式后端', async () => {
    const nonInteractive = makeBackend({
      id: 'spawn',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: true,
        supportsFileSystemIsolation: true,
        latencyClass: 'local',
        platforms: ['darwin', 'linux'],
      },
    });
    const interactive = makeBackend({
      id: 'pty',
      capabilities: {
        supportsInteractive: true,
        supportsSandbox: false,
        supportsNetworkIsolation: false,
        supportsFileSystemIsolation: false,
        latencyClass: 'local',
        platforms: ['darwin', 'linux'],
      },
    });

    registry.register('spawn', makeFactory(nonInteractive), nonInteractive.capabilities);
    registry.register('pty', makeFactory(interactive), interactive.capabilities);

    const resolved = await registry.resolve({ preferInteractive: true });
    expect(resolved?.id).toBe('pty');
  });

  it('local 优先于 remote', async () => {
    const remote = makeBackend({
      id: 'cloud',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: true,
        supportsFileSystemIsolation: true,
        latencyClass: 'remote',
        platforms: ['linux'],
      },
    });
    const local = makeBackend({
      id: 'local',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: true,
        supportsNetworkIsolation: true,
        supportsFileSystemIsolation: true,
        latencyClass: 'local',
        platforms: ['linux'],
      },
    });

    registry.register('cloud', makeFactory(remote), remote.capabilities);
    registry.register('local', makeFactory(local), local.capabilities);

    const resolved = await registry.resolve({ platform: 'linux' });
    expect(resolved?.id).toBe('local');
  });

  it('无匹配后端时返回 null', async () => {
    const b = makeBackend({
      id: 'basic',
      capabilities: {
        supportsInteractive: false,
        supportsSandbox: false,
        supportsNetworkIsolation: false,
        supportsFileSystemIsolation: false,
        latencyClass: 'local',
        platforms: ['darwin'],
      },
    });
    registry.register('basic', makeFactory(b), b.capabilities);

    expect(await registry.resolve({ requireSandbox: true })).toBeNull();
  });

  // ── unregister ────────────────────────────────────────────────────

  it('卸载已注册后端', async () => {
    const cleanup = vi.fn(async () => {});
    const b = makeBackend({ id: 'removable', cleanup });
    registry.register('removable', makeFactory(b), b.capabilities);

    await registry.get('removable');

    const removed = await registry.unregister('removable');
    expect(removed).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  it('卸载不存在的后端返回 false', async () => {
    expect(await registry.unregister('ghost')).toBe(false);
  });

  // ── dispose ───────────────────────────────────────────────────────

  it('dispose 清理所有后端实例', async () => {
    const cleanup1 = vi.fn(async () => {});
    const cleanup2 = vi.fn(async () => {});
    const b1 = makeBackend({ id: 'a', cleanup: cleanup1 });
    const b2 = makeBackend({ id: 'b', cleanup: cleanup2 });

    registry.register('a', makeFactory(b1), b1.capabilities);
    registry.register('b', makeFactory(b2), b2.capabilities);

    await registry.get('a');
    await registry.get('b');
    await registry.dispose();

    expect(cleanup1).toHaveBeenCalled();
    expect(cleanup2).toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  // ── 实例缓存 ─────────────────────────────────────────────────────

  it('多次 get 同一 id 返回同一实例（factory 只调用一次）', async () => {
    const b = makeBackend({ id: 'cached' });
    const factory = makeFactory(b);
    registry.register('cached', factory, b.capabilities);

    const first = await registry.get('cached');
    const second = await registry.get('cached');

    expect(first).toBe(second);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });
});
