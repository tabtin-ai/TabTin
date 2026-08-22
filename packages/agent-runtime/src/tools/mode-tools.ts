/**
 * Mode 工具 — `switch_mode`（通用「提议切模式」，需用户审批）
 *
 * 机制与策略分离：本工具是通用的模式切换提议机制，能从「当前模式」切到哪些
 * 「目标模式」完全由 contract 的 `proposableTargets` 白名单驱动（经 deps.allowedTargets
 * 注入），不再硬编码 plan→agent。当前策略仅开 plan→agent（见 contract.ts）。
 *
 * 与 plan_exit 不同：本工具只发 `mode_switch_proposal` stream event，由
 * ModeSwitchProposalCard + IPC 完成 mode 切换；不注入 approved plan 上下文。
 *
 * Phase 3 修复（2026-05-28）：
 *   - F4 fail-closed：`ctx.emitStreamEvent` 缺失时返回 requires_client_approval，
 *     不再静默成功返回 pending（否则用户看不到卡片但模型以为已发出请求）。
 *   - F5 proposal_id 注册：通过 `deps.proposalRegistry` 把每个 proposal_id
 *     注册到 host，让 mode-switch-execute IPC 能校验防伪 ID + 防 double-approve。
 *   - F7 dedup：同 session 已有未 resolved proposal 时返回 `already_pending` +
 *     existing_proposal_id，告诉模型不要重复调用，等用户操作或继续 plan 工作。
 *   - 工具 **execute 一旦结束**（批准 / 拒绝 / abort HITL / 超时 / emit 失败）
 *     必须 unregister。否则 Stop、新消息插队、`cancelAllPendingHitlRequests`
 *     只 resolve waiter、不走 mode-switch-execute IPC，pending 会永久误挡
 *     后续 switch_mode。
 */

import { randomUUID } from 'node:crypto';
import { ModeSwitchProposalEvent } from '../event/events/proposal-events.js';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import type {
  InterruptPort,
} from '../engine/contracts/hitl.js';
import { jsonError } from '../capability/core/_utils.js';
import { createInterruptAdapter } from '../permissions/interrupt-adapter.js';

/**
 * 主循环构造的 ToolContext 已注入 interrupt（QueryDeps.interrupt）；直调场景
 * （测试 / 旧宿主）缺席时就地用同一个适配器包 context 原语——单一实现。
 */
function resolveInterrupt(ctx: ToolContext): InterruptPort {
  return ctx.interrupt ?? createInterruptAdapter({
    emitStreamEvent: ctx.emitStreamEvent,
    waitForUserInput: ctx.waitForUserInput,
    threadId: ctx.threadId ?? '',
  });
}
import { INVALID_PARAM_FORMAT } from '../engine/errors/error-kinds.js';

export const REQUIRES_CLIENT_APPROVAL = 'requires_client_approval' as const;
export const ALREADY_PENDING = 'already_pending' as const;

/** switch_mode HITL 等待超时（与 ask 工具一致，30 分钟）。 */
const SWITCH_MODE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * host resolve switch_mode HITL 时回传的响应体。
 * `outcome==='approved'` 且带 `to_mode` 才视为切换成功；其余（cancelled / 被
 * notifyManualSwitch 取消 / 超时）一律按未切换处理（fail-closed 不降级）。
 */
interface SwitchModeResolution {
  outcome?: 'approved' | 'cancelled';
  to_mode?: string;
}

/**
 * Phase 3 F5+F7：proposal 注册中心（由 host 注入）。
 * - `registerPending` 返回 `{ ok: true }` 表示注册成功，可继续 emit 事件；
 *   返回 `{ ok: false; existingProposalId }` 表示同 session 已有 pending proposal，
 *   工具应直接回 `already_pending` 阻止重复调用（防 pending 雪崩）。
 * - `unregister` 在 emit 失败时让工具回滚注册——避免"emit throw 但 proposal 已注册"
 *   导致后续 switch_mode 被 already_pending 永久误挡（复检 P2）。
 */
/** 模式切换的方向；由工具按「当前模式 → 目标模式」记录，供批准时应用真实 transition。 */
export interface ModeSwitchTransition {
  fromMode: string;
  toMode: string;
}

export interface SwitchModeProposalRegistry {
  registerPending(
    sessionId: string,
    proposalId: string,
    /** 该 proposal 的切换方向；host 批准时据此 setPendingModeTransition（缺省回退 plan→agent）。 */
    transition?: ModeSwitchTransition,
  ): { ok: true } | { ok: false; existingProposalId: string };
  /** 回滚刚刚 registerPending 注册的 proposal（emit 失败时由工具调用，幂等）。 */
  unregister(sessionId: string, proposalId: string): void;
}

export interface SwitchModeToolDeps {
  /** true = Daemon 等无 UI 宿主，工具直接返回 requires_client_approval */
  isHeadlessHost?: boolean;
  /** Phase 3 F5+F7：proposal 注册中心；缺省时工具仍能工作，但失去防伪 + dedup 能力 */
  proposalRegistry?: SwitchModeProposalRegistry;
  /**
   * 当前所在模式（提议的来源）。缺省 `'plan'` 兼容历史单向调用点。
   * 由 ToolProvider 按 `this.agentMode` 注入。
   */
  currentMode?: string;
  /**
   * 本模式允许「提议切换到」的目标模式白名单（= contract 的 proposableTargets）。
   * 决定 `target_mode_id` 枚举与校验。缺省 `['agent']` 兼容历史单向调用点。
   */
  allowedTargets?: readonly string[];
}

export interface SwitchModeToolInput {
  target_mode_id: string;
  reason: string;
}

function validateSwitchModeInput(
  input: unknown,
  allowedTargets: string[],
  targetsHint: string,
): { ok: true; targetMode: string; reason: string } | { ok: false; result: ToolResult } {
  const params = (input ?? {}) as Partial<SwitchModeToolInput>;
  const targetMode =
    typeof params.target_mode_id === 'string' ? params.target_mode_id : '';
  if (!allowedTargets.includes(targetMode)) {
    return {
      ok: false,
      result: jsonError(
        `Target mode "${targetMode || '(empty)'}" is not switchable from the current mode`,
        {
          error_kind: INVALID_PARAM_FORMAT,
          hint: `Call switch_mode with target_mode_id one of: ${targetsHint}.`,
        },
      ),
    };
  }
  const reason =
    typeof params.reason === 'string' && params.reason.trim()
      ? params.reason.trim()
      : '';
  if (!reason) {
    return {
      ok: false,
      result: jsonError('reason is required', {
        error_kind: INVALID_PARAM_FORMAT,
        field: 'reason',
      }),
    };
  }
  return { ok: true, targetMode, reason };
}

function validateSwitchModeRuntime(
  deps: SwitchModeToolDeps,
  ctx: ToolContext,
): ToolResult | null {
  const isHeadless = deps.isHeadlessHost === true || ctx.isHeadlessHost === true;
  if (isHeadless) {
    return jsonError(
      'Daemon mode cannot approve mode switch; ask user to switch via Electron client or run interactively.',
      {
        error_kind: REQUIRES_CLIENT_APPROVAL,
        hint: 'Ask the user to approve mode switch in the TabTin desktop client.',
      },
    );
  }
  //  批次 5：HITL 可用性判定走 interrupt 单原语（emit + wait 双原语齐备）。
  if (!resolveInterrupt(ctx).isAvailable()) {
    return jsonError(
      'Mode switch requires a UI stream + approval context (Electron client) and the current runtime did not provide one.',
      {
        error_kind: REQUIRES_CLIENT_APPROVAL,
        hint:
          'No interactive approval sink is available in this runtime — ask the user to switch mode manually via the mode selector, ' +
          'or continue doing work allowed in the current mode without requesting a switch.',
      },
    );
  }
  return null;
}

function registerModeSwitchProposal(
  deps: SwitchModeToolDeps,
  sessionId: string,
  proposalId: string,
  transition: ModeSwitchTransition,
): ToolResult | null {
  if (!deps.proposalRegistry) return null;
  const reg = deps.proposalRegistry.registerPending(sessionId, proposalId, transition);
  if (reg.ok) return null;
  return jsonError(
    'A mode switch proposal is already pending user approval for this session.',
    {
      error_kind: ALREADY_PENDING,
      existing_proposal_id: reg.existingProposalId,
      hint:
        'Do not retry switch_mode. Either wait for the user to approve/cancel the existing card, ' +
        'or continue doing plan-mode work (drafting plans, reading files, asking clarifying questions).',
    },
  );
}

async function waitForModeSwitchResolution(
  ctx: ToolContext,
  deps: SwitchModeToolDeps,
  sessionId: string,
  proposalId: string,
  requestEvent: StreamEvent,
): Promise<{ ok: true; resolution: SwitchModeResolution } | { ok: false; result: ToolResult }> {
  //  批次 5：「emit 提案卡片 + 挂起等审批 + 超时」收进 interrupt 单原语。
  let outcome: Awaited<ReturnType<InterruptPort['interrupt']>>;
  try {
    outcome = await resolveInterrupt(ctx).interrupt<SwitchModeResolution>({
      kind: 'mode_switch',
      interruptId: proposalId,
      requestEvent,
      timeoutMs: SWITCH_MODE_TIMEOUT_MS,
    });
  } catch (err) {
    // P2 修复：emit throw 时回滚 registry 注册，否则下次 switch_mode 会
    // 被 already_pending 永久误挡（直到 host restart）。unregister 幂等。
    deps.proposalRegistry?.unregister(sessionId, proposalId);
    return {
      ok: false,
      result: jsonError(
        `Failed to emit mode switch proposal: ${err instanceof Error ? err.message : String(err)}`,
        { error_kind: 'execute_error' },
      ),
    };
  }

  if (outcome.status === 'resolved') {
    return { ok: true, resolution: outcome.value as SwitchModeResolution };
  }
  deps.proposalRegistry?.unregister(sessionId, proposalId);
  return {
    ok: false,
    result: jsonError(
      outcome.message,
      {
        error_kind: 'execute_error',
        status: 'timeout',
        hint:
          'The mode switch was not approved in time. Continue with work allowed in the current mode; ' +
          'ask the user to switch via the mode selector if a switch is still essential.',
      },
    ),
  };
}

function modeSwitchResolutionResult(
  resolution: SwitchModeResolution,
  targetMode: string,
): ToolResult {
  if (resolution?.outcome === 'approved') {
    const appliedMode =
      typeof resolution.to_mode === 'string' && resolution.to_mode
        ? resolution.to_mode
        : targetMode;
    return {
      content: JSON.stringify({
        status: 'approved',
        mode: appliedMode,
        hint:
          // ：批准后跨轮持久，勿写「仅本轮」——否则模型会以为下轮仍回旧模式。
          `The user approved switching to ${appliedMode} mode. It stays in effect for subsequent turns until the user switches again ` +
          '(via the mode selector at the bottom-left of the chat input, or another approved switch_mode). ' +
          "Continue with the user's original request under the new mode; do not call switch_mode again.",
      }),
      isError: false,
      contextModifier: { modeOverride: appliedMode },
    };
  }
  return {
    content: JSON.stringify({
      status: 'declined',
      hint:
        'The user declined the mode switch (or changed mode manually). ' +
        'Continue with work allowed in the current mode; do not call switch_mode again for the same purpose.',
    }),
    isError: false,
  };
}

export function createSwitchModeTool(deps: SwitchModeToolDeps = {}): Tool {
  const currentMode = deps.currentMode ?? 'plan';
  const allowedTargets =
    deps.allowedTargets && deps.allowedTargets.length > 0
      ? [...deps.allowedTargets]
      : ['agent'];
  const targetsHint = allowedTargets.join(', ');
  return {
    name: 'switch_mode',
    description:
      `Request switching the agent mode so you can perform actions the current mode disallows. ` +
      `Allowed target modes here: ${targetsHint}. ` +
      'This tool BLOCKS until the user approves or declines in the chat UI, then returns the outcome. ' +
      'On approval the new mode takes effect immediately and persists across turns until the user switches again — ' +
      "just continue with the user's original request under the new mode. " +
      'On decline, keep doing work allowed in the current mode.',
    // HITL 阻塞工具（与 ask_user 同语义）：只读语义（本工具不改任何东西，切换由 host 在
    // 审批 resolve 时执行），且必须串行独占——不能与其它工具并发。
    isReadOnly: true,
    // ：switch_mode 自带专用审批面（ModeSwitchProposalCard）——工具调用本身
    // 无副作用（只 emit 提案 + 等审批，真正切换在专用卡批准后由 host 执行）。若不标
    // safe，judge 会把它当默认 object 写工具再弹一张通用权限卡（"对象写操作需要确认"），
    // 与专用切换卡重复门禁（正是  里"连续请求允许"的观感）。沿用  对
    // todo / plan_create 的同款处理：riskLevel='safe' 让 judge 放行，专用卡成为
    // 唯一审批面。
    riskLevel: 'safe',
    isConcurrencySafe: () => false,
    executionTimeoutMs: SWITCH_MODE_TIMEOUT_MS + 5_000,
    inputSchema: {
      type: 'object',
      properties: {
        target_mode_id: {
          type: 'string',
          enum: allowedTargets,
          description: `Target mode to switch to. Allowed: ${targetsHint}.`,
        },
        reason: {
          type: 'string',
          description:
            'Why you want to switch mode. Shown to the user on the approval card.',
        },
      },
      required: ['target_mode_id', 'reason'],
    } as Tool['inputSchema'],
    execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const validatedInput = validateSwitchModeInput(input, allowedTargets, targetsHint);
      if (!validatedInput.ok) return validatedInput.result;
      const { targetMode, reason } = validatedInput;

      const runtimeError = validateSwitchModeRuntime(deps, ctx);
      if (runtimeError) return runtimeError;

      const sessionId = ctx.threadId ?? '';

      // F5+F7 dedup：同 session 已有未 resolved proposal → 拒新调用，引导
      // 模型不要重试；同时让 host 在 IPC 校验 proposal_id 时挡掉伪造 ID。
      //
      // **TD-20 评估结论（Phase 4 文档化，决定不做）**：F3 曾提议加 tool_result
      // patch 机制——当用户最终批准/取消 proposal 时，回去把对应 tool_result
      // 的 content 从 "pending_user_approval" 改写为 "approved" / "cancelled"，
      // 让模型在长会话中读到准确的最终状态。评估后**不实现**：
      //   - 实测模型读到 `already_pending` 后自纠概率高（不会再无意义重试）；
      //   - patch 历史消息要改 messages.jsonl + transcript live + LLM context
      //     三处状态，工程复杂度高且容易引入新的 dedup bug；
      //   - 长会话最坏增长上限：每轮 1 条 already_pending（约 400 tokens），
      //     20 轮共 8k tokens，对 200k context 模型无压力；
      //   - 用户视角看 ModeSwitchProposalCard 的 resolved 状态足够清晰。
      // 后续若长会话场景增多再重新评估。
      const proposalId = randomUUID();
      const registrationError = registerModeSwitchProposal(deps, sessionId, proposalId, {
        fromMode: currentMode,
        toMode: targetMode,
      });
      if (registrationError) return registrationError;

      // execute 任一出口都释放 F7 pending。handleExecute / timeout 路径的
      // unregister 幂等；这里兜住 abort 灌 cancelled、waiter 正常回流等漏网。
      try {
        // ：emit 提案卡片 + 阻塞等待用户在 ModeSwitchProposalCard 上
        // 审批（经 interrupt 单原语，对齐 ask 工具）。host resolve 时：approve
        // 路径已在 resolve **之前**就地 reconfigure 了本 session runtime（工具集 /
        // systemPrompt / ShellCap 档位），故本工具只需回一个
        // `contextModifier.modeOverride` 让 query 循环回读 config、在**同一轮**
        // 后续迭代即以新模式运行——无需起新一轮 / 发用户消息。
        const waitResult = await waitForModeSwitchResolution(ctx, deps, sessionId, proposalId, new ModeSwitchProposalEvent({
          proposalId,
          fromModeId: currentMode,
          targetModeId: targetMode,
          reason,
          sessionId,
        }).toStreamEvent());
        if (!waitResult.ok) return waitResult.result;

        // fail-closed：只有明确 approved 且带目标模式才应用切换。
        return modeSwitchResolutionResult(waitResult.resolution, targetMode);
      } finally {
        deps.proposalRegistry?.unregister(sessionId, proposalId);
      }
    },
  };
}
