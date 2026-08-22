/**
 * app-shell 运行时初始化 — Electron 适配器
 *
 * 在应用启动时调用 initAppShellForElectron()，注入 Electron 特有的实现。
 */

import {
  configureAppShell,
  initAppShellStores,
  setExternalStoreAdapters,
  setAppShellLogSink,
} from '@tabtin/app-shell';
import { createLogger } from '@/utils/logger';
import { recordLog } from '@/services/logCollector';
import { apiRequest, getAuthToken } from './api-adapter-instance';
import { API_CONFIG } from '@/config/api';
import { useAuthStore } from '@/stores/useAuthStore';
import { resetChatClient } from '@/services/chatClientSingleton';
import { useCrawlTabStore } from '@/stores/useCrawlTabStore';
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore';
import { useCanvasLayoutStore } from '@/stores/useCanvasLayoutStore';
import { useChatSplitStore } from '@/stores/useChatSplitStore';
import { clearAllSplitsForSpace } from '@/utils/split-queries';
import { useIMStore } from '@/stores/useIMStore';
import { useUserProfileCache } from '@/stores/useUserProfileCache';
import { useSpaceViewPrefsStore } from '@/stores/useSpaceViewPrefsStore';
import { getOrCreateDeviceId } from '@/utils/deviceId';
import { useUIStore } from '@/stores/useUIStore';
import { collectAllDirty, saveAllDirty } from '@components/context-space/dirtyRegistry';
import { useWorkbenchSceneStore, toWorkbenchSceneId } from '@/stores/useWorkbenchSceneStore';
import { useOrganizationStore } from '@/stores/useOrganizationStore';
import { useDeviceStore } from '@/stores/useDeviceStore';
import { setOrganizationIdResolver, notifyOrganizationResolverChanged } from '@/stores/browserEnvSnapshot';
// PD-11（W6 M3）：原 desktop auth preset 渲染侧同步初始化函数已删 —— CLI client
// 不再压低 Space 的 yolo 预设。`initDesktopDevicePermissionsSync` 保留（与 yolo 正交）。
import { initDesktopDevicePermissionsSync } from './desktop-device-permissions-sync';
import { notifyWorkspacePathsForSpace } from '@components/workspace/notifyWorkspacePaths';
// ：挂接登出 / 切组织 → initCapabilityIdentity（模块副作用注册）。
import '@/services/capabilityIdentityInit';

// Workspace root fallback used to walk the folder context for the first
// kind:'sandbox' folder, but SkillPanel's "open skill folder" affordance also
// creates kind:'sandbox' folders — so the agent's cwd would silently jump
// into a skill source directory. Fallback is now centralized in the main
// process: ipc-registry.ts `space:setActive` defaults to
// `{sandbox}/agent-spaces/{spaceId}/` when organizationRoot is null.

const log = createLogger('AppShellBridge');

export function initAppShellForElectron(): void {
  // 把 app-shell（跨端共享包）的日志接进 Electron 诊断包环形缓冲——否则
  // Space/Organization 等 store 在生产环境的日志（走 app-shell 自己的 logger）
  // 进不了诊断包。web/mobile 不注入即无副作用。
  setAppShellLogSink((level, module, args) => {
    recordLog(level, module ? [`[${module}]`, ...args] : args);
  });

  configureAppShell({
    apiBaseUrl: API_CONFIG.baseURL,

    transport: async (options) => {
      const response = await apiRequest(options);
      return {
        status: response.status,
        data: response.data,
        headers: response.headers as Record<string, string> | undefined,
      };
    },

    auth: {
      getToken: async () => {
        try {
          return await getAuthToken();
        } catch {
          return null;
        }
      },
      getCurrentUserId: () => useAuthStore.getState().user?.id ?? null,
    },

    bridge: {
      setActiveSpace: (spaceId, crawlspaceId, organizationId, organizationRoot) => {
        // Pass organizationRoot through unchanged; main process applies the
        // sandbox fallback when this is null (see file header comment).
        const setActive = window.tabtin?.space?.setActive;
        const setActivePromise = setActive?.(spaceId, crawlspaceId, organizationId, organizationRoot ?? null);
        // 路径权限治理 Wave 3 修 L13 / 02 §3.2 断点 1（重启降级）+ §3.3 断点 2
        // （切 Space 不同步）+ §3.4 断点 3（切 Agent 不同步）：
        // setActive Promise resolve 之后（含 createRuntimeForSession 完成）
        // 立即推一次"该 Space 当前 store 完整快照"到 main，让 fs/git/checkpoint
        // IPC 跟 LLM 工具链路从第一秒起就拿到正确的 allowedPaths。
        //
        // 不在 setActive 之前推：那时 main 端 currentSpaceId 还没更新，
        // findSessionSnapshotByActiveSpaceId 找不到匹配 session（race）。
        // setActivePromise 包了 setActive + workspaceSnapshotV3 装配链路。
        if (setActivePromise && typeof setActivePromise.then === 'function') {
          setActivePromise
            .then(() => {
              if (typeof spaceId === 'string' && spaceId.length > 0) {
                void notifyWorkspacePathsForSpace(spaceId);
              }
            })
            .catch((err) => {
              // setActive 失败不阻塞——hydrate 也跳过；下次切换时再尝试
              log.warn('setActiveSpace 失败（跳过 hydrate，下次切换重试）:', err);
            });
        }
      },
      resetChatClient: () => resetChatClient(),
      closeAuxiliaryPanels: () => {
        useUIStore.getState().closeMemo();
      },
      purgeInvalidSpaceDerivedState: (validSpaceIds) => {
        const validSpaceIdSet = new Set(validSpaceIds);
        useSpaceContextTabsStore.getState().purgeStaleEntries(validSpaceIdSet);
        useCanvasLayoutStore.getState().purgeStaleEntries(validSpaceIdSet);
        useChatSplitStore.getState().purgeStaleEntries(validSpaceIdSet);
      },
      getCurrentDeviceId: () => useDeviceStore.getState().currentDevice?.id ?? null,
      pushHostTurnState: (payload) => {
        void import('@/services/agentConfigCacheApi')
          .then(({ pushHostTurnState }) => {
            pushHostTurnState(payload)
          })
          .catch((err) => {
            log.warn('pushHostTurnState failed (ignored):', err)
          })
      },
      resolveCrawlspaceId: (spaceId) => {
        const crawlTab = useCrawlTabStore
          .getState()
          .getSpaceCrawlspace(spaceId);
        return crawlTab?.id ?? null;
      },
      onSpaceDeleted: (spaceId) => {
        // W2.5 T9 P0-1: 这条路径同时承接两种场景：
        //   (1) 本地 UI 删除：UI 入口已 await confirmDirtyBeforeSpaceDelete，到这里时 dirty
        //       要么用户已选 'discard'，要么已 saveAll 成功；collectDirty 应为空，本兜底 no-op
        //   (2) WS 推送 'deleted'（其他端/管理员删除）：无用户交互上下文，无法弹对话框，
        //       但本端可能有 dirty 改动 → 必须自动保存兜底，避免静默丢数据
        //
        // 策略：先尝试 saveAllDirty 该 space 下所有 dirty 资源（保存失败的会留下 toast/log
        // 由 dirtyRegistry 各 provider 自行处理），再清 tab。串行 saveAllDirty 不阻塞调用方
        // （fire-and-forget），但 clearSpaceTabs 在 saveAllDirty 完成后才执行，确保保存先于销毁。
        //
        // Wave 3.2 复核加固：必须**同步**剔除 hot scene。原因：
        //   useSpaceStore.deleteSpace 删 spaces 列表 → SpaceWorkbenchHost 立即不再
        //   渲染该 Space 子树 → CrawlspaceWorkspace unmount → useRunManager cleanup。
        //   若 dirty path 把 purgeCrawlspaceData 推到 saveAllDirty.finally，cleanup 跑
        //   时 config 仍在、hot 也仍含 sceneId → workspaceRunGuard 双条件返 true →
        //   错误保活 → Run 永久泄漏。同步 removeFromHot 让 hot 这一边立即变 false，
        //   guard 直接放手 endRun。
        useWorkbenchSceneStore.getState().removeFromHot(toWorkbenchSceneId(spaceId));
        try {
          const dirty = collectAllDirty(spaceId);
          if (dirty.length > 0) {
            void saveAllDirty(dirty).finally(() => {
              clearAllSplitsForSpace(spaceId);
              useSpaceContextTabsStore.getState().clearSpaceTabs(spaceId);
              const crawlspace = useCrawlTabStore
                .getState()
                .getSpaceCrawlspace(spaceId);
              if (crawlspace?.id) {
                useCrawlTabStore.getState().purgeCrawlspaceData(crawlspace.id);
              }
            });
            return;
          }
        } catch (err) {
          log.warn('onSpaceDeleted dirty 保护失败，继续清理:', err);
        }
        clearAllSplitsForSpace(spaceId);
        useSpaceContextTabsStore.getState().clearSpaceTabs(spaceId);
        const crawlspace = useCrawlTabStore
          .getState()
          .getSpaceCrawlspace(spaceId);
        if (crawlspace?.id) {
          useCrawlTabStore.getState().purgeCrawlspaceData(crawlspace.id);
        }
      },
      // ：删 Workspace 后清本机外部导入档案（workspaceId 或同 workingDir）
      clearExternalArchivesForWorkspace: async ({
        organizationId,
        workspaceId,
        workingDir,
      }) => {
        const api = window.tabtin?.import?.deleteArchivesForWorkspace
        if (!api) return
        try {
          const res = await api({
            organizationId,
            workspaceId,
            workingDir: workingDir ?? null,
          })
          if (res?.deleted > 0) {
            log.info('已清本机外部导入档案', {
              organizationId,
              workspaceId,
              workingDir: workingDir ?? null,
              deleted: res.deleted,
            })
            try {
              const { useExternalArchiveIndexStore } = await import(
                '@components/onboarding/external-import/useExternalArchiveIndexStore'
              )
              useExternalArchiveIndexStore.getState().bump()
            } catch {
              /* 侧栏刷新非关键路径 */
            }
          }
        } catch (err) {
          log.warn('清本机外部导入档案失败（忽略）', err)
        }
      },
      getDeviceFingerprint: () => getOrCreateDeviceId(),
    },
  });

  initAppShellStores();

  // 边界改造 Phase 3a：把"当前活跃 Organization id"注入 browserEnvSnapshot，让普通
  // 浏览器（桌面 + 对话）走 Organization 级共享 cookie partition。
  // getEffectiveOrganizationId 优先 selectedOrganization，再 lastOpened，再 personal/default
  // 兜底——与桌面"当前 organization"语义一致。无 organization（未登录 / 启动早期）时
  // getOrganizationBrowserPartition 回落默认 env partition。
  setOrganizationIdResolver(() => useOrganizationStore.getState().getEffectiveOrganizationId());

  // review P1 修复：partition 升级 listener 只由 browser-env 镜像事件驱动，而普通
  // 浏览器 partition 取决于 organization（另一个 store）。订阅 organization 变化，effective
  // organization id 变化时补一次升级通知——让启动早期占位 `tabtin:env:default` 的浏览
  // view 在 organization 就绪后被升级到 organization 罐（走既有 crawl-view mismatch →
  // ViewFactory destroy+recreate 闭环）。模块级订阅，随 app 生命周期常驻。
  let lastEffectiveOrganizationId = useOrganizationStore.getState().getEffectiveOrganizationId();
  useOrganizationStore.subscribe(() => {
    const next = useOrganizationStore.getState().getEffectiveOrganizationId();
    if (next !== lastEffectiveOrganizationId) {
      lastEffectiveOrganizationId = next;
      notifyOrganizationResolverChanged();
    }
  });

  // PD-11（W6 M3）：原 desktop auth preset 渲染侧同步调用已删除 —— CLI client
  // 不再压低 Space 的 yolo 预设。device_permissions sync 保留（与 yolo 正交，
  // 规范 § 6.5 仍由这条同步来兑现 desktop_observe=block 的命令行侧拦截）。

  // TabDesktop Wave 2.1 · 规范 § 6.5：订阅 selectedAgent.agent_config.device_permissions
  // 变化，推送到主进程供 /desktop/* 路由在入口做 desktop_observe=block 判定。
  // 与 auth-preset-sync 并列（不同字段，不同路由消费点），缺任一个都会让
  // 规范 § 6.5 跨端语义打折。
  try {
    initDesktopDevicePermissionsSync();
  } catch (err) {
    log.warn('initDesktopDevicePermissionsSync failed:', err);
  }

  setExternalStoreAdapters({
    im: {
      getConversations: () => useIMStore.getState().conversations,
      getUnreadCounts: () => useIMStore.getState().unreadCounts,
      isLoading: () => useIMStore.getState().isLoadingConversations,
      getError: () => useIMStore.getState().loadError,
      openIM: () => useIMStore.getState().openIM(),
      closeIM: () => useIMStore.getState().closeIM(),
      setCurrentConversation: (id) =>
        useIMStore.getState().setCurrentConversation(id),
      isIMActive: () => useIMStore.getState().isIMActive,
      isContactsViewActive: () => useIMStore.getState().imSidebarView === 'contacts',
      getCurrentConversationId: () =>
        useIMStore.getState().currentConversationId,
      reset: () => {
        useUserProfileCache.getState().reset();
        useIMStore.getState().resetIMState();
      },
    },
    getLastUsedWorkspaceId: (organizationId) =>
      useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId(organizationId),
  });
}
