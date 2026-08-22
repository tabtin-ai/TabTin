import { ToolErrorCode } from '../types/errors';
import type { TabInfo } from '../tools/tab-navigation';
import {
  resolveRunSessionAPI,
  resolveViewFactoryAPI,
  resolveOrganizationTabManagerAPI,
  resolveViewStateRegistryAPI
} from './runtime-bridge';
import { t } from '../i18n';

type BridgeResult = { tabs: TabInfo[]; error?: string; error_code?: ToolErrorCode };


export function resolveLastUpdatedAt(viewId: string): number | undefined {
  const registry = resolveViewStateRegistryAPI();
  const state = registry?.getState?.(viewId);
  const lastUpdated = state?.lastAccessTime || state?.lastLoadTime;
  return typeof lastUpdated === 'number' ? lastUpdated : undefined;
}

function applyViewState(tab: TabInfo, viewState: any): void {
  if (!viewState) return;
  if (!tab.url && typeof viewState.url === 'string') {
    tab.url = viewState.url;
  }
  if (!tab.title && viewState.view?.webContents?.getTitle) {
    const title = viewState.view.webContents.getTitle();
    if (title) tab.title = title;
  }
  const metadata = viewState.config?.metadata || {};
  if (!tab.crawlspaceId && metadata.crawlspaceId) {
    tab.crawlspaceId = metadata.crawlspaceId;
  }
  if (!tab.kind && metadata.kind) {
    tab.kind = metadata.kind;
  }
  if (typeof tab.isPreview === 'undefined' && typeof metadata.isPreview === 'boolean') {
    tab.isPreview = metadata.isPreview;
  }
}

function applyViewMetadata(tab: TabInfo, metadata: any): void {
  if (!metadata) return;
  if (!tab.title && metadata.title) tab.title = metadata.title;
  if (!tab.url && metadata.url) tab.url = metadata.url;
  if (!tab.favicon && metadata.favicon) tab.favicon = metadata.favicon;
  if (!tab.createdAt && metadata.createdAt) tab.createdAt = metadata.createdAt;
}

export async function bridgeViewsFromRun(runId: string): Promise<BridgeResult> {
  const runSession = resolveRunSessionAPI();
  if (!runSession?.get) {
    return { tabs: [], error: t('errors.ipcNotAvailable'), error_code: ToolErrorCode.IPC_NOT_AVAILABLE };
  }
  const run = await runSession.get(runId);
  if (!run) {
    return { tabs: [], error: t('errors.runNotFound'), error_code: ToolErrorCode.RUN_NOT_FOUND };
  }

  const viewFactory = resolveViewFactoryAPI();
  const tabs: TabInfo[] = (run.views || []).map((view: any) => {
    const tab: TabInfo = {
      viewId: view.viewId,
      id: view.viewId,
      runId,
      createdAt: view.createdAt,
      isActive: run.activeViewId === view.viewId
    };
    if (view.metadata) {
      applyViewMetadata(tab, view.metadata);
    }
    if (viewFactory) {
      const viewState = viewFactory.getViewState?.(view.viewId);
      applyViewState(tab, viewState);
    }
    if (run.updatedAt || run.lastEventAt) {
      tab.lastUpdatedAt = run.updatedAt || run.lastEventAt;
    }
    return tab;
  });

  return { tabs };
}

export async function resolveLastUpdatedAtFromRun(runId: string): Promise<number | undefined> {
  const runSession = resolveRunSessionAPI();
  if (!runSession?.get) return undefined;
  try {
    const run = await runSession.get(runId);
    const lastUpdated = run?.updatedAt || run?.lastEventAt;
    return typeof lastUpdated === 'number' ? lastUpdated : undefined;
  } catch {
    return undefined;
  }
}

export function bridgeViewsFromCrawlspace(crawlspaceId: string): BridgeResult {
  const workspace = resolveOrganizationTabManagerAPI();
  if (!workspace) {
    return { tabs: [], error: t('errors.ipcNotAvailable'), error_code: ToolErrorCode.IPC_NOT_AVAILABLE };
  }
  const viewIds = workspace.getViewsByTab?.(crawlspaceId) ?? [];
  if (!viewIds.length) {
    return { tabs: [], error: t('errors.crawlspaceNoViews'), error_code: ToolErrorCode.TAB_NOT_FOUND };
  }

  const viewFactory = resolveViewFactoryAPI();
  const registry = resolveViewStateRegistryAPI();
  const tabs: TabInfo[] = viewIds.map((viewId: string) => {
    const tab: TabInfo = {
      viewId,
      id: viewId,
      crawlspaceId
    };
    const meta = workspace.getViewMetadata?.(viewId);
    applyViewMetadata(tab, meta);
    if (viewFactory) {
      const viewState = viewFactory.getViewState?.(viewId);
      applyViewState(tab, viewState);
    }
    if (registry) {
      const state = registry.getState?.(viewId);
      if (state?.lastAccessTime || state?.lastLoadTime) {
        tab.lastUpdatedAt = state.lastAccessTime || state.lastLoadTime;
      }
    }
    return tab;
  });

  return { tabs };
}
