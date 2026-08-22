import { resolveAppHomeTabModel } from '@components/context-space/registry/resolveUtils'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useBrowserPrefsStore } from '@stores/useBrowserPrefsStore'
import { normalizeBrowserAddressInput } from '@/utils/browserAddressInput'
import { openWebTabInSpace } from '@/services/openWebTabInSpace'

export type OpenBrowserHomeResult =
  | {
      ok: true
      target: 'custom_home'
      url: string
      viewId: string
      tabKey: string
    }
  | {
      ok: true
      target: 'tabweb_home'
      tabKey: 'apphome:tabweb'
    }
  | {
      ok: false
      error: string
    }

/**
 * 打开用户的浏览器入口：有自定义主页时新开网页标签；未配置时回到 TabWeb 工作区。
 *
 * 该动作是 Renderer 的唯一决策点，因为浏览器偏好和工作台标签状态都只在这里可靠可用。
 */
export async function openBrowserHomeInSpace(
  spaceId: string,
  options?: { tabScopeKey?: string | null },
): Promise<OpenBrowserHomeResult> {
  if (!spaceId) return { ok: false, error: 'spaceId is required' }

  const scopeKey = options?.tabScopeKey || spaceId
  const prefs = useBrowserPrefsStore.getState()
  const homepage = prefs.homepageUrl.trim()

  if (homepage) {
    const url = normalizeBrowserAddressInput(homepage, prefs.searchEngine)
    const result = await openWebTabInSpace(spaceId, url, { tabScopeKey: scopeKey })
    if (!result.ok) return result
    return {
      ok: true,
      target: 'custom_home',
      url,
      viewId: result.viewId,
      tabKey: `tabweb:${result.viewId}`,
    }
  }

  const model = resolveAppHomeTabModel('tabweb')
  useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
    type: 'apphome',
    id: 'tabweb',
    title: model.title,
    meta: {
      spaceId,
      appId: 'tabweb',
      labelKey: model.labelKey,
      displayLabel: model.displayLabel,
      displayEmoji: model.displayEmoji,
    },
  })
  return { ok: true, target: 'tabweb_home', tabKey: 'apphome:tabweb' }
}
