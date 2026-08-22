/**
 * RP-025/030/034 回归测试 — RunSessionManager 和 EventPersistence
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-run-events',
  },
}));

vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({
    setActiveView: vi.fn(),
  }),
}));
vi.mock('../../crawlspace/view-metadata-sync', () => ({
  syncWorkspaceViewMetadata: vi.fn(),
}));
vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({
    getTabByView: vi.fn(),
    isOrganizationTab: vi.fn(),
  }),
}));
vi.mock('../EventPersistence', () => ({
  getEventPersistence: () => ({
    addEvent: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: () => null,
  getCLICrawlspaceId: () => null,
}));

describe('RP-025: RunSessionManager runs 堆积保护', () => {
  it('超时清理空 runs 时不应报错', async () => {
    const mod = await import('../../run-session/RunSessionManager');
    const manager = mod.getRunSessionManager();
    manager.stopTimeoutChecker();

    // 空 runs 时不应抛出错误
    await (manager as any).checkAndCleanupTimeoutRuns();

    expect(manager.listRuns()).toHaveLength(0);
    mod.disposeRunSessionManager();
  });
});

describe('RP-034: RunSessionManager dispose', () => {
  it('dispose 应停止定时器并清理资源', async () => {
    const mod = await import('../../run-session/RunSessionManager');
    const manager = mod.getRunSessionManager();

    manager.createRun('test-run-1');
    manager.createRun('test-run-2');

    expect(manager.listRuns().length).toBe(2);

    mod.disposeRunSessionManager();

    // 获取新的单例
    const m2 = mod.getRunSessionManager();
    expect(m2.listRuns().length).toBe(0);

    mod.disposeRunSessionManager();
  });

  it('disposeRunSessionManager 应重置单例', async () => {
    const mod = await import('../../run-session/RunSessionManager');

    const m1 = mod.getRunSessionManager();
    m1.createRun('singleton-test');
    expect(m1.listRuns().length).toBeGreaterThan(0);

    mod.disposeRunSessionManager();

    const m2 = mod.getRunSessionManager();
    expect(m2).not.toBe(m1);
    expect(m2.listRuns().length).toBe(0);

    mod.disposeRunSessionManager();
  });
});

// RP-030 测试在独立文件 rp030-event-persistence.test.ts 中（避免 mock 冲突）
