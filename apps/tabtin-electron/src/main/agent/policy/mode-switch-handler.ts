/**
 * ModeSwitchHandler — Phase 3 模式切换的状态机集中地。
 *
 * 承担的四件事（Phase 3 F5/F7/F12/F13 合并重构后）：
 *   1. **proposal 注册** — 给 `createSwitchModeTool` 的 `deps.proposalRegistry`
 *      提供同 session dedup（F7）：同 session 已有未 resolved proposal 时拒新调用。
 *   2. **proposal 校验 + resolve** — `handleExecute(payload)` 校验 IPC 传入的
 *      `proposal_id` 必须在注册表中（F5 防伪 ID + 防 double-approve）；批准
 *      时连带 cancel 当前 session 的 pending HITL + 记录 mode transition reminder。
 *   3. **手动 UI 切换通知** — `notifyManualSwitch(sessionId, fromMode, toMode)`
 *      让 renderer 通过 IPC 主动调用，用以：
 *        a. 任意 mode 切换时 cancel 当前 session 的 pending HITL（F8）；
 *        b. 任意合法 mode 切换后记录一次 mode transition reminder（F9）；
 *        c. 清掉残留的 mode-switch proposal（避免老卡片复活）。
 *   4. **薄层 host wrapper** — `ElectronAgentHost.handleModeSwitchExecute` 改为
 *      thin wrapper，把所有业务搬到本 handler，便于单测 + 解除 host 巨石。
 *
 * F13：原 `modeTransitionReminder: true` 字段 renderer 不消费，已删除；
 *      实际副作用通过 `setPendingModeTransition` callback 在主进程内部完成。
 */

import { createLogger } from '../../logger.js'
import { isAgentModeName, type AgentModeName } from '@tabtin/agent-modes'
import {
  cancelAllPendingHitlRequests,
  type PendingHitlMap,
} from '@tabtin/agent-runtime'
import type { SwitchModeProposalRegistry } from '@tabtin/agent-runtime/tools'

const log = createLogger('ModeSwitch')

export type ModeSwitchOutcome = 'approved' | 'cancelled'

export interface ModeSwitchExecuteOptions {
  sessionId: string
  proposalId: string
  outcome: ModeSwitchOutcome
}

export interface ModeSwitchExecuteResult {
  success: boolean
  outcome?: ModeSwitchOutcome
  /**
   * ：校验通过的切换方向（approve 路径必带）。host 拿它调
   * `reconfigureSessionModeInPlace(session, transition.toMode)` 做**轮内**热切换，
   * 再 resolve switch_mode 工具阻塞的 HITL waiter。
   */
  transition?: { fromMode: AgentModeName; toMode: AgentModeName }
  error?: string
}

export interface ModeSwitchHandlerOptions {
  /** ElectronAgentHost.pendingHitlRequests —— handler 直接 cancel 当前 session 的 batch */
  hitlMap: PendingHitlMap
  /** Host 暴露的标记设置器（最终落到 HostState.pendingModeTransition） */
  setPendingModeTransition(
    sessionId: string,
    transition: { fromMode: AgentModeName; toMode: AgentModeName },
  ): void
  /**
   * ：用户经 UI 主动切 mode 时同步 Host sticky（含切回 plan）。
   * 缺省 no-op，便于旧测试。
   */
  setModeAuthoritySticky?(sessionId: string, mode: AgentModeName): void
}

interface PendingProposalEntry {
  createdAt: number
  /** 该 proposal 的切换方向（工具注册时写入）；批准时据此 setPendingModeTransition。 */
  transition?: { fromMode: AgentModeName; toMode: AgentModeName }
}

/**
 * Session 级 mode-switch proposal 注册中心 + IPC 执行入口。
 */
export class ModeSwitchHandler {
  /** Map<sessionId, Map<proposalId, PendingProposalEntry>> */
  private readonly pending = new Map<string, Map<string, PendingProposalEntry>>()

  constructor(private readonly options: ModeSwitchHandlerOptions) {}

  // ─── proposal 注册中心（供 createSwitchModeTool 调用） ──────────

  /**
   * 把本 handler 暴露成 SwitchModeProposalRegistry 形态注入工具 deps。
   *
   * `registerPending`：同 session 已有未 resolved → 返回 existingProposalId（dedup）；
   *   否则注册新 proposalId 并放行（工具 emit 事件）。
   */
  asProposalRegistry(): SwitchModeProposalRegistry {
    return {
      registerPending: (sessionId, proposalId, transition) => {
        const bucket = this.pending.get(sessionId)
        if (bucket && bucket.size > 0) {
          // 取最早一个（理论上 size===1，因为我们 dedup；防御性处理）
          const [existing] = bucket.keys()
          return { ok: false, existingProposalId: existing! }
        }
        // 仅接受合法的 AgentMode 名，避免把任意字符串带进 setPendingModeTransition。
        const from =
          transition && isAgentModeName(transition.fromMode)
            ? transition.fromMode
            : undefined
        const to =
          transition && isAgentModeName(transition.toMode)
            ? transition.toMode
            : undefined
        const next = bucket ?? new Map<string, PendingProposalEntry>()
        next.set(proposalId, {
          createdAt: Date.now(),
          transition: from && to ? { fromMode: from, toMode: to } : undefined,
        })
        this.pending.set(sessionId, next)
        return { ok: true }
      },
      // P2 修复（2026-05-28）：emit fail 时由工具调用回滚。幂等：proposal
      // 不存在 / session bucket 已空都 no-op，防 emit 失败但 proposal 永久残留
      // 导致后续 switch_mode 被 F7 already_pending 误挡。
      unregister: (sessionId, proposalId) => {
        const bucket = this.pending.get(sessionId)
        if (!bucket) return
        bucket.delete(proposalId)
        if (bucket.size === 0) this.pending.delete(sessionId)
      },
    }
  }

  // ─── 测试 / 观察接口 ──────────────────────────────────────────

  hasPendingProposal(sessionId: string, proposalId: string): boolean {
    return this.pending.get(sessionId)?.has(proposalId) === true
  }

  /** 仅测试用：检查 session 里有多少 pending proposal。 */
  countPendingProposalsForSession(sessionId: string): number {
    return this.pending.get(sessionId)?.size ?? 0
  }

  // ─── proposal 校验 + 执行（IPC handler 调用） ────────────────────

  /**
   * 校验 `agent-engine:mode-switch-execute` IPC 的 proposalId（F5：防伪 ID +
   * 防 double-approve），并取出切换方向。
   *
   *  重构：本方法**不再有副作用**（不 cancel HITL、不 setPendingModeTransition）。
   * switch_mode 已改为阻塞式 HITL 工具——真正的模式切换由 host 在
   * `handleModeSwitchExecute` 里 `reconfigureSessionModeInPlace` 完成，再 resolve
   * 工具阻塞的 waiter。本方法只负责校验 + 返回 transition + 从注册表移除（防重复批准）。
   */
  handleExecute(payload: ModeSwitchExecuteOptions): ModeSwitchExecuteResult {
    const { sessionId, proposalId, outcome } = payload
    if (!sessionId || !proposalId) {
      return {
        success: false,
        outcome,
        error: 'sessionId and proposalId are required',
      }
    }

    // F5: 校验 proposalId 必须在 registry 内（伪造 / 过期 / 已 resolve 都拒）
    const bucket = this.pending.get(sessionId)
    if (!bucket || !bucket.has(proposalId)) {
      log.warn(
        `[mode-switch-execute] unknown or already-resolved proposal session=${sessionId.slice(0, 8)}… proposal=${proposalId.slice(0, 8)}…`,
      )
      return {
        success: false,
        outcome,
        error: 'Unknown or expired mode-switch proposal',
      }
    }

    // 先取出方向再删除；approve 路径 host 要用它做 reconfigure。
    const entry = bucket.get(proposalId)
    // 不论 approve/cancel，立即移除 proposal 防 double-approve。
    bucket.delete(proposalId)
    if (bucket.size === 0) this.pending.delete(sessionId)

    if (outcome === 'cancelled') {
      log.info(
        `[mode-switch-execute] cancelled session=${sessionId.slice(0, 8)}… proposal=${proposalId.slice(0, 8)}…`,
      )
      return { success: true, outcome: 'cancelled' }
    }

    if (outcome !== 'approved') {
      return {
        success: false,
        outcome,
        error: `Unknown outcome: ${String(outcome)}`,
      }
    }

    // approve：返回校验后的切换方向；缺省回退 plan→agent（历史单向兜底）。
    const transition = entry?.transition ?? { fromMode: 'plan', toMode: 'agent' }
    log.info(
      `[mode-switch-execute] approved session=${sessionId.slice(0, 8)}… proposal=${proposalId.slice(0, 8)}… ${transition.fromMode}→${transition.toMode}`,
    )
    return {
      success: true,
      outcome: 'approved',
      transition,
    }
  }

  // ─── UI 直接切换 mode 时的通知入口（F8 + F9） ────────────────────

  /**
   * Renderer `setAgentMode` 时通过 IPC 调本方法：
   *
   * - **F8**：任何 mode 切换都 cancel 当前 session 的 pending HITL（避免老审批 dialog 挂死）。
   * - **F9**：任意合法 mode 切换后记录 from/to，让下一轮 query
   *   iteration 0 注入一次性 mode transition reminder（与 switch_mode 批准路径对称）。
   * - 清除该 session 残留的 mode-switch proposal（避免老卡片再次被批准时被 stale check 挡掉）。
   */
  notifyManualSwitch(
    sessionId: string,
    fromMode: string | undefined,
    toMode: string,
  ): { cancelledHitlBatchIds: string[]; modeTransitionReminderSet: boolean } {
    if (!sessionId) {
      return { cancelledHitlBatchIds: [], modeTransitionReminderSet: false }
    }

    // F8：cancel pending HITL（仅本 session）
    const cancelledHitlBatchIds = cancelAllPendingHitlRequests({
      hitlMap: this.options.hitlMap,
      sessionId,
      reason: 'Pending tool approval cancelled because agent mode changed.',
    })

    // F9：任意合法 mode 切换都注入一次 transition reminder。
    // 这解决 ask→agent 时历史 Ask 自述污染的问题，也让 agent→ask/plan 等反向切换
    // 在下一轮明确收紧能力边界。非法/未知 mode 忽略，避免把任意字符串注入 LLM 上下文。
    const from = isAgentModeName(fromMode) ? fromMode : undefined
    const to = isAgentModeName(toMode) ? toMode : undefined
    let modeTransitionReminderSet = false
    if (from && to && from !== to) {
      this.options.setPendingModeTransition(sessionId, { fromMode: from, toMode: to })
      modeTransitionReminderSet = true
    }

    // ：用户主动切 mode（含切回 plan）时同步 sticky，允许合法降档。
    if (to) {
      this.options.setModeAuthoritySticky?.(sessionId, to)
    }

    // 清除该 session 残留的 mode-switch proposal —— 用户改主意 / 直接 UI 切了
    if (this.pending.has(sessionId)) {
      this.pending.delete(sessionId)
    }

    log.info(
      `[mode-switch-notify] session=${sessionId.slice(0, 8)}… ${fromMode ?? '∅'}→${toMode} cancelledHitl=${cancelledHitlBatchIds.length} modeTransitionSet=${modeTransitionReminderSet}`,
    )
    return {
      cancelledHitlBatchIds,
      modeTransitionReminderSet,
    }
  }

  // ─── 维护：session 销毁 / host shutdown 时清理 proposal 状态 ─────

  /** 清掉所有 session 的 pending proposal（host shutdown 时调用）。 */
  clearAll(): void {
    this.pending.clear()
  }

  /**
   * 清掉某个 session 的所有 pending proposal。
   * session 销毁、Stop / 插队 abort、runtime rebuild / soft-reconfigure 时调用，
   * 避免 F7 already_pending 在 waiter 已结束后仍挡后续 switch_mode。
   */
  clearSession(sessionId: string): void {
    this.pending.delete(sessionId)
  }
}
