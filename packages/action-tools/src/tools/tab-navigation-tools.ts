import type { AgentTool } from '../types';
import { ToolErrorCode, ToolErrorFactory } from '../types/errors';
import type {
  GetTabsInput,
  GetTabsOutput,
  LoadTabUrlInput,
  LoadTabUrlOutput,
  NavTabInput,
  NavTabOutput,
  TabStateInput,
  TabStateOutput,
  TabInfo,
  WaitForInput,
  WaitForOutput
} from './tab-navigation';
import {
  bridgeViewsFromRun,
  bridgeViewsFromCrawlspace,
  resolveLastUpdatedAt,
  resolveLastUpdatedAtFromRun
} from '../utils/tab-bridge';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolveCrawlViewAPI } from '../utils/runtime-bridge';
import { t } from '../i18n';

type CrawlViewAPI = {
  getNavigationState?: (tabId?: string, options?: { includeHistory?: boolean }) => Promise<any> | any;
  goBack?: (tabId?: string) => Promise<any> | any;
  goForward?: (tabId?: string) => Promise<any> | any;
  reload?: (ignoreCache?: boolean, tabId?: string) => Promise<any> | any;
  stop?: (tabId?: string) => Promise<any> | any;
  loadUrl?: (tabId: string, url: string, options?: any) => Promise<any> | any;
  waitForTabReady?: (tabId: string, options?: { timeout?: number }) => Promise<any> | any;
  waitForSelector?: (tabId: string, options: any) => Promise<any> | any;
};

function buildError(code: ToolErrorCode, message: string, context?: Record<string, any>) {
  const error = ToolErrorFactory.fatal(code, message, context);
  return {
    success: false,
    error
  };
}

function normalizeTabs(tabs: TabInfo[], input: GetTabsInput): TabInfo[] {
  let list = [...tabs];
  if (input.activeOnly) {
    list = list.filter(tab => tab.isActive);
  }

  const order = input.order === 'asc' ? 1 : -1;
  switch (input.sortBy) {
    case 'lastUpdated':
      list.sort((a, b) => ((a.lastUpdatedAt || 0) - (b.lastUpdatedAt || 0)) * order);
      break;
    case 'title':
      list.sort((a, b) => (a.title || '').localeCompare(b.title || '') * order);
      break;
    case 'createdAt':
    default:
      list.sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) * order);
      break;
  }

  if (typeof input.limit === 'number') {
    list = list.slice(0, input.limit);
  }

  return list;
}

export const getTabsTool: AgentTool<GetTabsInput, GetTabsOutput> = {
  name: 'get_tabs',
  description: t('tools.tabNavigation.getTabs.description'),
  parameters: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: t('tools.tabNavigation.getTabs.params.runId') },
      crawlspaceId: { type: 'string', description: t('tools.tabNavigation.getTabs.params.crawlspaceId') },
      activeOnly: { type: 'boolean', description: t('tools.tabNavigation.getTabs.params.activeOnly') },
      sortBy: { type: 'string', enum: ['lastUpdated', 'createdAt', 'title'] },
      order: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'number' },
      includeNavigationState: { type: 'boolean', description: t('tools.tabNavigation.getTabs.params.includeNavigationState') }
    },
    required: []
  },
  async execute(input: GetTabsInput): Promise<GetTabsOutput> {
    if (!input.runId && !input.crawlspaceId) {
      return buildError(ToolErrorCode.INVALID_PARAMETER, 'runId or crawlspaceId is required') as GetTabsOutput;
    }

    const bridge = input.runId
      ? await bridgeViewsFromRun(input.runId)
      : bridgeViewsFromCrawlspace(input.crawlspaceId as string);

    if (bridge.error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: bridge.error,
          error_code: bridge.error_code
        },
        { defaultErrorCode: bridge.error_code }
      ) as unknown as GetTabsOutput;
    }

    let tabs = normalizeTabs(bridge.tabs, input);

    if (input.includeNavigationState) {
      const crawlView = resolveCrawlViewAPI();
      if (!crawlView?.getNavigationState) {
        return buildError(ToolErrorCode.IPC_NOT_AVAILABLE, 'crawlView.getNavigationState unavailable') as GetTabsOutput;
      }
      tabs = await Promise.all(
        tabs.map(async (tab) => {
          try {
            const state = await crawlView.getNavigationState?.(tab.viewId);
            return { ...tab, nav: state };
          } catch {
            return { ...tab, nav: null };
          }
        })
      );
    }

    return standardizeLegacyResult({ success: true, tabs }) as GetTabsOutput;
  }
};

export const tabStateTool: AgentTool<TabStateInput, TabStateOutput> = {
  name: 'tab_state',
  description: t('tools.tabNavigation.tabState.description'),
  parameters: {
    type: 'object',
    properties: {
      viewId: { type: 'string', description: t('tools.tabNavigation.tabState.params.viewId') },
      runId: { type: 'string', description: t('tools.tabNavigation.tabState.params.runId') },
      includeHistory: { type: 'boolean', description: t('tools.tabNavigation.tabState.params.includeHistory') }
    },
    required: ['viewId']
  },
  async execute(input: TabStateInput): Promise<TabStateOutput> {
    const crawlView = resolveCrawlViewAPI();
    if (!crawlView?.getNavigationState) {
      return buildError(ToolErrorCode.IPC_NOT_AVAILABLE, 'crawlView.getNavigationState unavailable') as TabStateOutput;
    }
    try {
      const state = await crawlView.getNavigationState(input.viewId, {
        includeHistory: input.includeHistory,
      });
      const runUpdatedAt = input.runId ? await resolveLastUpdatedAtFromRun(input.runId) : undefined;
      const viewUpdatedAt = resolveLastUpdatedAt(input.viewId);
      const lastUpdatedAt = runUpdatedAt ?? viewUpdatedAt;
      return standardizeLegacyResult({
        success: true,
        data: {
          ...state,
          ...(typeof lastUpdatedAt === 'number' ? { lastUpdatedAt } : {})
        }
      }) as TabStateOutput;
    } catch (error: any) {
      return buildError(ToolErrorCode.UNKNOWN_ERROR, error?.message || 'tab_state failed', {
        viewId: input.viewId
      }) as TabStateOutput;
    }
  }
};

export const navTabTool: AgentTool<NavTabInput, NavTabOutput> = {
  name: 'nav_tab',
  description: t('tools.tabNavigation.navTab.description'),
  parameters: {
    type: 'object',
    properties: {
      viewId: { type: 'string', description: t('tools.tabNavigation.navTab.params.viewId') },
      action: { type: 'string', enum: ['back', 'forward', 'reload', 'stop'] },
      ignoreCache: { type: 'boolean', description: t('tools.tabNavigation.navTab.params.ignoreCache') }
    },
    required: ['viewId', 'action']
  },
  async execute(input: NavTabInput): Promise<NavTabOutput> {
    const crawlView = resolveCrawlViewAPI();
    if (!crawlView) {
      return buildError(ToolErrorCode.IPC_NOT_AVAILABLE, 'crawlView API unavailable') as NavTabOutput;
    }
    try {
      switch (input.action) {
        case 'back': {
          const ok = await crawlView.goBack?.(input.viewId);
          if (ok === false) {
            return buildError(ToolErrorCode.INVALID_PARAMETER, 'cannot go back: no previous history entry', {
              viewId: input.viewId,
              action: input.action
            }) as NavTabOutput;
          }
          break;
        }
        case 'forward': {
          const ok = await crawlView.goForward?.(input.viewId);
          if (ok === false) {
            return buildError(ToolErrorCode.INVALID_PARAMETER, 'cannot go forward: no next history entry', {
              viewId: input.viewId,
              action: input.action
            }) as NavTabOutput;
          }
          break;
        }
        case 'reload':
          await crawlView.reload?.(Boolean(input.ignoreCache), input.viewId);
          break;
        case 'stop':
          await crawlView.stop?.(input.viewId);
          break;
        default:
          return buildError(ToolErrorCode.INVALID_PARAMETER, 'invalid action') as NavTabOutput;
      }

      // back / forward / reload 会触发新一轮加载：与 browser open 的 settled 契约对齐，
      // 等 DOM 稳定作为「内容就绪」信号再返回，避免紧接的 extract/observe/capture 读到旧页或半成品。
      // stop 语义是中止加载，不做就绪等待。best-effort：readiness 仅供参考，不因 settle 未达成而失败。
      let readiness: unknown;
      if (input.action !== 'stop' && crawlView.waitForTabReady) {
        readiness = await crawlView.waitForTabReady(input.viewId);
      }
      return standardizeLegacyResult({
        success: true,
        ...(readiness ? { data: { readiness } } : {})
      }) as NavTabOutput;
    } catch (error: any) {
      return buildError(ToolErrorCode.UNKNOWN_ERROR, error?.message || 'nav_tab failed', {
        viewId: input.viewId,
        action: input.action
      }) as NavTabOutput;
    }
  }
};

export const loadTabUrlTool: AgentTool<LoadTabUrlInput, LoadTabUrlOutput> = {
  name: 'load_tab_url',
  description: t('tools.tabNavigation.loadTabUrl.description'),
  parameters: {
    type: 'object',
    properties: {
      viewId: { type: 'string', description: t('tools.tabNavigation.loadTabUrl.params.viewId') },
      url: { type: 'string', description: t('tools.tabNavigation.loadTabUrl.params.url') },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'settled'] },
      timeout: { type: 'number' },
      waitForSelector: { type: 'string' },
      waitForTimeout: { type: 'number' },
      waitForState: { type: 'string', enum: ['attached', 'visible', 'hidden'] }
    },
    required: ['viewId', 'url']
  },
  async execute(input: LoadTabUrlInput): Promise<LoadTabUrlOutput> {
    const crawlView = resolveCrawlViewAPI();
    if (!crawlView?.loadUrl) {
      return buildError(ToolErrorCode.IPC_NOT_AVAILABLE, 'crawlView.loadUrl unavailable') as LoadTabUrlOutput;
    }
    try {
      const result = await crawlView.loadUrl(input.viewId, input.url, {
        waitUntil: input.waitUntil,
        timeout: input.timeout,
        waitForSelector: input.waitForSelector,
        waitForTimeout: input.waitForTimeout,
        waitForState: input.waitForState,
        ...(input.localPreviewRoot ? { localPreviewRoot: input.localPreviewRoot } : {}),
      });
      if (!result?.success) {
        const status = result?.status;
        const message = result?.error || 'load_tab_url failed';
        const errorCode =
          status === 'timeout' || message.toLowerCase().includes('timeout')
            ? ToolErrorCode.TIMEOUT
            : ToolErrorCode.UNKNOWN_ERROR;
        return buildError(errorCode, message, {
          viewId: input.viewId,
          url: input.url
        }) as LoadTabUrlOutput;
      }
      return standardizeLegacyResult({
        success: true,
        data: {
          status: result?.status,
          finalUrl: result?.finalUrl,
          timing: result?.timing,
          ...(result?.readiness ? { readiness: result.readiness } : {})
        }
      }) as LoadTabUrlOutput;
    } catch (error: any) {
      return buildError(ToolErrorCode.UNKNOWN_ERROR, error?.message || 'load_tab_url failed', {
        viewId: input.viewId,
        url: input.url
      }) as LoadTabUrlOutput;
    }
  }
};

export const waitForTool: AgentTool<WaitForInput, WaitForOutput> = {
  name: 'wait_for',
  description: t('tools.tabNavigation.waitFor.description'),
  parameters: {
    type: 'object',
    properties: {
      viewId: { type: 'string', description: t('tools.tabNavigation.waitFor.params.viewId') },
      selector: { type: 'string' },
      state: { type: 'string', enum: ['attached', 'visible', 'hidden'] },
      timeout: { type: 'number' },
      delay: { type: 'number' },
      pollInterval: { type: 'number' }
    },
    required: ['viewId']
  },
  async execute(input: WaitForInput): Promise<WaitForOutput> {
    const crawlView = resolveCrawlViewAPI();
    if (!crawlView?.waitForSelector) {
      return buildError(ToolErrorCode.IPC_NOT_AVAILABLE, 'crawlView.waitForSelector unavailable') as WaitForOutput;
    }
    try {
      const result = await crawlView.waitForSelector(input.viewId, {
        selector: input.selector,
        state: input.state,
        timeout: input.timeout,
        delay: input.delay,
        pollInterval: input.pollInterval
      });
      if (!result?.success) {
        const message = result?.error || 'wait_for failed';
        const lower = message.toLowerCase();
        const errorCode = lower.includes('mutually exclusive') || lower.includes('selector is required')
          ? ToolErrorCode.INVALID_PARAMETER
          : lower.includes('timeout')
            ? ToolErrorCode.TIMEOUT
            : ToolErrorCode.UNKNOWN_ERROR;
        return buildError(errorCode, message, {
          viewId: input.viewId,
          selector: input.selector
        }) as WaitForOutput;
      }
      return standardizeLegacyResult({
        success: true,
        data: { elapsedMs: result?.elapsedMs }
      }) as WaitForOutput;
    } catch (error: any) {
      return buildError(ToolErrorCode.UNKNOWN_ERROR, error?.message || 'wait_for failed', {
        viewId: input.viewId,
        selector: input.selector
      }) as WaitForOutput;
    }
  }
};

export const tabNavigationTools = [
  getTabsTool,
  tabStateTool,
  navTabTool,
  loadTabUrlTool,
  waitForTool
];
