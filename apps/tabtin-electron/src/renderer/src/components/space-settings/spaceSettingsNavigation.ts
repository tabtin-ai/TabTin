import { contextRegistry } from '@components/context-space/registry';
import { expandCanvasForScope } from '@/services/openResourceLink';
import { useMainNavStore } from '@stores/useMainNavStore';
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore';
import { useSpaceListStore } from '@stores/useSpaceListStore';
import { getSpaceSettingsTitle } from './settingsTitle';

export interface OpenSpaceSettingsIntentOptions {
  activateWorkspaceSelection?: boolean;
  section?: string;
  /**
   * 当前工作台的 tab scope key（workspaceContext.key，形如 `desktop:…` / `conversation:…`）。
   * tab 实际渲染按该 scope 取，**必须**传入当前可见 scope，否则 tab 会落到不可见的
   * 兜底 spaceId scope（表现为「点了没反应」）。仅在脱离工作台、无 scope 可知时省略。
   */
  tabScopeKey?: string | null;
}

/**
 * 统一打开某个 space 的 settings tab。
 *
 * - workspace 入口可选先对齐 selection，确保设置页在当前工作台可见
 * - group / conversation 入口可直接打开关联 space 的 settings tab
 * - 若 handler 尚未注册，回退到 tabs store 直接打开
 */
export function openSpaceSettingsIntent(
  spaceId: string | null | undefined,
  options: OpenSpaceSettingsIntentOptions = {},
): boolean {
  if (!spaceId) return false;

  if (options.activateWorkspaceSelection) {
    useSpaceListStore.getState().selectSpaceById('workspace', spaceId);
    // closeMemo 不再切 tab；对齐 workspace selection 时须显式回任务域
    useMainNavStore.getState().setCurrentTab('agent');
  }

  const meta = options.section
    ? { spaceId, section: options.section }
    : { spaceId };
  const title = getSpaceSettingsTitle(spaceId);
  // scope 优先用传入的当前工作台 key；缺省退回 spaceId（仅适用于本身按 spaceId 取 tab 的场景）。
  const scopeKey = options.tabScopeKey ?? spaceId;
  const item = {
    type: 'tabsettings' as const,
    id: spaceId,
    tabKey: contextRegistry.buildTabKey('tabsettings', spaceId),
    title,
    meta,
  };

  const handled = contextRegistry.dispatchSelect(item, {
    spaceId,
    tabScopeKey: scopeKey,
    closeBrowserView: () => {},
  });

  if (!handled) {
    useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
      type: 'tabsettings',
      id: spaceId,
      title,
      meta,
    });
  }

  expandCanvasForScope(scopeKey);

  return true;
}
