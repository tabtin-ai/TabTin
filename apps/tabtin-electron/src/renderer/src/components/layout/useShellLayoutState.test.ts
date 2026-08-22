import { describe, expect, it, vi } from 'vitest';

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: vi.fn(),
}));

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: vi.fn(),
}));

vi.mock('@stores/useIMStore', () => ({
  useIMStore: vi.fn(),
}));

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: vi.fn(),
}));

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: vi.fn(),
}));

vi.mock('@stores/useUIStore', () => ({
  useUIStore: vi.fn(),
}));

import { resolveEffectiveSelectedSpace, resolveShellLayoutState } from './useShellLayoutState';
import type { SpaceContext } from '@components/context-space/SpaceContextContainer';

const buildSpaceContext = (id: string): SpaceContext => ({
  id,
  name: `space-${id}`,
  organization_id: 'ws-1',
});

describe('resolveShellLayoutState', () => {
  it('消息模块选中会话后进入独立会话桌面', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: true,
      selectedSpaceKind: 'dm',
      selectedSpace: buildSpaceContext('workspace-1'),
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('dm-1'),
      conversationKind: 'dm',
      imExecutionSpace: buildSpaceContext('workspace-1'),
      imConversationId: 'conversation-1',
    });

    expect(state.workbenchMode).toBe('im-chat');
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.workbenchSpaceContext).toEqual(buildSpaceContext('workspace-1'));
    expect(state.layoutScopeKey).toBe('im-chat');
  });

  it('私信激活但 kind 尚未同步时，仍应走 IM 面板和占位态', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: null,
      selectedSpace: buildSpaceContext('workspace-1'),
      isIMActive: true,
      conversationSpaceContext: null,
      conversationKind: 'dm',
    });

    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.workbenchMode).toBe('placeholder');
    expect(state.placeholderKind).toBe('dm');
    expect(state.layoutScopeKey).toBe('placeholder:dm');
  });

  it('AI 分身域打开时，应关闭聊天 rail 并渲染 agents 工作台', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      isAgentsTab: true,
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('workspace-1'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.workbenchMode).toBe('agents');
    expect(state.chatPanelEnabled).toBe(false);
    expect(state.workbenchSpaceContext).toBe(null);
    expect(state.layoutScopeKey).toBe('agents');
  });

  it('技能库打开时，应关闭聊天 rail 并渲染 app-page 工作台', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      activeAppPage: 'skill',
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('workspace-1'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.workbenchMode).toBe('app-page');
    expect(state.chatPanelEnabled).toBe(false);
    expect(state.workbenchSpaceContext).toBe(null);
    expect(state.layoutScopeKey).toBe('app-page:skill');
  });

  it('「我的」tab 激活时，应关闭聊天 rail 并强制渲染 me 工作台', () => {
    const state = resolveShellLayoutState({
      isMeTab: true,
      isIMTab: false,
      selectedSpaceKind: 'dm',
      selectedSpace: buildSpaceContext('workspace-1'),
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('dm-1'),
      conversationKind: 'dm',
    });

    expect(state.chatPanelEnabled).toBe(false);
    expect(state.workbenchMode).toBe('me');
    expect(state.placeholderKind).toBe(null);
    expect(state.layoutScopeKey).toBe('me');
    // me tab 时主画布脱离 Space 上下文——避免 AppLayout 的
    // `effectiveCanvasCollapsed && workbenchSpaceContext` 兜底分支误抢主画布
    expect(state.workbenchSpaceContext).toBe(null);
    // 但侧栏仍保留 Space 上下文（SidebarHeader / Agent 列表的选中态）
    expect(state.sidebarSpaceContext).toEqual(buildSpaceContext('dm-1'));
  });

  it.each([
    ['automation', 'automation'],
    ['skill', 'skill'],
    ['collaboration', 'collaboration'],
  ] as const)(
    '一级模块 %s 走 app-page 且保留侧栏上下文',
    (activeAppPage) => {
      const space = buildSpaceContext('workspace-1')
      const state = resolveShellLayoutState({
        isMeTab: false,
        isIMTab: false,
        activeAppPage,
        selectedSpaceKind: 'workspace',
        selectedSpace: space,
        isIMActive: false,
        conversationSpaceContext: null,
        conversationKind: null,
      })

      expect(state.workbenchMode).toBe('app-page')
      expect(state.chatPanelEnabled).toBe(false)
      expect(state.workbenchSpaceContext).toBe(null)
      expect(state.sidebarSpaceContext).toEqual(space)
      expect(state.layoutScopeKey).toBe(`app-page:${activeAppPage}`)
    },
  )

  it('普通 space + agent tab：workbench / sidebar 上下文一致（无解耦）', () => {
    const ctx = buildSpaceContext('space-42');
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: 'workspace',
      selectedSpace: ctx,
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.workbenchSpaceContext).toEqual(ctx);
    expect(state.sidebarSpaceContext).toEqual(ctx);
  });

  it('普通 space 选择时，应稳定使用 space 级布局 key', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('workspace');
    expect(state.workbenchMode).toBe('space');
    expect(state.layoutScopeKey).toBe('space:space-42');
  });

  it('app-page project 走统一 app-page 壳层且默认不打开聊天 rail', () => {
    const space = buildSpaceContext('workspace-1')
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      activeAppPage: 'project',
      activeProjectId: 'team-space-1',
      selectedSpaceKind: 'workspace',
      selectedSpace: space,
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    })

    expect(state.workbenchMode).toBe('app-page')
    expect(state.chatPanelEnabled).toBe(false)
    expect(state.layoutScopeKey).toBe('app-page:project:team-space-1')
  })

  it('app-page project 打开 Task 执行会话后展示聊天 rail', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      activeAppPage: 'project',
      activeProjectId: 'team-space-1',
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
      projectTaskSessionOpen: true,
    })

    expect(state.workbenchMode).toBe('app-page')
    expect(state.chatPanelEnabled).toBe(true)
  })

  it('Project 显式打开 Task 执行会话后才展示聊天 rail', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      activeAppPage: 'project',
      activeProjectId: 'team-space-1',
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
      projectTaskSessionOpen: true,
    });

    expect(state.workbenchMode).toBe('app-page');
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('workspace');
  });

  it('Project 打开频道时，主画布保留项目页但右侧 rail 显示 IM', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      activeAppPage: 'project',
      activeProjectId: 'team-space-1',
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('team-space-1'),
      conversationKind: 'im-group',
    });

    expect(state.workbenchMode).toBe('app-page');
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.workbenchSpaceContext).toBe(null);
    expect(state.layoutScopeKey).toBe('app-page:project:team-space-1');
  });

  it('项目上下文中全局主动选中普通 IM 会话进入会话桌面回退', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      activeAppPage: 'project',
      activeProjectId: 'team-space-1',
      selectedSpaceKind: 'dm',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('dm-1'),
      conversationKind: 'dm',
    });

    expect(state.workbenchMode).toBe('app-page');
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.layoutScopeKey).toBe('app-page:project:team-space-1');
  });

  it('欢迎态不应复用旧 space 的布局 key', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: null,
      selectedSpace: null,
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.chatPanelEnabled).toBe(false);
    expect(state.sidePanelMode).toBe('workspace');
    expect(state.workbenchMode).toBe('welcome');
    expect(state.layoutScopeKey).toBe('welcome');
  });

  it('「消息」tab + 未选会话：shell IM rail 常驻，主画布不另挂消息页', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: true,
      selectedSpaceKind: null,
      selectedSpace: null,
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.workbenchMode).toBe('im');
    expect(state.layoutScopeKey).toBe('im');
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.workbenchSpaceContext).toBe(null);
  });

  it('「消息」tab + 已选工作空间：仍走 IM rail，不把主列换回 Space 工作台', () => {
    // 左侧仍保留 Workspace 树，但中间内容列不再显示工作台。
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: true,
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
    });

    expect(state.workbenchMode).toBe('im');
    expect(state.workbenchSpaceContext).toBe(null);
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.sidebarSpaceContext).toEqual(buildSpaceContext('space-42'));
  });

  it('「消息」tab + 选了会话（无默认工作空间）：仍保持同一 IM rail，避免换壳', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: true,
      selectedSpaceKind: 'dm',
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('dm-1'),
      conversationKind: 'dm',
    });

    expect(state.workbenchMode).toBe('im-chat');
    expect(state.layoutScopeKey).toBe('im-chat');
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.placeholderKind).toBe(null);
    expect(state.workbenchSpaceContext).toBe(null);
  });

  it('「消息」tab + 选了会话 + 有默认工作空间：进入独立会话桌面', () => {
    const imWorkspace = buildSpaceContext('workspace-home');
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: true,
      selectedSpaceKind: 'dm',
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('dm-1'),
      conversationKind: 'dm',
      imExecutionSpace: imWorkspace,
      imConversationId: 'conv-1',
    });

    expect(state.workbenchMode).toBe('im-chat');
    expect(state.workbenchSpaceContext).toEqual(imWorkspace);
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.imConversationId).toBe('conv-1');
  });

  it('非消息 tab 主动选中群聊 + 有默认工作空间：同样进入会话桌面', () => {
    const imWorkspace = buildSpaceContext('workspace-home');
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: 'im-group',
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('group-1'),
      conversationKind: 'im-group',
      imExecutionSpace: imWorkspace,
      imConversationId: 'group-conv',
    });

    expect(state.workbenchMode).toBe('im-chat');
    expect(state.workbenchSpaceContext).toEqual(imWorkspace);
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.imConversationId).toBe('group-conv');
  });

  it('「消息」tab + 选了会话但无默认工作空间：IM rail 不停，主画布不换第二套消息页', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: true,
      selectedSpaceKind: 'dm',
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('dm-1'),
      conversationKind: 'dm',
      imExecutionSpace: null,
      imConversationId: 'conv-1',
    });

    expect(state.workbenchMode).toBe('im-chat');
    expect(state.workbenchSpaceContext).toBe(null);
    expect(state.chatPanelEnabled).toBe(true);
    expect(state.sidePanelMode).toBe('im');
    expect(state.imConversationId).toBe(null);
  });

  it('非 im tab + isIMActive 过渡态（kind 未明确）+ conversationSpaceContext 未就绪：fallback 到 placeholder', () => {
    // 'placeholder' 保留触发条件（ 后收窄）：isIMActive 处于「IM 面板激活但尚未
    // 明确选中会话 kind」的过渡态——selectedSpaceKind 仍是 null（不是用户主动选中的
    // 群聊/私信），且 conversationSpaceContext 未就绪。典型：全局搜索/通知点击 IM 消息
    // 但 activeConversation 详情还在路上。此时主画布走 placeholder 占位 + 右侧 chat rail。
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: null,
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: null,
      conversationKind: 'dm',
    });

    expect(state.workbenchMode).toBe('placeholder');
    expect(state.placeholderKind).toBe('dm');
    expect(state.sidePanelMode).toBe('im');
    expect(state.chatPanelEnabled).toBe(true);
  });

  it('#748：非 im tab 主动选中群聊/私信 → IM rail 承载聊天，不当作工作空间渲染', () => {
    const groupState = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: 'im-group',
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: buildSpaceContext('group-1'),
      conversationKind: 'im-group',
    });

    expect(groupState.workbenchMode).toBe('im-chat');
    expect(groupState.workbenchSpaceContext).toBe(null);
    expect(groupState.chatPanelEnabled).toBe(true);
    expect(groupState.sidePanelMode).toBe('im');
    expect(groupState.placeholderKind).toBe(null);
    expect(groupState.layoutScopeKey).toBe('im-chat');

    // conversationSpaceContext 未就绪也一样走 IM rail，不挂 Space 工作台
    const dmState = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: 'dm',
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: null,
      conversationKind: 'dm',
    });

    expect(dmState.workbenchMode).toBe('im-chat');
    expect(dmState.workbenchSpaceContext).toBe(null);
    expect(dmState.chatPanelEnabled).toBe(true);
    expect(dmState.sidePanelMode).toBe('im');
  });

  it('#1897：未登录但内存里残留 selectedSpace 时，整个 shell 回退 welcome 且关闭聊天 rail', () => {
    // 根因回归锁：登出后 useSpaceStore.selectedSpace 在 store 重置完成前可能残留。
    // 若不在源头按 isAuthenticated 门控，workbenchMode 会判定为 'space'、
    // chatPanelEnabled=true，导致登录 / 邀请码界面右侧残留对话面板。
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: 'workspace',
      selectedSpace: buildSpaceContext('space-42'),
      isIMActive: false,
      conversationSpaceContext: null,
      conversationKind: null,
      isAuthenticated: false,
    });

    expect(state.chatPanelEnabled).toBe(false);
    expect(state.workbenchMode).toBe('welcome');
    expect(state.workbenchSpaceContext).toBe(null);
    expect(state.sidebarSpaceContext).toBe(null);
    expect(state.placeholderKind).toBe(null);
    expect(state.layoutScopeKey).toBe('welcome');
  });

  it('#1897：未登录 + 残留 IM 会话激活态也不应渲染 placeholder 的 chat rail', () => {
    const state = resolveShellLayoutState({
      isMeTab: false,
      isIMTab: false,
      selectedSpaceKind: null,
      selectedSpace: null,
      isIMActive: true,
      conversationSpaceContext: null,
      conversationKind: 'dm',
      isAuthenticated: false,
    });

    expect(state.chatPanelEnabled).toBe(false);
    expect(state.workbenchMode).toBe('welcome');
    expect(state.sidePanelMode).toBe('workspace');
  });
});

describe('resolveEffectiveSelectedSpace（ 回归锁）', () => {
  const personalSpace = { id: 'personal-space-1', type: 'workspace' };
  const codeSpace = { id: 'code-space-1', type: 'workspace', working_dir_type: 'code' };
  const teamSpace = { id: 'team-space-1', type: 'team_space' };
  const spaces = [personalSpace, codeSpace, teamSpace];

  it('切到团队 Space 后必须解析出团队 Space 本身，不能停留在上一个个人 Space', () => {
    // 复现 ：markTeamSpaceProjectNavigation 只更新了 selectedSpaceIdComposite，
    // useSpaceStore.selectedSpace（这里传入的 selectedSpace）还停在切换前的个人 Space。
    const result = resolveEffectiveSelectedSpace({
      selectedSpaceKind: 'team',
      selectedSpace: personalSpace,
      selectedSpaceIdComposite: 'team:team-space-1',
      spaces,
    });

    expect(result).toBe(teamSpace);
  });

  it('团队 Space 场景下 selectedSpaceId 还没就位时，先保留原值兜底（不炸/不误指别的 Space）', () => {
    const result = resolveEffectiveSelectedSpace({
      selectedSpaceKind: 'team',
      selectedSpace: personalSpace,
      selectedSpaceIdComposite: null,
      spaces,
    });

    expect(result).toBe(personalSpace);
  });

  it('团队 Space id 在 spaces 列表里找不到（尚未加载完）时兜底回退原 selectedSpace', () => {
    const result = resolveEffectiveSelectedSpace({
      selectedSpaceKind: 'team',
      selectedSpace: personalSpace,
      selectedSpaceIdComposite: 'team:not-loaded-yet',
      spaces,
    });

    expect(result).toBe(personalSpace);
  });

  it('个人 Space（workspace kind）直接信任 selectedSpace', () => {
    const result = resolveEffectiveSelectedSpace({
      selectedSpaceKind: 'workspace',
      selectedSpace: codeSpace,
      selectedSpaceIdComposite: null,
      spaces,
    });

    expect(result).toBe(codeSpace);
  });

  it('dm/im-group/null kind 直接透传 selectedSpace，不受团队 Space 解析逻辑影响', () => {
    expect(resolveEffectiveSelectedSpace({
      selectedSpaceKind: 'dm',
      selectedSpace: personalSpace,
      selectedSpaceIdComposite: 'team:team-space-1',
      spaces,
    })).toBe(personalSpace);
  });
});
