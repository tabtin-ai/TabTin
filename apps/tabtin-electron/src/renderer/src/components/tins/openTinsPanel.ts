import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { TINS_UI_ENABLED } from '@/utils/featureFlags'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'

export function openTinsPanel(spaceId: string): void {
  if (!TINS_UI_ENABLED) return

  const { openResourceTab } = useSpaceContextTabsStore.getState()
  openResourceTab(resolveForegroundTabScopeKey(spaceId), {
    type: 'tins',
    id: `tins-${spaceId}`,
    title: 'Tins',
    meta: { spaceId },
  })
}
