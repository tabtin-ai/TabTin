import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { getAgentWorkspaceDefaults } from '@/crawlspace/workspace-defaults'
import { activateBrowserView } from '@/services/browserViewActivation'
import { seedManager } from '@stores/seed-manager'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { buildOrganizationBrowserPartition } from '@shared/types/browser-env'

export interface LoginRelayWorkbenchHandle {
  crawlspaceId: string
  viewId: string
  tabScopeKey: string
  tabKey: string
}

interface OpenLoginRelayWorkbenchTabInput {
  /** 仅用于承载右侧标签，不代表远端执行空间。 */
  tabScopeKey: string
  relayId: string
  organizationId: string
  partition: string
  loginUrl: string
  domain: string
}

export type OpenLoginRelayWorkbenchTabResult =
  | { ok: true; handle: LoginRelayWorkbenchHandle }
  | { ok: false; error: string }

function isMatchingOrganizationEnvironment(input: OpenLoginRelayWorkbenchTabInput): boolean {
  if (input.partition !== `persist:${buildOrganizationBrowserPartition(input.organizationId)}`) return false
  try {
    const url = new URL(input.loginUrl)
    return url.protocol === 'https:'
      && (url.hostname === input.domain || url.hostname.endsWith(`.${input.domain}`))
  } catch {
    return false
  }
}

export async function openLoginRelayWorkbenchTab(
  input: OpenLoginRelayWorkbenchTabInput,
): Promise<OpenLoginRelayWorkbenchTabResult> {
  if (!isMatchingOrganizationEnvironment(input)) {
    return { ok: false, error: '登录页面无效' }
  }

  const crawlspaceId = `cs-login-relay-${input.relayId}`
  const viewId = `view-login-relay-${input.relayId}`
  const tabKey = `login_relay:${viewId}`
  const tabScopeKey = input.tabScopeKey
  const title = `登录 ${input.domain}`
  const defaults = getAgentWorkspaceDefaults()
  const crawlStore = useCrawlTabStore.getState()

  try {
    crawlStore.createWorkspace({
      crawlspaceId,
      profile: defaults.profile,
      runPrefix: defaults.runPrefix,
      uiConfig: { ...defaults.uiConfig, defaultTitle: title },
      pluginConfig: {},
      partition: input.partition,
    })

    const adapter = createElectronIpcAdapter(crawlspaceId)
    const created = await adapter.createView(viewId, input.loginUrl, undefined, title)
    if (!created) {
      await crawlStore.closeCrawlspace(
        crawlspaceId,
        'login-relay-open-failed',
        { reason: 'login-relay-open-failed' },
      )
      return { ok: false, error: '无法打开登录页面' }
    }

    seedManager.ensureSeed(crawlspaceId, {
      viewId,
      url: input.loginUrl,
      title,
    })
    useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
      type: 'login_relay',
      id: viewId,
      title,
      meta: {
        url: input.loginUrl,
        crawlspaceId,
        kind: 'login_relay',
      },
      silent: true,
    })
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(tabScopeKey, false)

    const activation = await activateBrowserView(crawlspaceId, viewId, {
      fallbackView: { viewId, url: input.loginUrl, title },
      selection: { tabScopeKey, tabKey },
    })
    if (!activation.ok || activation.code === 'cancelled') {
      await closeLoginRelayWorkbenchTab({ crawlspaceId, viewId, tabScopeKey, tabKey })
      return {
        ok: false,
        error: !activation.ok
          ? activation.message || '无法激活登录页面'
          : '登录页面已取消',
      }
    }

    return {
      ok: true,
      handle: { crawlspaceId, viewId, tabScopeKey, tabKey },
    }
  } catch (error) {
    await crawlStore.closeCrawlspace(
      crawlspaceId,
      'login-relay-open-failed',
      { reason: 'login-relay-open-failed' },
    )
    return {
      ok: false,
      error: error instanceof Error ? error.message : '无法打开登录页面',
    }
  }
}

export async function closeLoginRelayWorkbenchTab(
  handle: LoginRelayWorkbenchHandle,
): Promise<void> {
  useSpaceContextTabsStore.getState().closeTab(handle.tabScopeKey, handle.tabKey)
  await useCrawlTabStore.getState().closeCrawlspace(
    handle.crawlspaceId,
    'login-relay-finished',
    { reason: 'login-relay-finished' },
  )
}
