import { useMemo } from 'react';
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore';
import { useSpaceStore } from '@stores/useSpaceStore';
import { useIMStore } from '@stores/useIMStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { useSpaceListStore } from '@stores/useSpaceListStore';
import { useMainNavStore } from '@stores/useMainNavStore';
import { parseSpaceSelectionId, type SpaceNavigationKind } from '@tabtin/app-shell';
import type { SpaceContext } from '@components/context-space/SpaceContextContainer';
import {
  resolveActiveShellContext,
  type ConversationWorkbenchKind,
} from './spaceSelectionState';
import { useProjectWorkspaceSelectionStore } from './projectWorkspaceSelectionStore';
import { useAppPageStore, type AppPageId } from '@/stores/useAppPageStore';
import { buildCloudDocsScopeKey } from './cloudDocsDomain';
import type { ShellSidePanelMode, WorkbenchMode } from './shellLayoutTypes';

export type { ShellSidePanelMode, WorkbenchMode } from './shellLayoutTypes';
export type WorkbenchPlaceholderKind = 'dm' | 'im-group';

interface ResolveShellLayoutStateInput {
  isMeTab: boolean;       // mainNavTab === 'me'——「我的」tab 选中
  isIMTab: boolean;
  isAgentsTab?: boolean;
  isCloudDocsTab: boolean;
  activeAppPage?: AppPageId | null;
  activeProjectId?: string | null;
  selectedSpaceKind: SpaceNavigationKind | null;
  selectedSpace: SpaceContext | null;
  isIMActive: boolean;
  conversationSpaceContext: SpaceContext | null;
  conversationKind: ConversationWorkbenchKind;
  /**
   * 是否已登录。未登录（访客 / 登出）态下整个 shell 必须回退到 welcome：
   * 不渲染任何 Space 工作台、不渲染右侧聊天 rail。默认 true 兼容只关心
   * 已登录布局逻辑的纯函数测试。
   *
   *  回归点：登出后内存里的 selectedSpace 在 store 重置完成前可能残留，
   * 若不在此门控，workbenchMode 会判定为 'space'、chatPanelEnabled=true，
   * 导致登录 / 邀请码界面右侧残留对话面板。
   */
  isAuthenticated?: boolean;
  /** IM 会话桌面的执行现场：会话所属组织下的默认工作空间。 */
  imExecutionSpace?: SpaceContext | null;
  /** 当前激活的 IM 会话，用于隔离该会话的标签现场；无执行工作空间时为 null。 */
  imConversationId?: string | null;
  /** Project 中由用户显式打开的 Task 执行会话；默认 Project 页面不挂载聊天栏。 */
  projectTaskSessionOpen?: boolean;
  organizationId?: string | null;
  userId?: string | null;
}

const GUEST_SHELL_LAYOUT_STATE: ShellLayoutState = {
  chatPanelEnabled: false,
  sidePanelMode: 'workspace',
  workbenchMode: 'welcome',
  workbenchSpaceContext: null,
  sidebarSpaceContext: null,
  placeholderKind: null,
  layoutScopeKey: 'welcome',
  imConversationId: null,
};

export interface ShellLayoutState {
  chatPanelEnabled: boolean;
  sidePanelMode: ShellSidePanelMode;
  workbenchMode: WorkbenchMode;
  /**
   * 主画布 / 聊天 rail / 画板偏好（sidebarMode / canvasCollapsed 等）依赖的 Space 上下文。
   *
   * **关键语义**：me tab 时**强制为 null**——设置是主导航维度，
   * 主画布渲染独立工作台（SettingsSpace），不应被 Space 的 layout 偏好反向影响。
   *
   * 历史回归点：见 AppLayout `effectiveCanvasCollapsed && workbenchSpaceContext`
   * 分支——这个分支只有在用户真的在 Space 工作台时才该触发；me tab 时此值
   * 必须是 null 让条件自动失效。
   */
  workbenchSpaceContext: SpaceContext | null;
  /**
   * 侧栏（SpaceSidebarGlobal）依赖的 Space 上下文，反映"用户当前关注的 Space"。
   *
   * 跟 `workbenchSpaceContext` 的区别：后者是"主画布的 Space 上下文"，
   * 这个是"侧栏视角的 Space 上下文"（永远反映用户当前关注的 Space）。
   */
  sidebarSpaceContext: SpaceContext | null;
  placeholderKind: WorkbenchPlaceholderKind | null;
  layoutScopeKey: string;
  /** 当前会话桌面的 IM 会话 id；非会话桌面为 null。 */
  imConversationId: string | null;
}

/** 只用得到 id/type 两个字段，spaces 传 useSpaceStore 的完整 Space[] 或测试用最小 fixture 都行。 */
type SelectableSpace = {
  id: string
  type?: string | null
}

/**
 * 解析"当前应该展示哪个 Space 的聊天上下文"（ 修复）。
 *
 * 团队 Space 导航（`ProjectWorkspacePanel.markTeamSpaceProjectNavigation`）只写
 * useSpaceListStore 的 selectedSpaceId/selectedSpaceKind，不走 useSpaceStore.selectSpace
 * （那条路径会把 team_space 当成执行根触发 bridge.setActiveSpace，语义上团队 Space
 * 的执行根应指向 owner 的个人 Space，不能直接拿团队 Space 自己去 hydrate working_dir）。
 * 所以 selectedSpaceKind==='team' 时不能信任 useSpaceStore.selectedSpace（切个人 Space
 * 时才会更新，团队 Space 切换后它还停在上一个个人 Space）——必须从 selectedSpaceId 解析
 * 出真正的团队 Space，否则下游 sidebarSpaceContext 会继续渲染上一个个人 Space 的会话。
 */
export function resolveEffectiveSelectedSpace<T extends SelectableSpace>(input: {
  selectedSpaceKind: SpaceNavigationKind | null
  selectedSpace: T | null
  selectedSpaceIdComposite: string | null
  spaces: T[]
}): T | null {
  const { selectedSpaceKind, selectedSpace, selectedSpaceIdComposite, spaces } = input

  if (selectedSpaceKind === 'workspace') {
    return selectedSpace
  }

  if (selectedSpaceKind === 'team') {
    if (!selectedSpaceIdComposite) return selectedSpace
    const { rawId } = parseSpaceSelectionId(selectedSpaceIdComposite)
    return spaces.find((space) => space.id === rawId && space.type === 'team_space') ?? selectedSpace
  }

  return selectedSpace
}

export function resolveShellLayoutState(
  input: ResolveShellLayoutStateInput,
): ShellLayoutState {
  const {
    isMeTab,
    isIMTab,
    isAgentsTab = false,
    isCloudDocsTab = false,
    activeAppPage = null,
    activeProjectId = null,
    selectedSpaceKind,
    selectedSpace,
    isIMActive,
    conversationSpaceContext,
    conversationKind,
    isAuthenticated = true,
    imExecutionSpace = null,
    imConversationId = null,
    projectTaskSessionOpen = false,
    organizationId = null,
    userId = null,
  } = input;

  // 访客 / 登出态：整个 shell 回退到 welcome，彻底不渲染 Space 工作台与右侧聊天 rail。
  if (!isAuthenticated) {
    return GUEST_SHELL_LAYOUT_STATE;
  }

  const isConversationSelection =
    selectedSpaceKind === 'dm' ||
    selectedSpaceKind === 'im-group' ||
    isIMActive;
  // ：用户在侧栏「主动选中」的是一个 IM 会话（群聊 / 私信）——区别于 isIMActive
  // 这种「IM 面板激活但尚未明确选中会话」的过渡态。团队模式下 agent 侧栏把群聊/私信
  // 和 workspace agent 混排，这类会话自带 space_id；必须当成「聊天」渲染，不能把会话的 space
  // 当作 workspace 工作台塞进 SpaceWorkbenchHost（那样没有 agent / 工作台 tab → 整屏空白）。
  const isConversationPrimary =
    selectedSpaceKind === 'dm' || selectedSpaceKind === 'im-group';
  const effectiveConversationKind: 'dm' | 'im-group' | null =
    conversationKind ??
    (selectedSpaceKind === 'im-group'
      ? 'im-group'
      : isConversationSelection
        ? 'dm'
        : null);

  // 用户当前关注的 Space——侧栏 SpaceSidebarGlobal 用这个保留各 tab 切回时的 Space 现场。
  const sidebarSpaceContext = isConversationSelection
    ? conversationSpaceContext
    : selectedSpace;

  // 普通主导航和任务一级工作台不继承当前工作空间的布局偏好。
  // IM 会话则在下方使用 `imExecutionSpace` 建立独立的会话工作台，不能复用
  // 会话自身的 Space 上下文，否则会渲染成空白的 Space 工作台。
  const baseWorkbenchSpaceContext =
    isMeTab || isIMTab || isAgentsTab || isConversationPrimary || activeAppPage
      ? null
      : sidebarSpaceContext;

  // 点击「消息」但尚未选会话 → workbenchMode=im（主画布欢迎页，shell IM rail 常驻）；
  // 选中会话 → im-chat（有默认工作空间时主画布变会话资产）。两态共用同一棵
  // TabChatPanel rail，禁止 ContentArea 再挂完整消息页导致换壳闪烁。
  //
  // 历史 fallback 'placeholder'：保留给"非 im tab + 选了 IM 会话 + 无 selectedSpace"
  // 的边缘场景（全局搜索/通知点 IM 消息时用户当前没在任何 Space 工作）——这种情况
  // chat panel 弹出 ChatView 让用户继续聊，主画布是 placeholder 文案。
  const workbenchMode: WorkbenchMode = isMeTab
    ? 'me'
    : isAgentsTab
      ? 'agents'
    : isCloudDocsTab
      ? 'cloud-docs'
    : isIMTab
      ? (isConversationSelection ? 'im-chat' : 'im')
      : activeAppPage
        ? 'app-page'
      : isConversationPrimary
        ? 'im-chat'
          : baseWorkbenchSpaceContext
            ? 'space'
            : isConversationSelection
              ? 'placeholder'
              : 'welcome';

  const isProjectWorkbench =
    workbenchMode === 'app-page' && activeAppPage === 'project';

  // IM 会话桌面以 `im:<conversationId>` 独立 scope 承载会话资产与打开标签；
  // 未选会话或通讯录才停留在消息一级页。
  const isImConversationWorkbench =
    workbenchMode === 'im-chat' && Boolean(imExecutionSpace) && Boolean(imConversationId);
  const workbenchSpaceContext = isImConversationWorkbench
    ? imExecutionSpace
    : isCloudDocsTab
      ? sidebarSpaceContext
    : baseWorkbenchSpaceContext;
  const activeImConversationId = isImConversationWorkbench ? imConversationId : null;

  const placeholderKind: WorkbenchPlaceholderKind | null =
    workbenchMode !== 'placeholder'
      ? null
      : effectiveConversationKind;

  const layoutScopeKey =
    workbenchMode === 'me'
      ? 'me'
      : workbenchMode === 'agents'
        ? 'agents'
      : workbenchMode === 'app-page'
        ? activeAppPage === 'project'
          ? `app-page:project:${activeProjectId ?? 'none'}`
          : `app-page:${activeAppPage}`
        : workbenchMode === 'im'
              ? 'im'
              : workbenchMode === 'im-chat'
                ? 'im-chat'
                : workbenchMode === 'cloud-docs'
                  ? buildCloudDocsScopeKey({ organizationId, userId })
                : workbenchMode === 'space' && workbenchSpaceContext
                  ? `space:${workbenchSpaceContext.id}`
                  : workbenchMode === 'placeholder' && placeholderKind
                    ? `placeholder:${placeholderKind}`
                    : 'welcome';

  // chatPanel 在 'space' / 'placeholder' / 消息全链路 下打开；Project 只在用户显式打开
  // 历史频道或 Task 执行会话后打开，避免 Project 页面挂载 ChatPanel 时自动创建
  // 一条“新任务”会话（Project Ask 与默认群均已后置）。
  //   - 'space': 聊天 rail 跟 Space 工作台并排（默认使用场景）
  //   - app-page project: Project 主画布保留操作视图，团队任务对话在 shell 聊天 rail 中打开
  //   - 'placeholder': 主画布是 IM 占位，chat panel 承载 ChatView（边缘 fallback）
  //   - 'im' / 'im-chat': 消息页始终走同一棵 shell IM rail（列表+ChatView），
  //     选会话只换主画布（欢迎页 → 会话资产），禁止 ContentArea 再挂一套 TabChatPanel
  //     导致整页卸载刷新。
  const isImShellSurface =
    workbenchMode === 'im' || workbenchMode === 'im-chat';
  const chatPanelEnabled =
    workbenchMode === 'space' ||
    (isProjectWorkbench && (Boolean(effectiveConversationKind) || projectTaskSessionOpen)) ||
    workbenchMode === 'placeholder' ||
    isImShellSurface;
  const shouldShowImRail =
    workbenchMode === 'placeholder' ||
    (isProjectWorkbench && effectiveConversationKind) ||
    isImShellSurface;

  return {
    chatPanelEnabled,
    sidePanelMode: shouldShowImRail ? 'im' : 'workspace',
    workbenchMode,
    workbenchSpaceContext,
    sidebarSpaceContext,
    placeholderKind,
    layoutScopeKey,
    imConversationId: activeImConversationId,
  };
}

export function useShellLayoutState(): ShellLayoutState {
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const mainNavTab = useMainNavStore((state) => state.currentTab);
  const selectedSpace = useSpaceStore((state) => state.selectedSpace);
  const spaces = useSpaceStore((state) => state.spaces);
  const isMeTab = useMainNavStore((state) => state.currentTab === 'me');
  const isIMTab = useMainNavStore((state) => state.currentTab === 'im');
  const isCloudDocsTab = useMainNavStore((state) => state.currentTab === 'cloud-docs');
  const isAgentsTab = useMainNavStore((state) => state.currentTab === 'agents');
  const isIMActive = useIMStore((state) => state.isIMActive);
  const projectTaskSessionOpen = useProjectWorkspaceSelectionStore(
    (state) => Boolean(state.activeTaskSessionId),
  );
  const activeAppPage = useAppPageStore((state) => state.activePage);
  const activeProjectId = useAppPageStore((state) => state.activeProjectId);
  const currentConversationId = useIMStore(
    (state) => state.currentConversationId,
  );
  const conversations = useIMStore((state) => state.conversations);
  const organizationId = useOrganizationStore((state) => state.selectedOrganization?.id);
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const selectedSpaceKind = useSpaceListStore(
    (state) => state.selectedSpaceKind,
  );
  // ：团队 Space 切换只更新 selectedSpaceId，effectiveSelectedSpace 靠这个才能
  // 解析出团队 Space 本身（见 resolveEffectiveSelectedSpace 注释）。
  const selectedSpaceIdComposite = useSpaceListStore((state) => state.selectedSpaceId);

  const effectiveSelectedSpace = useMemo(() => resolveEffectiveSelectedSpace({
    selectedSpaceKind,
    selectedSpace,
    selectedSpaceIdComposite,
    spaces,
  }), [selectedSpace, selectedSpaceIdComposite, selectedSpaceKind, spaces]);

  const activeShellContext = useMemo(() => resolveActiveShellContext({
    // resolveActiveShellContext 仍叫 isSettingsOpen——但语义已经是
    // "主画布是否被非 Space 一级入口占用"。复用现有签名避免连带改一堆。
    isSettingsOpen: isMeTab || isAgentsTab || Boolean(activeAppPage),
    selectedSpaceKind,
    selectedSpace: effectiveSelectedSpace,
    conversations,
    currentConversationId,
    isIMActive,
    organizationId,
  }), [
    conversations,
    currentConversationId,
    isIMActive,
    isMeTab,
    activeAppPage,
    effectiveSelectedSpace,
    selectedSpaceKind,
    organizationId,
  ]);

  const imExecutionSpace = useMemo<SpaceContext | null>(() => {
    const conversationKind = activeShellContext.selectedConversationKind;
    if (conversationKind !== 'dm' && conversationKind !== 'im-group') return null;
    if (!activeShellContext.selectedConversationId) return null;
    const orgId = activeShellContext.activeConversation?.organization_id ?? organizationId ?? null;
    const personalSpaces = spaces.filter((space) =>
      space.type === 'workspace' &&
      !space.is_archived &&
      !space.project_id &&
      (!orgId || space.organization_id === orgId),
    );
    return personalSpaces.find((space) => space.is_default) ?? personalSpaces[0] ?? null;
  }, [
    activeShellContext.activeConversation,
    activeShellContext.selectedConversationId,
    activeShellContext.selectedConversationKind,
    organizationId,
    spaces,
  ]);

  return useMemo(() => {
    return resolveShellLayoutState({
      isMeTab,
      isIMTab,
      isAgentsTab,
      isCloudDocsTab,
      activeAppPage,
      activeProjectId,
      selectedSpaceKind: activeShellContext.selectedSpaceKind,
      selectedSpace: effectiveSelectedSpace,
      isIMActive:
        activeShellContext.selectedConversationKind !== null || isIMActive,
      conversationSpaceContext: activeShellContext.conversationSpaceContext,
      conversationKind:
        activeShellContext.selectedConversationKind as ConversationWorkbenchKind,
      isAuthenticated,
      imExecutionSpace,
      imConversationId: activeShellContext.selectedConversationId,
      projectTaskSessionOpen,
      organizationId,
      userId: currentUserId,
    });
  }, [
    activeShellContext.conversationSpaceContext,
    activeShellContext.selectedConversationId,
    activeShellContext.selectedConversationKind,
    activeShellContext.selectedSpaceKind,
    currentUserId,
    isAuthenticated,
    isIMActive,
    isIMTab,
    isAgentsTab,
    isCloudDocsTab,
    isMeTab,
    effectiveSelectedSpace,
    imExecutionSpace,
    organizationId,
    projectTaskSessionOpen,
    activeAppPage,
    activeProjectId,
  ]);
}
