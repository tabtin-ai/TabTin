/** @store-category ui */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared';
import {
  DEFAULT_SETTINGS_ROUTES,
  type SettingsRoute,
  type SettingsRouteInput,
  type SettingsRouteByCategory,
  normalizeSettingsRoute,
} from '@/settings/settingsRoutes';
import { getRuntime } from '@tabtin/app-shell';
import { useOrganizationStore } from './useOrganizationStore';
import { useMainNavStore } from './useMainNavStore';
import { emitNavigate } from './viewNavigation';
import { PERSIST_KEYS } from './persist-key-registry';

function fillOrganizationId(route: SettingsRouteInput): SettingsRoute {
  if (route.category !== 'organization') return route;
  if (route.organizationId && route.organizationId !== '__unresolved__') {
    return { ...route, organizationId: route.organizationId };
  }
  const { selectedOrganization, organizations } = useOrganizationStore.getState();
  const fallback = selectedOrganization
    ?? organizations.find(w => w.type === 'personal')
    ?? organizations[0];
  return { ...route, organizationId: fallback?.id ?? '' };
}

type DirtyChecker = () => boolean;

interface SettingsSpaceState {
  isOpen: boolean;
  activeRoute: SettingsRoute | null;
  lastRouteByCategory: SettingsRouteByCategory;
  openSettings: (route?: SettingsRouteInput | string) => void;
  closeSettings: () => void;
  setRoute: (route: SettingsRouteInput) => void;
  /** 面板注册脏检测函数；返回注销函数 */
  registerDirtyChecker: (checker: DirtyChecker) => () => void;
  /** 检查当前面板是否有未保存变更 */
  isDirty: () => boolean;
  /** 待导航的目标路由（需用户确认后执行） */
  pendingRoute: SettingsRoute | null;
  /** 确认放弃未保存变更，执行待导航 */
  confirmDiscard: () => void;
  /** 取消待导航 */
  cancelPendingRoute: () => void;
}

interface SettingsSpacePersistedState {
  isOpen?: boolean;
  activeRoute?: SettingsRoute | null;
  lastRouteByCategory?: Partial<SettingsRouteByCategory>;
}

const dirtyCheckers = new Set<DirtyChecker>();

function applyRoute(nextRoute: SettingsRoute, set: (fn: (state: SettingsSpaceState) => Partial<SettingsSpaceState>) => void) {
  set((state) => ({
    isOpen: true,
    activeRoute: nextRoute,
    pendingRoute: null,
    lastRouteByCategory: {
      ...state.lastRouteByCategory,
      [nextRoute.category]:
        nextRoute as SettingsRouteByCategory[typeof nextRoute.category],
    },
  }));
}

function restoreSettingsRoute(route: unknown): SettingsRoute | null {
  if (!route || typeof route !== 'object') return null;
  const category = (route as { category?: unknown }).category;
  if (category !== 'profile' && category !== 'organization' && category !== 'device') {
    return null;
  }
  return fillOrganizationId(normalizeSettingsRoute(route as SettingsRouteInput));
}

function restoreLastRouteByCategory(
  persisted: SettingsSpacePersistedState['lastRouteByCategory'],
): SettingsRouteByCategory {
  const restored: SettingsRouteByCategory = { ...DEFAULT_SETTINGS_ROUTES };
  for (const category of ['profile', 'organization', 'device'] as const) {
    const route = restoreSettingsRoute(persisted?.[category]);
    if (route?.category === 'profile' && category === 'profile') restored.profile = route;
    if (route?.category === 'organization' && category === 'organization') restored.organization = route;
    if (route?.category === 'device' && category === 'device') restored.device = route;
  }
  return restored;
}

function keepSettingsVisible(): void {
  const settings = useSettingsSpaceStore.getState();
  if (!settings.isOpen || !settings.activeRoute) return;
  if (useMainNavStore.getState().currentTab !== 'me') {
    useMainNavStore.getState().setCurrentTab('me');
  }
}

export const useSettingsSpaceStore = create<SettingsSpaceState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      activeRoute: null,
      lastRouteByCategory: { ...DEFAULT_SETTINGS_ROUTES },
      pendingRoute: null,

      registerDirtyChecker: (checker) => {
        dirtyCheckers.add(checker);
        return () => { dirtyCheckers.delete(checker); };
      },

      isDirty: () => {
        for (const checker of dirtyCheckers) {
          if (checker()) return true;
        }
        return false;
      },

      // openSettings 现在重定向到「我的」tab——所有十几处现有调用方
      // （NotificationBell / BillingErrorCard / notificationNavigation 等）代码
      // 无需修改，自动接到新 IA：切到 me tab + 设置 activeRoute，主画布的
      // SettingsSpace 会按 activeRoute 渲染对应 panel。
      //
      // isOpen 字段保留向后兼容（仍被 SettingsSpace 内部某些逻辑读到），
      // 但不再由 AppLayout 用来切布局——layout 改用 mainNavTab='me' 判定。
      openSettings: (route) => {
        // 分身 / 技能库已迁到任务侧栏；旧设置深链改开对应工作台。
        if (
          route === 'agents'
          || (typeof route === 'object'
            && route?.category === 'profile'
            && route.section === 'myAgents')
        ) {
          void import('@/services/agentMemoryNavigation')
            .then((m) => { m.openAgentHub() })
          return
        }
        if (
          route === 'skills'
          || (typeof route === 'object'
            && route?.category === 'profile'
            && route.section === 'skillLibrary')
        ) {
          void import('@/services/agentMemoryNavigation')
            .then((m) => { m.openSkillLibrary() })
          return
        }
        emitNavigate('settings');
        getRuntime().bridge.closeAuxiliaryPanels?.();
        const nextRoute = fillOrganizationId(normalizeSettingsRoute(route));
        applyRoute(nextRoute, set);
        // 切到「我的」tab——SidebarMePanel 高亮选中项、ContentArea 渲染对应 panel
        useMainNavStore.getState().setCurrentTab('me');
      },

      closeSettings: () => {
        dirtyCheckers.clear();
        set({ isOpen: false, pendingRoute: null });
        // 关闭=回到默认 'agent' tab（如果当前在 me 上才切，避免覆盖用户主动切的其他 tab）
        if (useMainNavStore.getState().currentTab === 'me') {
          useMainNavStore.getState().setCurrentTab('agent');
        }
      },

      setRoute: (route) => {
        const nextRoute = fillOrganizationId(normalizeSettingsRoute(route));
        if (get().isDirty()) {
          set({ pendingRoute: nextRoute });
          return;
        }
        dirtyCheckers.clear();
        applyRoute(nextRoute, set);
      },

      confirmDiscard: () => {
        const pending = get().pendingRoute;
        dirtyCheckers.clear();
        if (pending) {
          applyRoute(pending, set);
        }
      },

      cancelPendingRoute: () => {
        set({ pendingRoute: null });
      },
    }),
    withPersistSafety<SettingsSpaceState, SettingsSpacePersistedState>({
      name: PERSIST_KEYS.settingsSpace,
      version: 1,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, [])),
      partialize: (state) => ({
        isOpen: state.isOpen,
        activeRoute: state.activeRoute,
        lastRouteByCategory: state.lastRouteByCategory,
      }),
      merge: (persisted, currentState) => {
        const state = (persisted ?? {}) as SettingsSpacePersistedState;
        const activeRoute = restoreSettingsRoute(state.activeRoute);
        return {
          ...currentState,
          isOpen: Boolean(state.isOpen && activeRoute),
          activeRoute,
          lastRouteByCategory: restoreLastRouteByCategory(state.lastRouteByCategory),
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state?.isOpen || !state.activeRoute) return;
        queueMicrotask(keepSettingsVisible);
      },
    }),
  ),
);

// 设置页打开中时由 settings route 持有主画布：后台 space 导航、启动期默认
// agent tab 恢复等都不应把用户从设置页打回首页。真正退出设置走
// closeSettings（如 ActivityRail 切到其他入口），会先把 isOpen 置 false，再切回 agent。
useMainNavStore.subscribe((state, prev) => {
  if (state.currentTab === prev.currentTab) return;
  if (prev.currentTab === 'me' && state.currentTab !== 'me') {
    const settings = useSettingsSpaceStore.getState();
    if (settings.isOpen && settings.activeRoute) {
      queueMicrotask(keepSettingsVisible);
    }
  }
});

// 左下角全局团队切换器只更新 selectedOrganization；设置页团队路由本身
// 持有 organizationId，所以设置页打开时必须跟随全局团队上下文更新。
useOrganizationStore.subscribe((state, prev) => {
  const nextOrganizationId = state.selectedOrganization?.id ?? null;
  const prevOrganizationId = prev.selectedOrganization?.id ?? null;
  if (!nextOrganizationId || nextOrganizationId === prevOrganizationId) return;

  const settings = useSettingsSpaceStore.getState();
  const route = settings.activeRoute;
  if (!settings.isOpen || route?.category !== 'organization' || route.organizationId === nextOrganizationId) {
    return;
  }

  settings.setRoute({
    category: 'organization',
    section: route.section,
    organizationId: nextOrganizationId,
  });
});
