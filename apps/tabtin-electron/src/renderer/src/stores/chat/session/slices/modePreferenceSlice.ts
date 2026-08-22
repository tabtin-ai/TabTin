import { useSpaceStore } from '@stores/useSpaceStore'
import { isConversationDraftScopeKey } from '@/lib/conversationDraftScopeKey'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import {
  resolveApprovalModeName,
  type AgentModeName,
  type ApprovalModeName,
} from '../../shared/types'
import {
  getAgentModeResolutionContextForSession,
  normalizeAgentModeForContext,
} from '../../group/groupRuntimeContext'
import { writeAgentDefaultMode } from '../agentModePreference'
import {
  syncDraftModeIntent,
  syncModeIntentForBoundSession,
} from '../draftMessageSessionCoordinator'
import { getDraftSessionBySessionId } from '../draftSession'
import { buildDraftMessageSessionContext } from '../draftMessageLegacyAdapter'
import { narrowGet, narrowSet, type AssertSliceOf } from '../../shared/sliceAdapters'

/**
 * 由 useChatStore bootstrap 注入，避免本 slice 静态 import sessionAgentMode
 * （sessionAgentMode → useChatStore → modePreferenceSlice 成环）。
 */
type SessionModeApplier = (sessionId: string, mode: AgentModeName) => void
let applySessionAgentMode: SessionModeApplier = () => {
  /* unbound until store bootstrap */
}

export function bindModePreferenceSessionModeApplier(fn: SessionModeApplier): void {
  applySessionAgentMode = fn
}

export interface SetAgentModeOptions {
  /**
   * Composer 显式 opaque draftScopeKey。
   * 禁止从 selectedSpace 重建领域主键（Project scope ≠ execution Workspace）。
   */
  draftScopeKey?: string | null
  /** @legacy 仅用于推导隐藏预建 session 指针，不作 draftMessage 主键 */
  legacyExecutionHostId?: string | null
  /**
   * ：显式目标 session（ModeSwitch 卡片等）。
   * 优先于 currentSessionId，避免卡片会话与当前会话不一致时写错 map。
   */
  sessionId?: string | null
}

export interface ModePreferenceSliceStore {
  currentSessionId: string | null
  /** 草稿 UI 标记（ 后草稿无预建 session，intent 记在 draftMessage、首发 commit 应用） */
  draftSessionBySpaceId: Record<string, boolean>
  currentSessionIdBySpaceId: Record<string, string | null>
  agentMode: AgentModeName
  setAgentMode: (mode: AgentModeName, options?: SetAgentModeOptions) => void
  approvalMode: ApprovalModeName
  approvalModeBySessionId: Record<string, ApprovalModeName>
  setApprovalMode: (mode: ApprovalModeName) => void
  pendingApprovalBySessionId: Record<string, unknown>
  approvalSubmittingBySessionId: Record<string, boolean>
}

export function createModePreferenceActions(
  get: () => ModePreferenceSliceStore,
  set: (partial: Partial<ModePreferenceSliceStore>) => void,
) {
  return {
    agentMode: 'agent' as AgentModeName,
    setAgentMode: (mode: AgentModeName, options?: SetAgentModeOptions) => {
      const state = get()
      const currentSessionId = state.currentSessionId
      const runtimeState = useChatRuntimeStore.getState()
      const spaceState = useSpaceStore.getState()
      // /#7067：领域主键必须是调用方显式 draftScopeKey；禁止从 selectedSpace 重建。
      const draftScopeKey = (
        options?.draftScopeKey && isConversationDraftScopeKey(options.draftScopeKey)
      )
        ? options.draftScopeKey
        : null
      // 隐藏 session 指针仍可按 legacy host 查；无显式 host 时用 selectedSpace 仅作指针查找
      const pointerHostId = options?.legacyExecutionHostId
        ?? spaceState.selectedSpace?.id
        ?? null
      const legacyPointers = {
        draftSessionBySpaceId: state.draftSessionBySpaceId ?? {},
        currentSessionIdBySpaceId: state.currentSessionIdBySpaceId ?? {},
      }
      const syncCtx = draftScopeKey
        ? buildDraftMessageSessionContext({
            draftScopeKey,
            legacyExecutionHostId: pointerHostId,
            pointers: legacyPointers,
          })
        : null
      const explicitSessionId = options?.sessionId?.trim() || null
      const hiddenDraftSessionId = currentSessionId
        ? null
        : (syncCtx?.hiddenSessionId ?? null)
      // ：ModeSwitch 等调用方可显式指定 session，优先于 currentSessionId。
      const targetSessionId = explicitSessionId ?? currentSessionId ?? hiddenDraftSessionId
      const targetCtx = getAgentModeResolutionContextForSession(targetSessionId)
      const modeToApply = normalizeAgentModeForContext(mode, targetCtx)
      const fallbackChanged = state.agentMode !== modeToApply
      const runtimeChanged = targetSessionId
        ? runtimeState.agentModeBySessionId[targetSessionId] !== modeToApply
        : false

      if (!fallbackChanged && !runtimeChanged) return

      if (fallbackChanged) {
        set({ agentMode: modeToApply })
      }
      // ：显式 sessionId 优先于 currentSessionId；无绑定 session 时走草稿 syncCtx。
      const writeSessionId = explicitSessionId ?? currentSessionId
      if (writeSessionId && runtimeChanged) {
        if (getDraftSessionBySessionId(writeSessionId)) {
          syncModeIntentForBoundSession(writeSessionId, modeToApply)
        } else {
          applySessionAgentMode(writeSessionId, modeToApply)
        }
      } else if (!writeSessionId && syncCtx) {
        syncDraftModeIntent(modeToApply, syncCtx)
      }

      writeAgentDefaultMode(spaceState.selectedAgent?.id, modeToApply)

      const approvalSessionId = writeSessionId
      if (approvalSessionId) {
        const s = get()
        if (s.pendingApprovalBySessionId[approvalSessionId]) {
          const nextPending = { ...s.pendingApprovalBySessionId }
          delete nextPending[approvalSessionId]
          const nextSubmitting = { ...s.approvalSubmittingBySessionId }
          delete nextSubmitting[approvalSessionId]
          set({
            pendingApprovalBySessionId: nextPending,
            approvalSubmittingBySessionId: nextSubmitting,
          })
        }
      }

      if (targetSessionId) {
        const fromMode = runtimeState.agentModeBySessionId[targetSessionId] ?? state.agentMode
        void import('@/services/modeSwitchExecuteApi')
          .then(({ notifyModeSwitched }) =>
            notifyModeSwitched({
              sessionId: targetSessionId,
              fromMode,
              toMode: modeToApply,
            }),
          )
          .catch(() => {
            /* fail-soft：UI 切换主路径不应被 IPC 失败阻断 */
          })
      }
      // ：已绑定正式 session 时即时 PUT agent_mode，供跨端对齐。
      // DraftMessage / 隐藏预建不写库（首发 create 会带上）。
      // UpdateSession 只接受 selectable 四档；study/yolo 不写库（避免 422）。
      const syncAgentMode =
        modeToApply === 'ask' ||
        modeToApply === 'agent' ||
        modeToApply === 'plan' ||
        modeToApply === 'group'
          ? modeToApply
          : null
      if (writeSessionId && !getDraftSessionBySessionId(writeSessionId) && syncAgentMode) {
        void import('@/services/chatApi')
          .then(({ getChatClient }) =>
            getChatClient().sessions.update(writeSessionId, { agent_mode: syncAgentMode }),
          )
          .then(async (updated) => {
            const { useChatStore } = await import('../../useChatStore')
            useChatStore.getState().updateSessionInCaches(writeSessionId, {
              agent_mode: updated.agent_mode ?? syncAgentMode,
            })
          })
          .catch(() => {
            /* fail-soft：本机 UI 已切换，跨端同步失败不阻断 */
          })
      }
      // ：模式选择器本身即状态反馈，切换成功不再额外弹 toast。
    },

    approvalMode: 'always_ask' as ApprovalModeName,
    approvalModeBySessionId: {} as Record<string, ApprovalModeName>,
    setApprovalMode: (mode: ApprovalModeName) => {
      const modeToApply = resolveApprovalModeName(mode, 'always_ask')
      const state = get()
      const currentSessionId = state.currentSessionId
      if (state.approvalMode !== modeToApply) {
        set({ approvalMode: modeToApply })
      }
      if (currentSessionId) {
        // ：Workspace.approval_grant 是唯一权限数据源。保留此 action 与 IPC
        // payload 仅作旧调用方兼容，主进程收到通知后重新读取 Workspace 授权档。
        void import('@/services/approvalModeSyncApi')
          .then(({ notifyApprovalModeChanged }) =>
            notifyApprovalModeChanged({
              sessionId: currentSessionId,
              approvalMode: modeToApply,
            }),
          )
          .catch(() => {
            /* fail-soft */
          })
      }
    },
  }
}

export function createModePreferenceActionsForStore<RootState extends ModePreferenceSliceStore>(
  rootGet: () => RootState,
  rootSet: (partial: Partial<RootState> | ((state: RootState) => Partial<RootState>)) => void,
) {
  type _Check = AssertSliceOf<ModePreferenceSliceStore, RootState>
  return createModePreferenceActions(
    narrowGet<RootState, ModePreferenceSliceStore>(rootGet),
    narrowSet<RootState, ModePreferenceSliceStore>(rootSet),
  )
}
