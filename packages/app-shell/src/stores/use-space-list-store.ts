/**
 * Space 统一列表 Store — 从 Electron 抽离
 *
 * 聚合 workspace（Space）与 IM 会话两类主数据源，
 * 向侧边栏提供统一的 SpaceListItem[] 列表和 selectedSpace。
 *
 * 当前聚合 workspace 与 IM 会话。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { withPersistSafety } from '@tabtin/shared';
import type {
  SpaceListItem,
  SpaceNavigationKind,
  ConversationMinimal,
} from '../types/space.js';
import {
  spaceToListItem,
  buildSpaceSelectionId,
  getConversationNavigationKind,
  imConversationToListItem,
  parseSpaceSelectionId,
  compareSpacesByStableOrder,
} from '../types/space.js';
import { useSpaceStore } from './use-space-store.js';
import { useOrganizationStore } from './use-organization-store.js';
import { registerResetAction } from './session-reset-registry.js';
import {
  buildSelectionSnapshot,
  EMPTY_SPACE_SELECTION,
  getOrganizationSelection,
  rememberOrganizationSelection,
  resolveSelectionOrganizationId,
  resolveSelectionBySpaceId,
  type SpaceSelectionSnapshot,
  type OrganizationSpaceSelectionMap,
} from './space-list-selection.js';
import { resolveShellSelection } from './resolve-shell-selection.js';
import { getRuntime } from '../runtime.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SpaceList');

// ── 外部 Store 适配器 ──

export interface ExternalStoreAdapters {
  im: {
    getConversations(): ConversationMinimal[];
    getUnreadCounts(): Record<string, number>;
    isLoading(): boolean;
    getError(): string | null;
    openIM(): void;
    closeIM(): void;
    setCurrentConversation(id: string | null): void;
    isIMActive(): boolean;
    isContactsViewActive(): boolean;
    getCurrentConversationId(): string | null;
    reset(): void;
  };
  /** 本机最后主动使用的个人 Workspace；缺省时 ensure 回落组织主场 / 最近活跃 */
  getLastUsedWorkspaceId?(organizationId: string | null): string | null;
}

let _adapters: ExternalStoreAdapters | null = null;

export function setExternalStoreAdapters(
  adapters: ExternalStoreAdapters,
): void {
  _adapters = adapters;
}

function getAdapters(): ExternalStoreAdapters {
  if (!_adapters) {
    return {
      im: {
        getConversations: () => [],
        getUnreadCounts: () => ({}),
        isLoading: () => false,
        getError: () => null,
        openIM: () => {},
        closeIM: () => {},
        setCurrentConversation: () => {},
        isIMActive: () => false,
        isContactsViewActive: () => false,
        getCurrentConversationId: () => null,
        reset: () => {},
      },
    };
  }
  return _adapters;
}

// ── Store 定义 ──

interface ClearSelectionOptions {
  preserveOrganizationMemory?: boolean;
  organizationId?: string | null;
}

interface HydrateOrganizationSelectionOptions {
  preferCurrentSelectionAsFallback?: boolean;
}

interface GetSpaceListOptions {
  organizationId?: string | null;
  navigationKinds?: SpaceNavigationKind[];
}

interface SpaceListState {
  selectedSpaceId: string | null;
  selectedSpaceKind: SpaceNavigationKind | null;
  selectionByOrganization: OrganizationSpaceSelectionMap;

  activateSpace: (spaceId: string | null) => boolean;
  activateConversation: (
    conversationId: string | null,
    preferredKind?: Extract<SpaceNavigationKind, 'dm' | 'im-group'>,
  ) => boolean;
  handleOrganizationChange: (
    organizationId: string | null,
    options?: HydrateOrganizationSelectionOptions,
  ) => void;
  /**
   * 唯一激活入口：按 resolveShellSelection 解析当前应进入的 Workspace/会话并激活。
   * Workspace 路径不被 IM loadError 挡住。
   */
  ensureActiveSelection: () => void;
  /** @deprecated 使用 ensureActiveSelection */
  syncSelectionState: () => void;
  /** @deprecated 使用 ensureActiveSelection */
  reconcileSelection: () => void;
  clearActiveContext: (options?: ClearSelectionOptions) => void;
  selectSpace: (item: SpaceListItem) => void;
  selectSpaceByKind: (kind: SpaceNavigationKind) => void;
  selectSpaceById: (kind: SpaceNavigationKind, rawId: string) => void;
  selectSpaceBySpaceId: (spaceId: string) => boolean;
  hydrateSelectionForOrganization: (
    organizationId: string,
    options?: HydrateOrganizationSelectionOptions,
  ) => void;
  clearSelection: (options?: ClearSelectionOptions) => void;

  getSpaceList: (options?: GetSpaceListOptions) => SpaceListItem[];
}

type SpaceListPersistState = Pick<
  SpaceListState,
  'selectedSpaceId' | 'selectedSpaceKind' | 'selectionByOrganization'
>;

function normalizeSelectionKind(
  kind: SpaceNavigationKind | string | null | undefined,
): SpaceNavigationKind | null {
  if (kind === 'bot') return 'workspace';
  return kind === 'workspace' || kind === 'dm' || kind === 'im-group' || kind === 'team'
    ? kind
    : null;
}

function sanitizeSelection(
  selection: {
    selectedSpaceId: string | null | undefined;
    selectedSpaceKind: SpaceNavigationKind | string | null | undefined;
  },
): SpaceSelectionSnapshot {
  const selectedSpaceId = selection.selectedSpaceId ?? null;
  const selectedSpaceKind = normalizeSelectionKind(selection.selectedSpaceKind);

  return selectedSpaceKind === 'team'
    ? EMPTY_SPACE_SELECTION
    : {
        selectedSpaceId,
        selectedSpaceKind,
      };
}

function sanitizeSelectionMap(
  selectionByOrganization: OrganizationSpaceSelectionMap | undefined,
): OrganizationSpaceSelectionMap {
  if (!selectionByOrganization) return {};

  const next: OrganizationSpaceSelectionMap = {};
  for (const [organizationId, selection] of Object.entries(selectionByOrganization)) {
    const sanitized = sanitizeSelection(selection);
    if (sanitized.selectedSpaceId && sanitized.selectedSpaceKind) {
      next[organizationId] = sanitized;
    }
  }
  return next;
}

export const useSpaceListStore = create<SpaceListState>()(
  persist<SpaceListState, [], [], SpaceListPersistState>(
    (set, get) => {
      function resolveOrganizationId(organizationId?: string | null): string | null {
        return (
          organizationId ??
          useOrganizationStore.getState().selectedOrganization?.id ??
          null
        );
      }

      function updateSelection(
        selection: SpaceSelectionSnapshot,
        options?: ClearSelectionOptions,
      ) {
        const organizationId = resolveOrganizationId(options?.organizationId);
        set((state) => {
          const nextSelectionByOrganization =
            organizationId && !options?.preserveOrganizationMemory
              ? rememberOrganizationSelection(
                  state.selectionByOrganization,
                  organizationId,
                  selection,
                )
              : state.selectionByOrganization;

          if (
            state.selectedSpaceId === selection.selectedSpaceId &&
            state.selectedSpaceKind === selection.selectedSpaceKind &&
            nextSelectionByOrganization === state.selectionByOrganization
          ) {
            return state;
          }

          return {
            selectedSpaceId: selection.selectedSpaceId,
            selectedSpaceKind: selection.selectedSpaceKind,
            selectionByOrganization: nextSelectionByOrganization,
          };
        });
      }

      function clearExternalSelection(): void {
        const adapters = getAdapters();
        useSpaceStore.getState().selectSpace(null);
        adapters.im.setCurrentConversation(null);
        adapters.im.closeIM();
      }

      function canFallbackToCurrentSelection(organizationId: string): boolean {
        const state = get();
        if (!state.selectedSpaceId || !state.selectedSpaceKind) return false;

        const selectionOrganizationId = resolveSelectionOrganizationId({
          selection: {
            selectedSpaceId: state.selectedSpaceId,
            selectedSpaceKind: state.selectedSpaceKind,
          },
          spaces: useSpaceStore.getState().spaces,
          conversations: getAdapters().im.getConversations(),
        });
        return selectionOrganizationId === organizationId;
      }

      function resolveConversation(rawId: string): ConversationMinimal | null {
        return (
          getAdapters()
            .im.getConversations()
            .find((conversation) => conversation.id === rawId) ?? null
        );
      }

      function hasSpaceListError(): boolean {
        return Boolean(useSpaceStore.getState().error);
      }

      /**
       * 仅 `loadConversationsFailed` 视为会话列表不可靠：
       * markReadFailed / loadMessagesFailed / loadUnreadFailed 不算。
       * 供 `hasSelectionDataError` → `purgeInvalidDerivedState` 门禁使用；
       * dm/im-group 选中校验已改为只看本地 conversations 缓存。
       */
      function isImConversationListReliable(): boolean {
        return getAdapters().im.getError() !== 'loadConversationsFailed';
      }

      function hasSelectionDataError(): boolean {
        return Boolean(hasSpaceListError() || !isImConversationListReliable());
      }

      function collectValidSpaceIds(): string[] {
        const adapters = getAdapters();
        const validSpaceIds = new Set<string>();

        useSpaceStore
          .getState()
          .spaces.forEach((space) => validSpaceIds.add(space.id));
        adapters.im.getConversations().forEach((conversation) => {
          if (conversation.space_id) validSpaceIds.add(conversation.space_id);
        });

        return [...validSpaceIds];
      }

      function purgeInvalidDerivedState(): void {
        const validSpaceIds = collectValidSpaceIds();
        // 所有数据源都返回 0 个 Space ID 且无错误 → 数据尚未加载完成，跳过 purge。
        // Space/IM isLoading 只能区分"正在加载"，无法区分"尚未开始加载"
        // （isLoading 初始为 false，与加载完成后的 false 不可分辨）。
        // 在真正的空账户场景下跳过 purge 是安全的：没有 Space 就没有需要清理的派生状态。
        if (validSpaceIds.length === 0 && !hasSelectionDataError()) {
          return;
        }
        getRuntime().bridge.purgeInvalidSpaceDerivedState?.(validSpaceIds);
      }

      function closeAuxiliaryPanels(): void {
        getRuntime().bridge.closeAuxiliaryPanels?.();
      }

      function isSelectionSynced(
        kind: SpaceNavigationKind,
        rawId: string,
      ): boolean {
        const adapters = getAdapters();
        const selectedSpace = useSpaceStore.getState().selectedSpace;
        const currentConversationId = adapters.im.getCurrentConversationId();
        const isIMActive = adapters.im.isIMActive();

        switch (kind) {
          case 'workspace':
            return (
              selectedSpace?.id === rawId &&
              currentConversationId == null &&
              !isIMActive
            );
          case 'dm':
          case 'im-group':
            return (
              currentConversationId === rawId &&
              isIMActive &&
              !selectedSpace
            );
          case 'team':
            return (
              !selectedSpace &&
              currentConversationId == null &&
              !isIMActive
            );
        }
      }

      function ensureOrganizationFollows(organizationId: string): void {
        const { selectedOrganization, organizations } = useOrganizationStore.getState();
        if (selectedOrganization?.id === organizationId) return;
        const target = organizations.find(w => w.id === organizationId);
        if (!target) return;
        useOrganizationStore.setState({ selectedOrganization: target });
      }

      function activateSelection(
        kind: SpaceNavigationKind,
        rawId: string | null,
        _compositeId: string | null,
        options?: ClearSelectionOptions,
      ): boolean {
        const adapters = getAdapters();

        switch (kind) {
          case 'workspace': {
            if (rawId) {
              const targetSpace = useSpaceStore
                .getState()
                .spaces.find((s) => s.id === rawId && (s.type == null || s.type === 'workspace'));
              if (!targetSpace) {
                // 降级：选中的 workspace Space 在当前列表里找不到（未加载完 / 已删除）
                log.warn('activateSelection: workspace Space 未找到，清空选择', { spaceId: rawId });
                get().clearActiveContext(options);
                return false;
              }
              closeAuxiliaryPanels();
              adapters.im.setCurrentConversation(null);
              adapters.im.closeIM();
              useSpaceStore.getState().selectSpace(targetSpace);
              ensureOrganizationFollows(targetSpace.organization_id);
              // ：只有目标资源真的成为前台选择后，才能结束组织切换窗口。
              // fallback 路径会先清空 selectedSpace，随后由 ensureActiveSelection 重试；
              // 因此不能在 handleOrganizationChange 中提前 complete。
              useOrganizationStore
                .getState()
                .completeOrganizationContextSwitch(targetSpace.organization_id);
            } else {
              get().clearActiveContext(options);
              return false;
            }
            updateSelection(buildSelectionSnapshot('workspace', rawId), options);
            return true;
          }
          case 'im-group':
          case 'dm': {
            if (!rawId) {
              get().clearActiveContext(options);
              return false;
            }
            const conversation = resolveConversation(rawId);
            if (!conversation) {
              get().clearActiveContext(options);
              return false;
            }
            const nextKind = getConversationNavigationKind(conversation);
            closeAuxiliaryPanels();
            useSpaceStore.getState().selectSpace(null);
            adapters.im.openIM();
            adapters.im.setCurrentConversation(rawId);
            updateSelection(buildSelectionSnapshot(nextKind, rawId), options);
            // IM 没有 selectedSpace，使用会话自身的组织归属确认前台已对齐。
            useOrganizationStore
              .getState()
              .completeOrganizationContextSwitch(conversation.organization_id);
            return true;
          }
          case 'team': {
            get().clearActiveContext(options);
            return true;
          }
        }
      }

      return {
        selectedSpaceId: null,
        selectedSpaceKind: null,
        selectionByOrganization: {},

        activateSpace: (spaceId) => {
          if (!spaceId) {
            get().clearActiveContext();
            return false;
          }
          return activateSelection(
            'workspace',
            spaceId,
            buildSpaceSelectionId('workspace', spaceId),
          );
        },

        activateConversation: (conversationId, preferredKind) => {
          if (!conversationId) {
            get().clearActiveContext();
            return false;
          }
          const conversation = resolveConversation(conversationId);
          if (!conversation) {
            get().clearActiveContext();
            return false;
          }
          const kind =
            preferredKind ?? getConversationNavigationKind(conversation);
          return activateSelection(
            kind,
            conversationId,
            buildSpaceSelectionId(kind, conversationId),
          );
        },

        handleOrganizationChange: (organizationId, options) => {
          // 状态迁移：切换 organization 会连带切换/清空当前 Space 选择
          log.info('handleOrganizationChange:', { organizationId });
          // ：selectSpace(null) 不清身份，切组织须先清跨 org selectedAgent。
          useSpaceStore
            .getState()
            .clearSelectedAgentOutsideOrganization(organizationId);
          // Wave 3 修复 Y-1：为避免 selectedSpace=null 的一帧空白，
          // **先尝试**基于 selectionByOrganization 记忆里的 remembered selection 做
          // 原地切换（同步完成 activate），再走 hydrate 兜底。
          //
          // 之前的实现总是先 `selectSpace(null) + im.reset()` 再异步 reconcile，
          // 导致切换瞬间 React 至少有 1 帧 selectedSpace=null 的空白期；
          // Wave 0 时这帧被 chat client 重连 loading 盖住，Wave 3 不动 chat
          // 后闪烁更显眼（用户 Review Y-1）。
          if (organizationId) {
            const state = get();
            const remembered = sanitizeSelection(
              getOrganizationSelection(state.selectionByOrganization, organizationId),
            );

            // 优先路径：记忆里有合法 selection 且目标资源已加载 → 原地 activate，
            // 不触发中间态 selectSpace(null)
            if (remembered.selectedSpaceId && remembered.selectedSpaceKind) {
              const { rawId } = parseSpaceSelectionId(remembered.selectedSpaceId);
              const targetAvailable =
                remembered.selectedSpaceKind === 'workspace'
                  ? useSpaceStore.getState().spaces.some((s) => s.id === rawId && (s.type == null || s.type === 'workspace'))
                  : (remembered.selectedSpaceKind === 'dm' ||
                      remembered.selectedSpaceKind === 'im-group')
                    ? !!resolveConversation(rawId)
                    : false;

              if (targetAvailable) {
                // 原地 activate：activateSelection 内部会接管 useSpaceStore.selectSpace
                // + adapters.im 切换，不再需要前置 selectSpace(null) + im.reset
                activateSelection(
                  remembered.selectedSpaceKind,
                  rawId,
                  buildSpaceSelectionId(remembered.selectedSpaceKind, rawId),
                  { preserveOrganizationMemory: true },
                );
                return;
              }
            }

            // Fallback 路径：记忆不命中或目标资源未加载完 → 保留 selectSpace(null)
            // 让后续 ensureActiveSelection 异步补齐选中。
            //
            // Wave 4：不再调用 `adapters.im.reset()` —— Centrifugo 连接已是
            // 用户级且不 teardown，IM conversations / messages / unreadCounts
            // 跨 organization 共存（`useIMStore.loadConversations` 按 organization_id
            // 替换该 organization 的部分，其他 organization 会话保留），切换时清空
            // 整个 IM 状态会丢失其他 organization 的会话信息，破坏多组织体验。
            // 真正的「当前激活会话清理」会在后续 ensureActiveSelection →
            // activateSelection 阶段由 adapters.im.setCurrentConversation(null)
            // / closeIM 完成（'workspace' 分支）。
            useSpaceStore.getState().selectSpace(null);
            get().hydrateSelectionForOrganization(organizationId, options);
            return;
          }

          // organizationId === null 兜底（罕见，通常发生在登出过渡期；登出本身的
          // IM 清理由 sessionResetRegistry teardown 通过 `adapters.im.reset`
          // 兜底，本路径无需重复）。`clearActiveContext` 内部会调
          // `clearExternalSelection` 完成 setCurrentConversation(null) + closeIM，
          // 保留 IM 数据让用户后续登录或重新选择 organization 时立即可见。
          useSpaceStore.getState().selectSpace(null);
          get().clearActiveContext({ preserveOrganizationMemory: true });
        },

        ensureActiveSelection: () => {
          // Space 列表仍在加载时无法校验 workspace 记忆，等下一轮。
          if (useSpaceStore.getState().isLoading) return;
          // Space 列表硬错误：不臆造选中（与历史 sync 门禁一致）。
          if (hasSpaceListError()) return;

          const adapters = getAdapters();
          const state = get();
          const selectedSpaceKind = state.selectedSpaceKind;

          // 通讯录是消息域内的独立落点，不应被 Space/会话记忆自动接管。
          if (adapters.im.isContactsViewActive()) return;

          // Project(team) 选中由 Project 导航承载：绝不回落个人 Workspace（ 回归）。
          if (selectedSpaceKind === 'team') {
            return;
          }

          // IM 仍在加载且当前意图是 IM 选中：先等，避免误回落 Workspace。
          if (
            adapters.im.isLoading() &&
            (selectedSpaceKind === 'dm' || selectedSpaceKind === 'im-group')
          ) {
            return;
          }

          purgeInvalidDerivedState();

          const organizationId =
            useOrganizationStore.getState().selectedOrganization?.id ?? null;
          const resolved = resolveShellSelection({
            organizationId,
            spaces: useSpaceStore.getState().spaces,
            conversations: adapters.im.getConversations(),
            selectedSpaceId: state.selectedSpaceId,
            selectedSpaceKind,
            lastUsedWorkspaceId:
              adapters.getLastUsedWorkspaceId?.(organizationId) ?? null,
          });

          if (!resolved) {
            if (state.selectedSpaceId || state.selectedSpaceKind) {
              get().clearActiveContext({ preserveOrganizationMemory: true });
            } else {
              clearExternalSelection();
            }
            return;
          }

          if (!isSelectionSynced(resolved.kind, resolved.rawId)) {
            activateSelection(
              resolved.kind,
              resolved.rawId,
              buildSpaceSelectionId(resolved.kind, resolved.rawId),
              { preserveOrganizationMemory: true },
            );
          }
        },

        syncSelectionState: () => {
          get().ensureActiveSelection();
        },

        reconcileSelection: () => {
          get().ensureActiveSelection();
        },

        clearActiveContext: (options) => {
          clearExternalSelection();
          updateSelection(EMPTY_SPACE_SELECTION, options);
        },

        selectSpace: (item) => {
          activateSelection(item.navigationKind, item.source_id, item.id);
        },

        selectSpaceByKind: (kind) => {
          if (kind === 'team') {
            get().clearActiveContext();
            return;
          }
          get().clearActiveContext({ preserveOrganizationMemory: true });
        },

        selectSpaceById: (kind, rawId) => {
          activateSelection(kind, rawId, buildSpaceSelectionId(kind, rawId));
        },

        selectSpaceBySpaceId: (spaceId) => {
          const adapters = getAdapters();
          const resolved = resolveSelectionBySpaceId({
            spaceId,
            spaces: useSpaceStore.getState().spaces,
            conversations: adapters.im.getConversations(),
          });
          if (!resolved) return false;
          return activateSelection(
            resolved.kind,
            resolved.rawId,
            resolved.compositeId,
          );
        },

        hydrateSelectionForOrganization: (organizationId, options) => {
          set((state) => {
            const remembered = sanitizeSelection(
              getOrganizationSelection(state.selectionByOrganization, organizationId),
            );
            const hasRememberedSelection = Boolean(
              remembered.selectedSpaceId && remembered.selectedSpaceKind,
            );
            const shouldUseFallback =
              !hasRememberedSelection &&
              options?.preferCurrentSelectionAsFallback &&
              canFallbackToCurrentSelection(organizationId);

            const nextSelection = sanitizeSelection(
              shouldUseFallback
                ? {
                    selectedSpaceId: state.selectedSpaceId,
                    selectedSpaceKind: state.selectedSpaceKind,
                  }
                : remembered,
            );
            const nextSelectionByOrganization = shouldUseFallback
              ? rememberOrganizationSelection(
                  state.selectionByOrganization,
                  organizationId,
                  nextSelection,
                )
              : state.selectionByOrganization;

            if (
              state.selectedSpaceId === nextSelection.selectedSpaceId &&
              state.selectedSpaceKind === nextSelection.selectedSpaceKind &&
              nextSelectionByOrganization === state.selectionByOrganization
            ) {
              return state;
            }

            return {
              selectedSpaceId: nextSelection.selectedSpaceId,
              selectedSpaceKind: nextSelection.selectedSpaceKind,
              selectionByOrganization: nextSelectionByOrganization,
            };
          });
        },

        clearSelection: (options) => {
          get().clearActiveContext(options);
        },

        getSpaceList: (options) => {
          const organizations = useOrganizationStore.getState().organizations;
          const selectedOrganizationId =
            useOrganizationStore.getState().selectedOrganization?.id ?? '';
          const spaces = useSpaceStore.getState().spaces;
          const adapters = getAdapters();
          const conversations = adapters.im.getConversations();
          const unreadCounts = adapters.im.getUnreadCounts();

          const organizationMap = new Map(organizations.map(w => [w.id, w]));

          const botItems: SpaceListItem[] = spaces
            .filter((as) => !as.is_archived && as.type !== 'team_space')
            .map((s) => {
              const item = spaceToListItem(s);
              const organization = organizationMap.get(s.organization_id);
              if (organization) {
                item.organization_name = organization.name;
                item.organization_type = organization.type;
              }
              return item;
            });

          const dmItems: SpaceListItem[] = conversations.map((c, i) => {
            const item = imConversationToListItem(c, c.organization_id || selectedOrganizationId, i);
            item.unread_count = unreadCounts[c.id] ?? c.unread_count ?? 0;
            const organization = organizationMap.get(item.organization_id);
            if (organization) {
              item.organization_name = organization.name;
              item.organization_type = organization.type;
            }
            return item;
          });

          let all = [...botItems, ...dmItems];

          if (options?.organizationId != null) {
            all = all.filter((item) => item.organization_id === options.organizationId);
          }
          if (options?.navigationKinds?.length) {
            const allowedKinds = new Set(options.navigationKinds);
            all = all.filter((item) => allowedKinds.has(item.navigationKind));
          }

          const organizationOrder = new Map<string, number>();
          organizations.forEach((w, i) => {
            organizationOrder.set(w.id, w.type === 'personal' ? -1 : i);
          });

          all.sort((a, b) => {
            const aGroup = organizationOrder.get(a.organization_id) ?? 999;
            const bGroup = organizationOrder.get(b.organization_id) ?? 999;
            if (aGroup !== bGroup) return aGroup - bGroup;
            if (a.navigationKind === 'workspace' && b.navigationKind === 'workspace') {
              return compareSpacesByStableOrder(
                {
                  id: a.source_id,
                  order: a.order,
                  created_at: a.created_at || '',
                },
                {
                  id: b.source_id,
                  order: b.order,
                  created_at: b.created_at || '',
                },
              );
            }
            if (a.order !== b.order) return a.order - b.order;
            return a.source_id.localeCompare(b.source_id);
          });

          return all;
        },
      };
    },
    withPersistSafety({
      name: 'tabtin-space-list',
      version: 4,
      migrate: (persistedState, _version) => {
        const state = (persistedState || {}) as Partial<SpaceListPersistState>;
        const selectionByOrganization = sanitizeSelectionMap(
          state.selectionByOrganization,
        );
        const currentSelection = sanitizeSelection({
          selectedSpaceId: state.selectedSpaceId ?? null,
          selectedSpaceKind: state.selectedSpaceKind ?? null,
        });
        return {
          selectedSpaceId: currentSelection.selectedSpaceId,
          selectedSpaceKind: currentSelection.selectedSpaceKind,
          selectionByOrganization,
        };
      },
      partialize: (state): SpaceListPersistState => ({
        selectedSpaceId: state.selectedSpaceId,
        selectedSpaceKind: state.selectedSpaceKind,
        selectionByOrganization: state.selectionByOrganization,
      }),
    }),
  ),
);

const _legacySelection = useSpaceListStore.getState();
if (_legacySelection.selectedSpaceId && !_legacySelection.selectedSpaceKind) {
  const { kind, rawId } = parseSpaceSelectionId(
    _legacySelection.selectedSpaceId,
  );
  useSpaceListStore.setState({
    selectedSpaceId: buildSpaceSelectionId(kind, rawId),
    selectedSpaceKind: kind,
  });
} else if (_legacySelection.selectedSpaceKind === 'team') {
  useSpaceListStore.setState({
    selectedSpaceId: null,
    selectedSpaceKind: null,
  });
}

let _lastOrganizationIdsKey = '';
useOrganizationStore.subscribe((state) => {
  const organizations = state.organizations;
  if (organizations.length === 0) return;
  const key = organizations
    .map((w) => w.id)
    .slice()
    .sort()
    .join('\0');
  if (key === _lastOrganizationIdsKey) return;
  _lastOrganizationIdsKey = key;

  const validIds = new Set(organizations.map((w) => w.id));
  const { selectionByOrganization } = useSpaceListStore.getState();
  const cleanedMap: OrganizationSpaceSelectionMap = {};
  let changed = false;
  for (const [organizationId, selection] of Object.entries(selectionByOrganization)) {
    if (validIds.has(organizationId)) {
      cleanedMap[organizationId] = selection;
    } else {
      changed = true;
    }
  }
  if (changed) {
    useSpaceListStore.setState({ selectionByOrganization: cleanedMap });
  }
});

registerResetAction('space-list', 'reset', () =>
  useSpaceListStore.getState().clearSelection(),
);
