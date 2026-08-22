/**
 * ViewStateRegistry — 类型定义与工具函数
 */

import type { WebContents } from 'electron';

/**
 * : 参数从 WebContentsView 收窄为 WebContents（取 .webContents 上提到调用方）。
 * 判活语义与旧实现等价：webContents 缺失 / isDestroyed 非函数 / 调用抛错均视为不存活。
 *
 * ⚠️ 与 `crawl-view/utils.ts` 的 `isAliveWebContents` 在「isDestroyed 非函数」这一
 * 边界上语义**相反**（那边视为存活）——两模块历史上各自演化，本次零行为变化重构
 * 各自保留原语义，勿跨模块混用；收敛见 issue 跟踪。
 */
export function hasAliveWebContents(webContents?: WebContents | null): boolean {
  if (!webContents) {
    return false;
  }
  const isDestroyedFn = (webContents as any)?.isDestroyed;
  if (typeof isDestroyedFn !== 'function') {
    return false;
  }
  try {
    return !isDestroyedFn.call(webContents);
  } catch {
    return false;
  }
}

export interface ViewState {
  id: string;
  url: string;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  title?: string;
  favicon?: string;
  mode: 'preview' | 'task' | 'background' | 'unknown';
  owner: 'embedded-crawl-view' | 'electron-launcher' | 'shared';
  lastLoadTime: number;
  lastAccessTime: number;
  loadHistory: LoadEvent[];
  reusable: boolean;
  /** RF04: 由 ViewFactory 通过 updateState 驱动，标识 View 是否正被任务使用 */
  inUse: boolean;
  lastErrorDescription?: string;
  metadata: {
    taskId?: string;
    workflowStep?: string;
    createdBy: string;
    createdAt: number;
    [key: string]: any;
  };
}

export interface LoadEvent {
  url: string;
  timestamp: number;
  duration?: number;
  success: boolean;
}

export type NavigationAction =
  | 'skip'
  | 'wait'
  | 'reload'
  | 'navigate';

export interface NavigationDecision {
  action: NavigationAction;
  reason: string;
  currentState: ViewState;
  estimatedWaitTime?: number;
}

export interface NavigationOptions {
  forceReload?: boolean;
  staleTime?: number;
  waitForDynamic?: boolean;
  dynamicWaitTime?: number;
}

export interface ViewEventListeners {
  onStartLoading: () => void;
  onFinishLoad: () => void;
  onFailLoad: (
    event: any,
    code: number,
    desc: string,
    validatedURL?: string,
    isMainFrame?: boolean,
    frameProcessId?: number,
    frameRoutingId?: number,
  ) => void;
  onFrameNavigate: (
    event: any,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
    isMainFrame?: boolean,
    frameProcessId?: number,
    frameRoutingId?: number,
  ) => void;
  onStopLoading: () => void;
  onDomReady: () => void;
  onTitleUpdated: (_event: any, title: string) => void;
  onFaviconUpdated: (_event: any, favicons: string[]) => void;
  onNavigate: (_event: any, url: string) => void;
  onInPageNavigate: (_event: any, url: string) => void;
  onWillNavigate: (_event: any, url: string) => void;
}
