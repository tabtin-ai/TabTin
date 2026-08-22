/**
 * chatSessionNavigation — 进入 Agent Chat 会话的统一入口
 *
 * 职责：编排 Space 选中 → 会话桶识别 → 上下文归一化 → 辅助面板关闭 → session 选中。
 * 任何「从外部跳入某条 Chat 会话」的路径都应通过本模块，
 * 避免分散实现导致状态分叉。
 */

import { toast } from '@tabtin/smartsheet-ui/toast';
import { ChatAPIError } from '@tabtin/chat-client';
import type { ChatSession } from '@tabtin/chat-client';
import { resolveSessionScopeId } from '@tabtin/app-shell';
import i18n from '@/i18n';
import { useChatStore, DEFAULT_CONTEXT_WINDOW_SIZE } from '@stores/chat/useChatStore';
import { useUIStore } from '@stores/useUIStore';
import { useMainNavStore } from '@stores/useMainNavStore';
import { useAppPageStore } from '@stores/useAppPageStore';
import { useComposerPresetStore } from '@stores/useComposerPresetStore';
import { getChatClient } from '@/services/chatApi';
import { logger } from '@/utils/logger';
import {
  beginOpenChatSessionIntent,
  clearOpenChatSessionIntent,
} from '@/stores/chat/session/openChatSessionIntent';
import { ensureSpaceSelectedWithFeedback } from './spaceNavigation';
import type { SpaceNavigationFailureToast } from './spaceNavigation';
import type { PresetTriggerContext } from '@/components/chat/composer-presets/registry/types';
import type { SharedSessionAccessDescriptor } from '@/stores/chat/session/sessionAccessStore';

export interface EnterChatSessionPreserve {
  /** 保留碎片笔记面板 */
  memo?: boolean;
}

export interface ComposerPresetOption {
  presetId: string;
  triggerContext?: PresetTriggerContext;
  initialState?: Record<string, unknown>;
}

export interface EnterChatSessionOptions {
  organizationId?: string;
  failureToast?: SpaceNavigationFailureToast;
  /** 进入会话时 selectSession 失败后的提示文案 */
  sessionFailureMessage?: string;
  /** 会话已删除（404）时的提示文案；缺省回退到 sessionFailureMessage / openFailed */
  sessionNotFoundMessage?: string;
  /**
   * 强制向服务端确认会话仍存在（通知历史跳转用）。
   * 本地列表可能仍缓存已删会话，不探测会静默进入空会话。
   */
  verifySessionExists?: boolean;
  /** 指定哪些辅助面板在进入会话后保持打开，未列出的默认关闭 */
  preserve?: EnterChatSessionPreserve;
  /** 进入会话后自动激活的 Composer Preset */
  composerPreset?: ComposerPresetOption;
  sharedAccess?: Omit<SharedSessionAccessDescriptor, 'sessionId'>;
  draftScopeKey?: string;
  /** 回看历史会话时，从第一条用户消息开始阅读；普通进入仍默认展示最新消息。 */
  initialScroll?: 'first-message';
  /** 进入会话时的初始消息页；续接新任务需要直接展示冻结快照最新上下文。 */
  initialMessagePage?: 'default' | 'latest';

  // ── 消息锚定跳转（PRD 3.5；统一搜索 Wave 3 启用） ──
  /** 进入会话后定位到此 messageId */
  messageId?: string;
  /**
   * 锚定后是否高亮 1.5s（默认：传了 messageId 即 true）。
   * 由 MessageList 的现有 highlight pulse 实现兜底。
   */
  highlightMessage?: boolean;
  /**
   * 命中消息内的关键词（多个）。
   * Wave 3 仅透传到 store；MessageBubble 关键词二次高亮列入 R3-xx 待 Wave 5。
   */
  highlightTerms?: string[];
  /**
   * 锚定时若消息不在当前加载窗口，期望加载该消息前后 N 条上下文。
   * Wave 3 后端 `/api/conversations/sessions/{id}/messages` 暂未支持 around=
   * 参数，本字段透传到 store；store 在消息缺失时仅 toast，
   * 待 Wave 5 后端补 around 端点后再启用真实的窗口加载。
   */
  loadContextWindow?: number;
}

let _enterSeq = 0;

/**
 * TS-29：保证「带外」会话在 selectSession 之前已被 store 识别。
 *
 * 主会话列表（loadSessions, include_tracker_runs=false）刻意不含 Tracker Run
 * 会话，只在「自动化任务执行记录」折叠分组里懒加载。从 Tracker 详情页直接跳入
 * 一条 Run 会话时，它既不在 sessionsBySpaceId 也未必在 trackerRunSessionsBySpaceId，
 * 于是 ChatPanel 生命周期的「草稿回退」判定会把它当未知 session 踢回草稿态
 * （详见 useChatPanelLifecycle.ts 会话初始化 effect）。
 *
 * 这里在选中前补一次 session 详情，若确为 Tracker Run（带 tracker_run 字段）就
 * 注入 Tracker 分桶；普通会话则注入主会话桶。这样生命周期判定能识别它、不回退。
 *
 * 关键时序（race-free）：注入在 selectSession 设置 currentSessionId 之前完成。
 * 生命周期判定在同一个 store 快照里同时读 currentSessionId 与分桶——只要它看到
 * currentSessionId 已是该 Run 会话，就必然也看到分桶里已注入它，故不会误回退。
 *
 * 仅对「两个分桶都查不到」的未知 session 触发网络请求；左栏正常会话已在主列表，
 * 不会产生额外开销。
 */
async function ensureSessionRecognizedByLifecycle(
  spaceId: string,
  sessionId: string,
  options?: {
    prefetchedSession?: ChatSession;
    isCurrent?: () => boolean;
    shareId?: string;
  },
): Promise<'ok' | 'not_found' | 'unknown'> {
  if (options?.isCurrent?.() === false) return 'unknown';
  const store = useChatStore.getState();
  // 强校验入口已经拿到权威 Tracker metadata 时，即使旧版本曾把同 id 会话
  // 污染进普通桶，也必须经过 upsertTrackerRunSession 自愈分桶，不能因“已识别”
  // 早返而继续读取缺少 agent_id / tracker_run 的旧快照。
  if (options?.prefetchedSession?.tracker_run) {
    const sessionScopeId = resolveSessionScopeId(options.prefetchedSession);
    if (!sessionScopeId) {
      logger.warn('[enterChatSession] Tracker 会话详情缺少 Space 归属，跳过分桶注入', {
        spaceId,
        sessionId,
      });
      return 'unknown';
    }
    if (sessionScopeId !== spaceId) {
      logger.warn('[enterChatSession] Tracker 会话所属 Space 与目标 Space 不一致，跳过分桶注入', {
        spaceId,
        sessionId,
        sessionSpaceId: sessionScopeId,
      });
      return 'ok';
    }
    store.upsertTrackerRunSession(spaceId, options.prefetchedSession);
    return 'ok';
  }
  const inMainList = (store.sessionsBySpaceId[spaceId] ?? []).some(s => s.id === sessionId);
  const inTrackerBucket = (store.trackerRunSessionsBySpaceId[spaceId] ?? []).some(s => s.id === sessionId);
  if (inMainList || inTrackerBucket) return 'ok';

  try {
    const session = options?.prefetchedSession ?? await getChatClient().sessions.get(
      sessionId,
      options?.shareId ? { shareId: options.shareId } : undefined,
    );
    if (options?.isCurrent?.() === false) return 'unknown';
    const sessionScopeId = resolveSessionScopeId(session);
    // 强校验拿到的详情若没有归属，不能把它按引用中的旧 Space 写入本地桶。
    if (options?.prefetchedSession && !sessionScopeId) {
      logger.warn('[enterChatSession] 会话详情缺少 Space 归属，跳过分桶注入', { spaceId, sessionId });
      return 'unknown';
    }
    if (sessionScopeId && sessionScopeId !== spaceId && !options?.shareId) {
      logger.warn('[enterChatSession] 会话所属 Space 与目标 Space 不一致，跳过分桶注入', {
        spaceId,
        sessionId,
        sessionSpaceId: sessionScopeId,
      });
      return 'ok';
    }

    if (session.tracker_run) {
      useChatStore.getState().upsertTrackerRunSession(spaceId, session);
      return 'ok';
    }

    const latestStore = useChatStore.getState();
    const current = latestStore.sessionsBySpaceId[spaceId] ?? [];
    if (!current.some(s => s.id === sessionId)) {
      // v1 共享任务保留 session.workspace_id 的原始执行归属；这里的
      // spaceId 只是接收者当前原生 Chat 的展示宿主，使生命周期能识别带外会话。
      latestStore.setSpaceSessions(spaceId, [session, ...current], false);
    }
    return 'ok';
  } catch (error) {
    if (error instanceof ChatAPIError && error.statusCode === 404) {
      logger.warn('[enterChatSession] 目标会话不存在（已删除）', { spaceId, sessionId });
      return 'not_found';
    }
    // 识别失败不阻断进入会话——最坏退化回原有行为（可能闪一下草稿），不影响数据。
    logger.warn('[enterChatSession] 预取带外会话详情失败，跳过分桶注入', { spaceId, sessionId, error });
    return 'unknown';
  }
}

async function ensureSpaceSessionsLoaded(
  spaceId: string,
  organizationId?: string,
): Promise<void> {
  // ：与侧栏 / ChatPanel 一致，始终走 loadSessions SWR；
  // 勿因空数组桶存在而短路，否则冷启动后历史会话无法回填。
  try {
    await useChatStore.getState().loadSessions(spaceId, organizationId);
  } catch (error) {
    logger.warn('[enterChatSession] 加载目标 Space 会话列表失败，继续尝试直接进入会话', {
      spaceId,
      organizationId,
      error,
    });
  }
}

/**
 * 进入 Agent Chat 会话的统一入口。
 *
 * 完整流程：
 *  1. 选中 Space（selectSpaceBySpaceId，数据未加载则兜底重加载）
 *  2. 确保目标 Space 的会话桶已加载，fresh 外部入口不会被生命周期回退到草稿
 *  3. 关闭辅助面板（Memo，除非 preserve 指定保留）；钉回 agent tab；
 *     关闭技能库/自动化/协作等全屏 App 页（保留 Project 沉浸，其聊天 rail 与画布并排）
 *  4. 选中指定 session（useChatStore.selectSession）
 *
 * 注：历史上这里还有一步「归一化工作台 → Space Home」（setActiveKey(spaceId, null)），
 * 标签桶 scope 化后该写入落在没人读的 legacy per-space 桶、静默失效多时；且若改写到
 * scope 桶会把用户从当前 App 拽走，违反正典 §7.2 律 1「唤起不流放」（同款清理见
 * ）。 起连同 preserve.contextTab 开关一并删除——进会话不再动工作台标签。
 * 但全屏 App 页会把 workbenchMode 钉在 app-page 且 chatPanelEnabled=false，
 * 仅 setCurrentTab('agent') 无法露出对话；须 closeAppPage，与 navigateToNewTask 对齐。
 *
 * 返回 enterSeq（正整数）表示成功，0 表示失败（Space 不存在 / selectSession 异常）。
 * 调用方可用 enterSeq 判断自己是否仍是「最新一次进入」，解决快速连续点击竞态。
 */
export async function enterChatSession(
  spaceId: string,
  sessionId: string,
  options: EnterChatSessionOptions = {},
): Promise<number> {
  const seq = ++_enterSeq;
  let token = beginOpenChatSessionIntent(spaceId, sessionId);
  let targetSpaceId = spaceId;
  let prefetchedSession: ChatSession | undefined;
  let sessionVerificationFailed = false;
  logger.debug('[enterChatSession] start', { spaceId, sessionId, seq })
  try {

  // 外部引用携带的 Space 可能已过期。强校验时先读取会话详情，以服务端归属
  // 作为后续选 Space、加载列表和分桶注入的唯一依据，避免把会话写入旧 Space。
  if (options.verifySessionExists) {
    try {
      prefetchedSession = await getChatClient().sessions.get(
        sessionId,
        options.sharedAccess?.shareId ? { shareId: options.sharedAccess.shareId } : undefined,
      );
      if (seq !== _enterSeq) return 0;
      if (!options.sharedAccess && prefetchedSession.space_id && prefetchedSession.space_id !== spaceId) {
        targetSpaceId = prefetchedSession.space_id;
        // 只有这次导航仍是最新，才把 intent 改钉到实际 Space；过期请求
        // 不得覆盖后一次点击已经钉住的目标。
        if (seq === _enterSeq) {
          token = beginOpenChatSessionIntent(targetSpaceId, sessionId);
        }
        logger.warn('[enterChatSession] 引用 Space 已过期，使用会话实际归属', {
          spaceId,
          sessionId,
          sessionSpaceId: targetSpaceId,
        });
      }
    } catch (error) {
      if (seq !== _enterSeq) return 0;
      if (error instanceof ChatAPIError && error.statusCode === 404) {
        toast.error(
          options.sessionNotFoundMessage
          ?? options.sessionFailureMessage
          ?? i18n.t('settings:notification.navigateSessionDeleted', {
            defaultValue: '该对话已被删除，无法跳转',
          }),
        );
        return 0;
      }
      // 预检异常时维持既有降级：继续按引用定位进入；后续不再重试详情或基于未知归属写入分桶。
      sessionVerificationFailed = true;
      logger.warn('[enterChatSession] 会话归属预检失败，按引用定位继续进入', {
        spaceId,
        sessionId,
        error,
      });
    }
  }

  // 1. 选中服务端确认后的目标 Space
  if (seq !== _enterSeq) return 0;
  const selected = await ensureSpaceSelectedWithFeedback(targetSpaceId, {
    organizationId: options.organizationId,
    failureToast: options.failureToast,
    isCurrent: () => seq === _enterSeq,
  });
  if (seq !== _enterSeq || !selected) return 0;

  // 2. fresh 外部入口没有 sessionsBySpaceId，先让生命周期能识别目标 session。
  await ensureSpaceSessionsLoaded(targetSpaceId, options.organizationId);
  if (seq !== _enterSeq) return 0;

  // 3. 关闭辅助面板并回到任务域（closeMemo 已不再改 mainNav，须显式钉 agent）
  if (!options.preserve?.memo) {
    useUIStore.getState().closeMemo();
  }
  useMainNavStore.getState().setCurrentTab('agent');
  // 全屏 App 页（技能库/自动化/协作）打开时 workbenchMode=app-page 且聊天 rail
  // 关闭；openAppPage 本身已把 mainNav 钉成 agent，再 setCurrentTab 无效。
  // Project 沉浸例外：聊天 rail 与画布并排，关页会打断沉浸（对齐 navigateToNewTask）。
  if (useAppPageStore.getState().activePage !== 'project') {
    useAppPageStore.getState().closeAppPage();
  }

  // 3.5 TS-29：带外会话（如 Tracker Run）在选中前先确保被 store 识别，
  //      避免被 ChatPanel 生命周期的草稿回退逻辑踢回新对话草稿态。
  //      同时用 sessions.get 探测 404，区分「会话已删除」与普通打开失败。
  const recognition = sessionVerificationFailed
    ? 'unknown'
    : await ensureSessionRecognizedByLifecycle(targetSpaceId, sessionId, {
      // 已预检成功时复用权威会话，避免二次请求。
      prefetchedSession,
      isCurrent: () => seq === _enterSeq,
      shareId: options.sharedAccess?.shareId,
    });
  if (seq !== _enterSeq) return 0;
  if (recognition === 'not_found') {
    toast.error(
      options.sessionNotFoundMessage
      ?? options.sessionFailureMessage
      ?? i18n.t('settings:notification.navigateSessionDeleted', {
        defaultValue: '该对话已被删除，无法跳转',
      }),
    );
    return 0;
  }

  // 4. 选中 session
  if (seq !== _enterSeq) return 0;
  try {
    const selectionOptions = (
      options.draftScopeKey !== undefined
      || options.sharedAccess !== undefined
      || options.initialMessagePage !== undefined
    )
      ? {
          draftScopeKey: options.draftScopeKey,
          sharedAccess: options.sharedAccess,
          initialMessagePage: options.initialMessagePage,
        }
      : undefined;
    await useChatStore.getState().selectSession(targetSpaceId, sessionId, selectionOptions);
    if (seq !== _enterSeq) return 0;
    logger.info('[enterChatSession] session-first-paint', { spaceId: targetSpaceId, sessionId, seq });
  } catch (error) {
    // 后一次点击已接管导航时，旧请求的迟到失败不能打断当前会话。
    if (seq !== _enterSeq) return 0;
    logger.error('[enterChatSession] selectSession failed', { spaceId, sessionId, error })
    const isNotFound = error instanceof ChatAPIError && error.statusCode === 404;
    toast.error(
      isNotFound
        ? (options.sessionNotFoundMessage
          ?? options.sessionFailureMessage
          ?? i18n.t('settings:notification.navigateSessionDeleted', {
            defaultValue: '该对话已被删除，无法跳转',
          }))
        : (options.sessionFailureMessage
          ?? i18n.t('sidebar:conversations.openFailed', {
            defaultValue: '打开对话失败，请重试',
          })),
    );
    return 0;
  }

  // 自动化执行记录属于“回看一次完整执行”，默认落在对话底部会把长结果的正文
  // 推到视口上方。selectSession 已完成消息恢复，此时用统一消息锚点定位第一条
  // 用户指令；普通会话入口不传该意图，继续保持“展示最新消息”的既有行为。
  if (options.initialScroll === 'first-message' && !options.messageId) {
    const state = useChatStore.getState();
    const messages = state.messagesBySessionId[sessionId] ?? [];
    const firstReadableMessage = messages.find(message => message.role === 'user')
      ?? messages.find(message => message.role !== 'system')
      ?? messages[0];
    if (firstReadableMessage) {
      state.scrollToMessage(sessionId, firstReadableMessage.id, {
        highlight: false,
        highlightTerms: undefined,
        loadContextWindow: DEFAULT_CONTEXT_WINDOW_SIZE,
      });
    }
  }

  // 5. 激活 Composer Preset（如果指定）
  if (seq !== _enterSeq) return 0;
  if (options.composerPreset) {
    const { presetId, triggerContext, initialState } = options.composerPreset;
    useComposerPresetStore.getState().addPreset(sessionId, presetId, triggerContext, initialState);
  }

  // 6. 消息锚定跳转（PRD 3.5）
  if (seq !== _enterSeq) return 0;
  if (options.messageId) {
    useChatStore.getState().scrollToMessage(sessionId, options.messageId, {
      highlight: options.highlightMessage ?? true,
      highlightTerms: options.highlightTerms,
      loadContextWindow: options.loadContextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE,
    });
  }

  logger.debug('[enterChatSession] done', { spaceId: targetSpaceId, sessionId, seq })
  return seq;
  } finally {
    clearOpenChatSessionIntent(token);
  }
}

/** 检查给定的 seq 是否仍是最新一次 enterChatSession 调用 */
export function isLatestEnter(seq: number): boolean {
  return seq === _enterSeq;
}
