/**
 * TabResolver — Tab 解析与创建
 *
 * 职责：
 * - 从 runId 解析已有 Electron View（activeView → 第一个 view → crawlspace view）
 * - 必要时通过 runSession.openTab 创建新 View
 */

import { resolveViewFactoryAPI } from '../bridge';
import type { BrowserContext } from '../context/BrowserContext';

export type ViewGetter = (tabId: string) => any;
export type ContextFactory = (tabId: string) => BrowserContext | null;

export class TabResolver {
  private viewGetter: ViewGetter | null = null;
  private contextFactory: ContextFactory | null = null;

  setViewGetter(getter: ViewGetter): void {
    this.viewGetter = getter;
  }

  setContextFactory(factory: ContextFactory): void {
    this.contextFactory = factory;
  }

  /** @deprecated 使用 getContext() 替代 */
  getView(tabId: string): any {
    if (!this.viewGetter) return null;
    return this.viewGetter(tabId);
  }

  getContext(tabId: string): BrowserContext | null {
    if (!this.contextFactory) return null;
    return this.contextFactory(tabId);
  }

  /**
   * 尝试通过 runSession 复用或创建一个 Electron View。
   *
   * 解析优先级：
   * 1. run.activeViewId
   * 2. run.views[0]
   * 3. 当前活跃 crawlspace view
   * 4. 创建新 view（需要 URL）
   */
  async resolve(
    runId: string | undefined,
    input: any,
    options?: { partition?: string; proxy?: any; userAgent?: string },
  ): Promise<string | null> {
    if (!runId) return null;

    try {
      const tabtin = (global as any).tabtin || (typeof window !== 'undefined' ? (window as any).tabtin : null);
      if (!tabtin?.runSession?.openTab) return null;

      if (tabtin.runSession.get) {
        try {
          const run = await tabtin.runSession.get(runId);
          if (run?.activeViewId) return run.activeViewId as string;
          if (run?.views?.length) return run.views[0].viewId as string;
        } catch { /* ignore */ }
      }

      const viewFactory = resolveViewFactoryAPI();
      const currentViewId = viewFactory?.getCurrentViewId?.();
      if (currentViewId) {
        const state = viewFactory?.getViewState?.(currentViewId);
        if (state?.config?.metadata?.crawlspaceId) {
          return currentViewId as string;
        }
      }

      const targetUrl = input.url || input?.params?.url;
      if (targetUrl) {
        const resp = await tabtin.runSession.openTab({
          runId,
          url: targetUrl,
          partition: options?.partition,
          proxy: options?.proxy,
          userAgent: options?.userAgent,
          profile: 'background-task',
        });
        if (resp?.success && resp.id) return resp.id as string;
      }
    } catch (err) {
      console.warn('[TabResolver] ⚠️ resolve 失败:', err);
    }

    return null;
  }
}

let shared: TabResolver | null = null;

export function getSharedTabResolver(): TabResolver {
  if (!shared) shared = new TabResolver();
  return shared;
}
