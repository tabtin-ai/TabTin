import type { ToolError } from '../types/errors';

/**
 * Navigation state for a specific tab.
 */
export interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  status?: 'idle' | 'loading';
  url?: string;
  title?: string;
}

/**
 * Normalized tab info for agent usage.
 * Optional fields may be missing depending on data source (run vs crawlspace).
 */
export interface TabInfo {
  viewId: string;
  id?: string;
  url?: string;
  title?: string;
  favicon?: string;
  isActive?: boolean;
  runId?: string;
  crawlspaceId?: string;
  kind?: 'workspace-view' | 'normal-view';
  isPreview?: boolean;
  createdAt?: number;
  lastUpdatedAt?: number;
  nav?: NavigationState | null;
}

/**
 * Input for get_tabs.
 */
export interface GetTabsInput {
  runId?: string;
  crawlspaceId?: string;
  activeOnly?: boolean;
  sortBy?: 'lastUpdated' | 'createdAt' | 'title';
  order?: 'asc' | 'desc';
  limit?: number;
  includeNavigationState?: boolean;
}

/**
 * Output for get_tabs.
 */
export interface GetTabsOutput {
  success: boolean;
  tabs?: TabInfo[];
  data?: { tabs: TabInfo[] };
  error?: ToolError;
}

/**
 * Input for tab_state.
 */
export interface TabStateInput {
  viewId: string;
  runId?: string;
  includeHistory?: boolean;
}

/**
 * Output for tab_state.
 */
export interface TabStateOutput {
  success: boolean;
  data?: NavigationState & { lastUpdatedAt?: number };
  error?: ToolError;
}

/**
 * Input for nav_tab.
 */
export interface NavTabInput {
  viewId: string;
  action: 'back' | 'forward' | 'reload' | 'stop';
  ignoreCache?: boolean;
}

/**
 * Output for nav_tab.
 */
export interface NavTabOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

/**
 * Input for load_tab_url.
 */
export interface LoadTabUrlInput {
  viewId: string;
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'settled';
  timeout?: number;
  waitForSelector?: string;
  waitForTimeout?: number;
  waitForState?: 'attached' | 'visible' | 'hidden';
  /**  / ：Workspace 本地 HTML 预览的 file:// 放行根 */
  localPreviewRoot?: string;
}

/**
 * Output for load_tab_url.
 * readiness 仅在 waitUntil=settled 时出现：settled=内容渲染稳定；unsettled_timeout=到达上限仍在变化。
 */
export interface LoadTabUrlOutput {
  success: boolean;
  data?: {
    status?: 'loaded' | 'timeout' | 'error';
    finalUrl?: string;
    timing?: { start: number; end: number; duration: number };
    readiness?: 'settled' | 'unsettled_timeout';
  };
  error?: ToolError;
}

/**
 * Input for wait_for.
 */
export interface WaitForInput {
  viewId: string;
  selector?: string;
  state?: 'attached' | 'visible' | 'hidden';
  timeout?: number;
  delay?: number;
  pollInterval?: number;
}

/**
 * Output for wait_for.
 */
export interface WaitForOutput {
  success: boolean;
  data?: { elapsedMs?: number };
  error?: ToolError;
}
