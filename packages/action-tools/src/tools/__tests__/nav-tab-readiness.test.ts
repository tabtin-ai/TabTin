/**
 * nav_tab 就绪对齐契约：
 *  - back / forward 无历史时返回明确错误，不再恒 success
 *  - back / forward / reload 成功后调用 waitForTabReady 并回填 data.readiness
 *  - stop 语义是中止加载，不做就绪等待
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCrawlViewAPI } from '../../utils/runtime-bridge';
import { navTabTool } from '../tab-navigation-tools';

afterEach(() => {
  setCrawlViewAPI(null);
  vi.restoreAllMocks();
});

describe('navTabTool · 就绪对齐', () => {
  it('back 无历史（goBack 返回 false）→ 明确错误，不报 success', async () => {
    const waitForTabReady = vi.fn();
    setCrawlViewAPI({
      goBack: vi.fn(async () => false),
      waitForTabReady,
    });
    const res: any = await navTabTool.execute({ viewId: 'v1', action: 'back' } as any);
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(waitForTabReady).not.toHaveBeenCalled();
  });

  it('reload 成功后等就绪并回填 data.readiness', async () => {
    const waitForTabReady = vi.fn(async () => 'settled');
    setCrawlViewAPI({
      reload: vi.fn(async () => true),
      waitForTabReady,
    });
    const res: any = await navTabTool.execute({ viewId: 'v1', action: 'reload' } as any);
    expect(res.success).toBe(true);
    expect(waitForTabReady).toHaveBeenCalledWith('v1');
    expect(res.data?.readiness).toBe('settled');
  });

  it('back 成功后等就绪（回 unsettled_timeout 仍 success）', async () => {
    const waitForTabReady = vi.fn(async () => 'unsettled_timeout');
    setCrawlViewAPI({
      goBack: vi.fn(async () => true),
      waitForTabReady,
    });
    const res: any = await navTabTool.execute({ viewId: 'v1', action: 'back' } as any);
    expect(res.success).toBe(true);
    expect(waitForTabReady).toHaveBeenCalledWith('v1');
    expect(res.data?.readiness).toBe('unsettled_timeout');
  });

  it('stop 不做就绪等待', async () => {
    const waitForTabReady = vi.fn();
    setCrawlViewAPI({
      stop: vi.fn(async () => true),
      waitForTabReady,
    });
    const res: any = await navTabTool.execute({ viewId: 'v1', action: 'stop' } as any);
    expect(res.success).toBe(true);
    expect(waitForTabReady).not.toHaveBeenCalled();
  });

  it('就绪返回 undefined（tab 已销毁）时省略 data.readiness', async () => {
    const waitForTabReady = vi.fn(async () => undefined);
    setCrawlViewAPI({
      goForward: vi.fn(async () => true),
      waitForTabReady,
    });
    const res: any = await navTabTool.execute({ viewId: 'v1', action: 'forward' } as any);
    expect(res.success).toBe(true);
    expect(res.data?.readiness).toBeUndefined();
  });
});
