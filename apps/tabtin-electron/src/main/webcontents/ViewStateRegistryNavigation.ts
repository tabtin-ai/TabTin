/**
 * ViewStateRegistry — 导航决策纯函数
 *
 * 从 ViewStateRegistry 拆出，不依赖 class 实例。
 */

import type { ViewState, NavigationAction } from './ViewStateRegistryTypes';

/**
 * 判断两个 URL 是否等价
 * 容忍协议差异(http/https)、尾部斜杠、www 前缀
 */
export function isSameUrl(url1: string, url2: string, ignoreProtocol = true): boolean {
  if (url1 === url2) return true;

  if (url1 === 'about:blank' || url2 === 'about:blank') {
    return url1 === url2;
  }

  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);

    if (!ignoreProtocol && u1.protocol !== u2.protocol) {
      return false;
    }

    const normalize = (url: URL) => {
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      const hostname = url.hostname.replace(/^www\./, '');
      return `${hostname}${pathname}${url.search}`;
    };

    return normalize(u1) === normalize(u2);
  } catch {
    return url1 === url2;
  }
}

/**
 * 创建空的 ViewState（用于不存在的 View 的占位）
 */
export function createEmptyState(id: string): ViewState {
  return {
    id,
    url: 'about:blank',
    status: 'idle',
    mode: 'unknown',
    owner: 'shared',
    lastLoadTime: 0,
    lastAccessTime: 0,
    loadHistory: [],
    reusable: true,
    inUse: false,
    metadata: {
      createdBy: 'unknown',
      createdAt: Date.now()
    }
  };
}

/**
 * 纯函数：根据当前状态和目标 URL 决定导航动作
 *
 * @returns `{ action, reason, estimatedWaitTime? }`
 */
export function computeNavigationAction(
  state: ViewState | undefined,
  targetUrl: string,
  options: { forceReload?: boolean; staleTime?: number } = {}
): { action: NavigationAction; reason: string; estimatedWaitTime?: number } {
  if (!targetUrl || targetUrl.trim() === '') {
    return { action: 'navigate', reason: '目标URL为空' };
  }

  if (targetUrl === 'about:blank' && state?.url === 'about:blank' && state.status === 'loaded') {
    return { action: 'skip', reason: '已在about:blank' };
  }

  if (!state) {
    return { action: 'navigate', reason: 'View 不存在于注册表中' };
  }

  const same = isSameUrl(state.url, targetUrl);
  if (!same) {
    return { action: 'navigate', reason: `URL 不同（当前: ${state.url}, 目标: ${targetUrl}）` };
  }

  if (state.status === 'loading') {
    return { action: 'wait', reason: '页面正在加载中', estimatedWaitTime: 5000 };
  }

  if (state.status === 'loaded') {
    if (options.forceReload) {
      return { action: 'reload', reason: '强制重新加载' };
    }
    if (options.staleTime) {
      const age = Date.now() - state.lastLoadTime;
      if (age > options.staleTime) {
        return {
          action: 'reload',
          reason: `页面已过期（${Math.round(age / 1000)}秒 > ${Math.round(options.staleTime / 1000)}秒）`
        };
      }
    }
    return { action: 'skip', reason: '页面已在目标URL且加载完成' };
  }

  return { action: 'navigate', reason: `当前状态: ${state.status}` };
}
