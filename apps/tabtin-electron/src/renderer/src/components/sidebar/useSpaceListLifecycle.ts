import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore';
import { useDeviceStore } from '@stores/useDeviceStore';
import { useIMStore } from '@stores/useIMStore';
import { useSpaceListStore } from '@stores/useSpaceListStore';
import { useSpaceStore } from '@stores/useSpaceStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { AgentApiService, getRuntime } from '@tabtin/app-shell';
import { getChatClient } from '@/services/chatApi';
import { recoverFromInvalidOrganizationAccess } from '@/services/membershipEventHandler';
import {
  isOrganizationAccessBlockedFor,
  useWsConnectionStore,
} from '@/stores/useWsConnectionStore';
import { reconnectGatewayIfOrganizationNotSynced } from '@/hooks/useConnectionRecovery';
import { onForegroundOrganizationChanged } from '@stores/useBackgroundEventStore';
import { dismissOrgScopedTransientUi } from '@/services/dismissOrgScopedTransientUi';
import { createLogger } from '@/utils/logger';
import { ensureLocalWorkspaceForOrganization } from './ensureLocalWorkspace';

const log = createLogger('SpaceListLifecycle');

/**
 * 冷启动成员补水：persist 只恢复 selectedOrganization，不恢复 members。
 * 会话内只尝试一次，避免与显式 selectOrganization / 手动切组织重复请求；
 * 用 module-level Set 扛住 React StrictMode 重挂载。
 *
 */
const coldStartMemberHydrationSessions = new Set<string>();

/**
 * ：每次打开应用 / 切到某 org 时，对该 org 触发一次 listAgents，
 * 服务端缺失默认 Agent 时补建；已有时纯读（不再借列表热路径做 skill repair）。
 */
const defaultAgentSkillRefreshSessions = new Set<string>();

/** @internal 单测重置会话级补水标记 */
export function __resetColdStartMemberHydrationForTests(): void {
  coldStartMemberHydrationSessions.clear();
  defaultAgentSkillRefreshSessions.clear();
}

interface UseSpaceListLifecycleResult {
  reloadSpaceListData: () => Promise<void>;
  isInitialAgentDataLoading: boolean;
}

export function useSpaceListLifecycle(): UseSpaceListLifecycleResult {
  const prevOrganizationIdRef = useRef<string | null>(null);
  const [hasLoadedOrganizationList, setHasLoadedOrganizationList] = useState(() => {
    const { organizations, selectedOrganization } = useOrganizationStore.getState();
    return !!selectedOrganization
      && organizations.some((organization) => organization.id === selectedOrganization.id);
  });
  const [hasLoadedSpaceListData, setHasLoadedSpaceListData] = useState(false);
  // 按 organization 记录 spaces 是否已完成至少一次加载。
  // 全局 hasLoadedSpaceListData 在首轮成功后会一直为 true；切到「刚创建、尚未灌入
  // spaces」的新组织时若仍用它当门控，会误判为空 → 闪 Welcome 中间页 / 双写默认
  // 工作空间。
  const [loadedSpaceOrganizationIds, setLoadedSpaceOrganizationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const organizationAccessRecoveryInFlight = useWsConnectionStore(
    (state) => state.organizationAccessRecoveryInFlight,
  );

  const organizations = useOrganizationStore((state) => state.organizations);
  const loadOrganizations = useOrganizationStore((state) => state.loadOrganizations);
  const selectedOrganizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  );
  const isSelectedOrganizationAccessBlocked = useWsConnectionStore((state) =>
    isOrganizationAccessBlockedFor(
      state.organizationAccessBlocked,
      state.organizationAccessBlockedId,
      selectedOrganizationId,
    ),
  );
  const getEffectiveOrganization = useOrganizationStore(
    (state) => state.getEffectiveOrganization,
  );
  const selectOrganization = useOrganizationStore((state) => state.selectOrganization);
  const refreshOrganizationAccess = useOrganizationStore(
    (state) => state.refreshOrganizationAccess,
  );
  const isAuthenticated = useAuthStore(selectIsAuthenticated);

  const spaces = useSpaceStore((state) => state.spaces);
  const isLoadingSpaces = useSpaceStore((state) => state.isLoading);
  const spaceError = useSpaceStore((state) => state.error);
  const spaceLoadErrorByOrganizationId = useSpaceStore(
    (state) => state.loadErrorByOrganizationId,
  );
  const loadAllOrganizationSpaces = useSpaceStore(
    (state) => state.loadAllOrganizationSpaces,
  );

  const conversations = useIMStore((state) => state.conversations);
  const isLoadingConversations = useIMStore(
    (state) => state.isLoadingConversations,
  );
  const imLoadError = useIMStore((state) => state.loadError);

  const currentDeviceId = useDeviceStore(
    (state) => state.currentDevice?.id ?? null,
  );
  const registerCurrentDevice = useDeviceStore(
    (state) => state.registerCurrentDevice,
  );
  const loadDevices = useDeviceStore((state) => state.loadDevices);
  const initGlobalWsListener = useDeviceStore(
    (state) => state.initGlobalWsListener,
  );

  const selectedSpaceId = useSpaceListStore((state) => state.selectedSpaceId);
  const selectedSpaceKind = useSpaceListStore(
    (state) => state.selectedSpaceKind,
  );
  const handleOrganizationChange = useSpaceListStore(
    (state) => state.handleOrganizationChange,
  );
  const ensureActiveSelection = useSpaceListStore(
    (state) => state.ensureActiveSelection,
  );

  const organizationIds = useMemo(
    () => organizations.map((wt) => wt.id),
    [organizations],
  );

  const initialDeviceRegisteredRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setHasLoadedOrganizationList(false);
      return;
    }

    let cancelled = false;
    const { organizations: cachedOrganizations, selectedOrganization } =
      useOrganizationStore.getState();
    const hasCachedOrganizationContext = !!selectedOrganization
      && cachedOrganizations.some((organization) => organization.id === selectedOrganization.id);
    setHasLoadedOrganizationList(hasCachedOrganizationContext);
    void loadOrganizations().finally(() => {
      if (!cancelled) setHasLoadedOrganizationList(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, loadOrganizations]);

  useEffect(() => {
    if (!isAuthenticated || !hasLoadedOrganizationList || organizations.length === 0) return;
    const staleOrganizationId =
      selectedOrganizationId
      ?? useOrganizationStore.getState().lastOpenedOrganizationId;
    if (!staleOrganizationId) return;
    if (organizationIds.includes(staleOrganizationId)) return;
    void recoverFromInvalidOrganizationAccess(staleOrganizationId);
  }, [
    hasLoadedOrganizationList,
    isAuthenticated,
    organizationIds,
    selectedOrganizationId,
  ]);

  useEffect(() => {
    if (!isAuthenticated || organizations.length === 0 || selectedOrganizationId) return;
    const effectiveOrganization = getEffectiveOrganization();
    if (!effectiveOrganization) return;
    void selectOrganization(effectiveOrganization);
  }, [
    getEffectiveOrganization,
    isAuthenticated,
    selectOrganization,
    selectedOrganizationId,
    organizations.length,
  ]);

  // 冷启动：persist 已恢复 selectedOrganization，但 members 未持久化且跳过了
  // selectOrganization → 人员字段/表单候选整进程为空。
  // 仅在「组织列表首轮就绪 + 已有选中组织」时补一次 refreshOrganizationAccess；
  // 无持久化选择时由上面的 selectOrganization 灌 members，不走本路径。
  useEffect(() => {
    if (!isAuthenticated) {
      coldStartMemberHydrationSessions.clear();
      defaultAgentSkillRefreshSessions.clear();
      return;
    }
    if (!hasLoadedOrganizationList) return;

    const { selectedOrganization, members } = useOrganizationStore.getState();
    const organizationId = selectedOrganization?.id;
    if (!organizationId) return;

    const sessionKey = 'cold-start';
    if (coldStartMemberHydrationSessions.has(sessionKey)) return;
    coldStartMemberHydrationSessions.add(sessionKey);

    if (members.length > 0) return;

    log.info('Cold-start members hydration', { organizationId });
    void refreshOrganizationAccess(organizationId);
  }, [
    hasLoadedOrganizationList,
    isAuthenticated,
    refreshOrganizationAccess,
  ]);

  // ：打开应用 / 切前台 org 时拉一次 Agent 列表，触发服务端默认 Agent 保障（缺失才写）。
  // 仅成功后记入 session Set；失败释放 key，同会话可重试。
  useEffect(() => {
    if (!isAuthenticated || !selectedOrganizationId) return;

    const sessionKey = selectedOrganizationId;
    if (defaultAgentSkillRefreshSessions.has(sessionKey)) return;
    defaultAgentSkillRefreshSessions.add(sessionKey);

    log.info('Ensure default agent via listAgents', { organizationId: selectedOrganizationId });
    void AgentApiService.listAgents(selectedOrganizationId)
      .catch((error) => {
        defaultAgentSkillRefreshSessions.delete(sessionKey);
        log.warn('Ensure default agent via listAgents failed', {
          organizationId: selectedOrganizationId,
          error,
        });
      });
  }, [isAuthenticated, selectedOrganizationId]);

  useEffect(() => {
    if (!selectedOrganizationId) return;
    getRuntime().bridge.setActiveSpace(null, null, selectedOrganizationId);
  }, [selectedOrganizationId]);

  const reloadSpaceListData = useCallback(async () => {
    if (organizationIds.length === 0) return;

    initGlobalWsListener();

    try {
      const gateway = getChatClient().getGateway()
      useSpaceStore.getState().initSpaceWsListener(gateway)
    } catch { /* gateway not ready yet */ }

    const effectiveOrganizationId = getEffectiveOrganization()?.id ?? organizationIds[0];
    const foregroundOrganizationId = selectedOrganizationId ?? effectiveOrganizationId;

    // TabChat 只加载当前 organization；后台 organization 切换为前台后再加载会话。
    if (foregroundOrganizationId) {
      void useIMStore.getState().loadConversations(foregroundOrganizationId);
    }

    // ：只在注册成功后置位一次性标记。失败时（resolve null）保留重试资格，
    // 后续退避重试由 useDeviceStore 内部调度，恢复时机由 ensureDeviceRegistered 补挂。
    const loadDevice = !initialDeviceRegisteredRef.current && effectiveOrganizationId
      ? registerCurrentDevice(effectiveOrganizationId)
          .then((device) => {
            if (device) {
              initialDeviceRegisteredRef.current = true;
            }
            loadDevices(effectiveOrganizationId);
          })
      : Promise.resolve();

    // 设备注册独立，不影响核心数据加载
    void loadDevice.catch(e => console.warn('[SpaceListLifecycle] Device registration failed:', e));

    // ：前台 organization 的 Workspace 决定首屏就绪；其余 organization
    // 在前台完成后后台补载，避免新组织被任一旧组织的慢请求拖住。
    await loadAllOrganizationSpaces([foregroundOrganizationId]);

    const foregroundLoadError =
      useSpaceStore.getState().loadErrorByOrganizationId[foregroundOrganizationId];
    if (!foregroundLoadError) {
      setLoadedSpaceOrganizationIds((loadedIds) => {
        const nextLoadedIds = new Set(loadedIds);
        nextLoadedIds.add(foregroundOrganizationId);
        return nextLoadedIds;
      });
    }

    const backgroundOrganizationIds = organizationIds.filter(
      (organizationId) => organizationId !== foregroundOrganizationId,
    );
    if (backgroundOrganizationIds.length > 0) {
      void loadAllOrganizationSpaces(backgroundOrganizationIds);
    }
  }, [
    organizationIds,
    initGlobalWsListener,
    getEffectiveOrganization,
    loadAllOrganizationSpaces,
    selectedOrganizationId,
    registerCurrentDevice,
    loadDevices,
  ]);

  useEffect(() => {
    const nextOrganizationId = selectedOrganizationId ?? null;
    const prevOrganizationId = prevOrganizationIdRef.current;
    const organizationChanged = prevOrganizationId !== nextOrganizationId;

    if (!organizationChanged) return;

    //  / ：切组织硬重置前台瞬时 UI（关 Dialog/浮层、清 scene），
    // 并清前台全局会话选中；必须在同帧 Space 选中切换之前。
    // 同 org TTL reselect 不会进此分支。仍不 reset chat/IM 跨 org 缓存桶（Wave 3）。
    dismissOrgScopedTransientUi({
      organizationId: nextOrganizationId,
      previousOrganizationId: prevOrganizationId,
    });

    // Wave 3: 切换 organization 是纯前端状态切换（类似浏览器标签页）。
    // 不清跨 org 的 chat 缓存桶与 per-Space 记忆；前台选中已在 dismiss 里清掉。
    // 完整 reset 仅在登出 / token 失效时由 sessionResetRegistry 驱动。
    if (nextOrganizationId || prevOrganizationId != null) {
      handleOrganizationChange(nextOrganizationId, {
        preferCurrentSelectionAsFallback: prevOrganizationId == null && !!nextOrganizationId,
      });
    }

    // Wave 4：补「切换 organization 时刷新新前台 conversations」(P6/R4-08 缓解)。
    // 详见 W4-F7 注释。
    if (nextOrganizationId) {
      void useIMStore.getState().loadConversations(nextOrganizationId);
      void reconnectGatewayIfOrganizationNotSynced(nextOrganizationId);
    }

    // 通知事件分桶：前台 organization 已切换，drain 新前台的背景队列，
    // 让 criticalEventNotifier 处理之前在背景的 stream 级事件（如审批等待）。
    if (prevOrganizationId !== nextOrganizationId) {
      onForegroundOrganizationChanged(prevOrganizationId, nextOrganizationId);
    }

    prevOrganizationIdRef.current = nextOrganizationId;
  }, [
    handleOrganizationChange,
    selectedOrganizationId,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      setHasLoadedSpaceListData(false);
      setLoadedSpaceOrganizationIds(new Set());
      return;
    }
    if (organizationIds.length === 0) return;

    let cancelled = false;
    // ：只用成功加载标 ready。`.finally` 在 listSpaces 失败时也会把组织标成已加载，
    // 而 spaces 冷启动不持久化 → 空列表被 ensureLocalWorkspace 当成「缺本机工作空间」
    // 去 createSpace，后端一旦可写就堆出一串「默认工作空间」。
    void reloadSpaceListData().then(() => {
      if (cancelled) return;
      setHasLoadedSpaceListData(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    isAuthenticated,
    reloadSpaceListData,
    organizationIds,
  ]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (organizationIds.length > 0) return;
    setHasLoadedSpaceListData(hasLoadedOrganizationList);
    setLoadedSpaceOrganizationIds(new Set());
  }, [hasLoadedOrganizationList, isAuthenticated, organizationIds.length]);

  const isSelectedOrganizationSpacesReady =
    !selectedOrganizationId || loadedSpaceOrganizationIds.has(selectedOrganizationId);
  const selectedOrganizationSpaceError = selectedOrganizationId
    ? spaceLoadErrorByOrganizationId[selectedOrganizationId] ?? null
    : null;

  useEffect(() => {
    if (!selectedOrganizationId) return;
    ensureActiveSelection();
  }, [
    conversations,
    imLoadError,
    isLoadingConversations,
    isLoadingSpaces,
    selectedSpaceId,
    selectedSpaceKind,
    selectedOrganizationId,
    spaceError,
    spaces,
    ensureActiveSelection,
  ]);

  // 网络恢复后，如果之前有加载失败，自动重试
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      if (!navigator.onLine) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const { lastLoadError: wtError } = useOrganizationStore.getState();
        const { error: spError } = useSpaceStore.getState();
        if (wtError || spError) {
          console.log('[SpaceListLifecycle] Network restored, retrying failed loads');
          if (wtError) void loadOrganizations();
          if (spError) void reloadSpaceListData();
        }
      }, 3000);
    };

    window.addEventListener('online', handler);
    return () => {
      window.removeEventListener('online', handler);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [loadOrganizations, reloadSpaceListData]);

  // 设备身份漂移兜底：当前 organization 内没有任何「本机可用 / 未绑定」workspace 时
  // （存量 Space 全钉在离线旧设备上，或一个 workspace 都没有），自动新建一个绑定本机的
  // workspace 并选中，让用户开箱即用。去重 / inflight / 失败重试护栏在 ensureLocalWorkspace
  // 模块内，此处只负责在「已登录 + 该 organization spaces 已成功加载 + 设备已注册」后触发。
  // 门控必须按当前 organization，不能用全局 hasLoadedSpaceListData——否则切到刚创建的
  // 新组织时会在 spaces 尚未 merge 前误判为空并双写默认 Workspace。
  // ：当前 organization 列表仍失败时禁止兜底创建；
  // 后台 organization 的加载失败不应阻断已就绪的前台 organization。
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!isSelectedOrganizationSpacesReady) return;
    if (selectedOrganizationSpaceError) return;
    if (!selectedOrganizationId || !currentDeviceId) return;
    void ensureLocalWorkspaceForOrganization(selectedOrganizationId);
  }, [
    isAuthenticated,
    isSelectedOrganizationSpacesReady,
    selectedOrganizationSpaceError,
    selectedOrganizationId,
    currentDeviceId,
    spaces,
  ]);

  return {
    reloadSpaceListData,
    isInitialAgentDataLoading: isAuthenticated && !isSelectedOrganizationAccessBlocked && (
      !hasLoadedOrganizationList ||
      !hasLoadedSpaceListData ||
      !isSelectedOrganizationSpacesReady ||
      organizationAccessRecoveryInFlight
    ),
  };
}
