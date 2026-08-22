/**
 * `open_tab` 工具的 partition 解析契约（本地化退役 Wave 2 之后）。
 *
 * 覆盖场景：
 *   1. Agent `open_tab` 带 `metadata.spaceId` → partition 来自 Space 绑定的环境
 *   2. 切换 Space 环境（resolver 返回不同值）→ Agent 新 view 立即用新 partition
 *   3. Space 未绑定 → resolver 返回默认 partition，view 正常创建
 *   4. 完全未注入 BrowserEnvAPI（Daemon 模式）→ partition 为 undefined，
 *      让主进程 RunSessionManager 按 metadata.spaceId 二次解析
 *   5. resolver 抛异常 → 同上，不再回到 legacy crawlspace fallback
 *   6. 显式 `input.partition` 优先级最高
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setBrowserEnvAPI,
  setContextSpaceAPI,
  setCrawlViewAPI,
  setRunSessionAPI,
  setViewFactoryAPI,
} from '../../utils/runtime-bridge';
import { openTabTool } from '../tab-management';

describe('open_tab · partition 解析（本地化退役 Wave 2）', () => {
  let openTabMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openTabMock = vi.fn().mockResolvedValue({
      success: true,
      id: 'view-xyz',
      viewId: 'view-xyz',
      profile: 'background-task',
      reused: false,
    });
    setRunSessionAPI({
      openTab: openTabMock,
    });
  });

  afterEach(() => {
    setBrowserEnvAPI(null);
    setContextSpaceAPI(null);
    setCrawlViewAPI(null);
    setRunSessionAPI(null);
    setViewFactoryAPI(null);
    vi.restoreAllMocks();
  });

  it('Agent open_tab 走 Space 绑定的 env partition', async () => {
    setBrowserEnvAPI({
      getPartitionForSpace: vi.fn().mockImplementation((spaceId: string) => {
        if (spaceId === 'space-A') return 'tabtin:env:default';
        if (spaceId === 'space-B') return 'tabtin:env:work';
        return null;
      }),
    });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://github.com',
      metadata: { spaceId: 'space-A' },
    });

    expect(result.success).toBe(true);
    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openTabMock.mock.calls[0][0].partition).toBe('tabtin:env:default');
  });

  it('切换 Space 环境后，新 view 使用新 partition', async () => {
    const resolver = vi.fn()
      .mockImplementationOnce(() => 'tabtin:env:default')
      .mockImplementationOnce(() => 'tabtin:env:work');
    setBrowserEnvAPI({ getPartitionForSpace: resolver });

    await openTabTool.execute({
      runId: 'run-1',
      url: 'https://github.com',
      metadata: { spaceId: 'space-A' },
    });
    expect(openTabMock.mock.calls[0][0].partition).toBe('tabtin:env:default');

    await openTabTool.execute({
      runId: 'run-1',
      url: 'https://google.com',
      metadata: { spaceId: 'space-A' },
    });
    expect(openTabMock.mock.calls[1][0].partition).toBe('tabtin:env:work');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('Space 未绑定时，resolver 返回的默认 partition 被采用', async () => {
    setBrowserEnvAPI({
      getPartitionForSpace: vi.fn().mockReturnValue('tabtin:env:default'),
    });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://github.com',
      metadata: { spaceId: 'unknown-space' },
    });

    expect(result.success).toBe(true);
    expect(openTabMock.mock.calls[0][0].partition).toBe('tabtin:env:default');
  });

  it('未注入 BrowserEnvAPI（Daemon 模式）→ partition 为 undefined，下游主进程二次解析', async () => {
    setBrowserEnvAPI(null);
    setViewFactoryAPI({
      getViewState: vi.fn().mockReturnValue({
        config: {
          metadata: { crawlspaceId: 'cs-legacy-1', kind: 'workspace-view' },
        },
      }),
    });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://github.com',
      crawlTabId: 'legacy-view-1',
    } as any);

    expect(result.success).toBe(true);
    expect(openTabMock.mock.calls[0][0].partition).toBeUndefined();
  });

  it('resolver 抛异常时 partition 为 undefined（不再拼 crawlspaceId fallback）', async () => {
    setBrowserEnvAPI({
      getPartitionForSpace: vi.fn().mockImplementation(() => {
        throw new Error('service crashed');
      }),
    });
    setViewFactoryAPI({
      getViewState: vi.fn().mockReturnValue({
        config: {
          metadata: { crawlspaceId: 'cs-X', kind: 'workspace-view' },
        },
      }),
    });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://github.com',
      crawlTabId: 'view-from-X',
      metadata: { crawlspaceId: 'cs-X', spaceId: 'space-A' },
    } as any);

    expect(result.success).toBe(true);
    expect(openTabMock.mock.calls[0][0].partition).toBeUndefined();
  });

  it('显式 input.partition 优先级最高，不被 resolver 覆盖', async () => {
    const resolver = vi.fn().mockReturnValue('tabtin:env:should-not-be-used');
    setBrowserEnvAPI({ getPartitionForSpace: resolver });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://github.com',
      partition: 'tabtin:env:explicit',
      metadata: { spaceId: 'space-A' },
    });

    expect(result.success).toBe(true);
    expect(openTabMock.mock.calls[0][0].partition).toBe('tabtin:env:explicit');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('带 conversation tabScopeKey 时通过 context-space 创建可见网页 tab', async () => {
    const createWebTab = vi.fn().mockResolvedValue({
      success: true,
      data: {
        crawlspaceId: 'cs-conv',
        viewId: 'view-conv',
        tabKey: 'tabweb:view-conv',
      },
    });
    setContextSpaceAPI({ createWebTab });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://example.com',
      _space_id: 'space-A',
      tabScopeKey: 'conversation:session-1',
    });

    expect(result.success).toBe(true);
    expect(result.viewId).toBe('view-conv');
    expect(createWebTab).toHaveBeenCalledWith({
      spaceId: 'space-A',
      tabScopeKey: 'conversation:session-1',
      workspaceScopeKey: 'conversation:session-1',
      runId: 'run-1',
      url: 'https://example.com',
      title: 'https://example.com',
    });
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it('显式 hidden displayMode 时不投影到画布，继续走 RunSession', async () => {
    const createWebTab = vi.fn().mockResolvedValue({
      success: true,
      data: { viewId: 'view-conv' },
    });
    setContextSpaceAPI({ createWebTab });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://example.com',
      _space_id: 'space-A',
      tabScopeKey: 'conversation:session-1',
      displayMode: 'hidden',
    } as any);

    expect(result.success).toBe(true);
    expect(createWebTab).not.toHaveBeenCalled();
    expect(openTabMock).toHaveBeenCalledTimes(1);
  });

  it('可见网页 tab 创建失败时返回错误，不静默回落 hidden RunSession', async () => {
    const createWebTab = vi.fn().mockResolvedValue({
      success: false,
      error: 'renderer unavailable',
    });
    setContextSpaceAPI({ createWebTab });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://example.com',
      _space_id: 'space-A',
      tabScopeKey: 'conversation:session-1',
    });

    expect(result.success).toBe(false);
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it('可见网页 tab 支持 waitUntil 加载等待', async () => {
    const createWebTab = vi.fn().mockResolvedValue({
      success: true,
      data: { viewId: 'view-conv' },
    });
    const loadUrl = vi.fn().mockResolvedValue({ success: true });
    setContextSpaceAPI({ createWebTab });
    setCrawlViewAPI({ loadUrl });

    const result = await openTabTool.execute({
      runId: 'run-1',
      url: 'https://example.com',
      _space_id: 'space-A',
      tabScopeKey: 'conversation:session-1',
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(loadUrl).toHaveBeenCalledWith('view-conv', 'https://example.com', {
      waitUntil: 'domcontentloaded',
      timeout: 5000,
      waitForSelector: undefined,
      waitForTimeout: undefined,
      waitForState: undefined,
    });
    expect(openTabMock).not.toHaveBeenCalled();
  });
});
