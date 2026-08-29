/**
 * Hook 机制（ 批次 6b，自 query.ts 收编）——EngineHooks 三段
 * 策略栈（pre 注入 / 宿主 / post 治理）的消费点基础设施 + 各 run\*Hook
 * 消费方法（批次 11 起全钩子单代 ctx 契约，run / iteration 级也走
 * HookEventChannel）。
 *
 * 硬约束「钩子写信号、主循环掌控制流」的落地形态：hook 内所有事件产出经
 * `HookEventSink` 进入 HookEventChannel，消费点**边执行边**按 FIFO yield
 * （含 await 的策略如 413 恢复的 autoCompact，其「过程开始」事件也能实时
 * 到达前端）——事件顺序 = hook 内 emit 顺序；hook 拿不到直接 yield 的能力。
 *
 * 三段分开持有：逐段独立 fail-soft——宿主段抛错只跳过宿主段剩余钩子，
 * post 治理段（尺寸预算 / 配对门等）仍结构性必达。
 */
import { HookEventChannel } from './hook-event-channel.js';
import { composeHooks } from './hooks-compose.js';
import type {
  StreamEvent,
  SystemNoticeEvent,
  SystemSectionName,
  DetachedMiniMessageBlock,
  DetachedMiniMessageDelta,
} from '../contracts/wire-protocol.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import type {
  Message,
  ToolUseBlock,
} from '../contracts/conversation.js';
import type {
  Tool,
  ToolResult,
} from '../contracts/tools.js';
import type { EnvelopeEmitter } from '../wire/envelope-emitter.js';
import type {
  AfterModelContext,
  BeforeModelContext,
  EngineHooks,
  EngineState,
  HookEventSink,
  IterationBudgetSnapshot,
  IterationHookContext,
  RunHookContext,
  ModelErrorContext,
  ModelErrorDirective,
  ToolHookContext,
} from '../contracts/kernel.js';
import type { ClassifiedError } from '../errors/error-classifier.js';
import type { ToolExecutionResult } from '../tooling/tool-orchestration.js';
import type { PendingHardStop } from './completion.js';

export interface AfterToolResultHookOutcome {
  pendingHardStop: PendingHardStop;
  hostHandoff: { reason: string } | null;
}

export interface BeforeToolHookOutcome {
  skipReason: string | null;
}

/** beforeModel 钩子栈的 per-iteration 决策信号（engine 拥有，钩子经 ctx 写入）。 */
export interface BeforeModelHookOutcome {
  /** iteration budget grace 档：本轮 LLM 请求不带工具。 */
  graceTurn: boolean;
  /**
   * 本轮工具面白名单（`ctx.restrictToolsForTurn` 写入；null = 不收窄）。
   * grace turn 优先（全扣工具时白名单无效）。默认策略栈无写者；API 保留供宿主钩子。
   */
  toolAllowlist: readonly string[] | null;
  /** 本轮是否协议层强制调工具（`tool_choice: 'required'`）。 */
  forceToolCall: boolean;
  /** iteration budget terminate 档：flush 完钩子事件后 yield DONE 并结束 run。 */
  terminate: boolean;
  /**
   *  批次 9：iteration-budget-policy 每轮回传的评估快照（原
   * `state.__iterationBudgetLastEval` 黑板字段）。策略未挂载时为 null。
   */
  budgetSnapshot: IterationBudgetSnapshot | null;
}

/** 构造一个把事件推进 channel 的 HookEventSink（engine 拥有实现）。 */
function makeHookEventSink(channel: HookEventChannel): HookEventSink {
  return {
    emitEvent: (event) => {
      channel.push(event);
    },
    emitNotice: (payload) => {
      channel.push(new RuntimeSystemNoticeEvent(payload).toStreamEvent());
    },
  };
}

/** 包一层 fail-soft：hook 抛错转 hook_error notice 入 channel，不向上传播。 */
function runHookFailSoft(
  hookName: string,
  channel: HookEventChannel,
  run: () => Promise<void>,
): Promise<void> {
  return run().catch((e: unknown) => {
    channel.push(buildHookErrorNotice(hookName, e));
  });
}

/** hook 抛错时的 fail-soft notice（与 runIterationHook 同款 payload）。 */
function buildHookErrorNotice(hookName: string, error: unknown): SystemNoticeEvent {
  return new RuntimeSystemNoticeEvent({
      content: `${hookName} hook error: ${String(error)}`,
      notice_type: 'hook_error',
      severity: 'silent',
  }).toStreamEvent();
}

export class HookRunner {
  /** run / iteration / tool 钩子沿用合并视图（一处抛错中止同名后续钩子，语义不变）。 */
  readonly composed: EngineHooks;

  constructor(
    private readonly stages: EngineHooks[],
    private readonly state: EngineState,
    /**
     *  Phase 0：run 级不变量子集——forceFinalRef（force_final 显式
     * 通道）。传子集而非整个 RunContext：RunContext 的类型依赖面很广，
     * HookRunner 只需这一项，收窄依赖避免无谓耦合；forceFinalRef 必须与
     * RunContext.forceFinalRef 是同一引用。
     */
    private readonly runInvariants: {
      runId?: string;
      forceFinalRef: { current: { reason: string } | null };
      /**
       * 通用 detached mini-message 发送器（`RunContext.envelopeEmitter`）——注入
       * `afterToolResult` ctx 的 `emitDetachedMiniMessage` 原语。core 只认通用
       * wire content-block，不含任何展示层（card / rich-content）词汇。可选：
       * 测试 / 旧调用点不传时，`emitDetachedMiniMessage` 退化为 no-op（静默跳过，
       * 不影响 hook 其它行为）。
       */
      envelopeEmitter?: EnvelopeEmitter;
    },
  ) {
    this.composed = composeHooks(...stages);
  }

  async *runBeforeRun(): AsyncGenerator<StreamEvent, void, undefined> {
    const channel = new HookEventChannel();
    const ctx: RunHookContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      runId: this.runInvariants.runId ?? '',
    };
    yield* channel.drain(
      runHookFailSoft('beforeRun', channel, async () => {
        await this.composed.beforeRun?.(ctx);
      }),
    );
  }

  async runAfterRun(): Promise<void> {
    // run 收尾点没有事件出口（DONE 之后不再 yield）——sink 落空即可，
    // 抛错也保持静默（与旧 afterAgent 语义一致）。
    const ctx: RunHookContext = {
      emitEvent: () => {},
      emitNotice: () => {},
      state: this.state,
      runId: this.runInvariants.runId ?? '',
    };
    try {
      await this.composed.afterRun?.(ctx);
    } catch { /* non-critical */ }
  }

  async *runIterationHook(
    hookName: 'beforeIteration' | 'afterIteration',
    iteration: number,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const hook = this.composed[hookName];
    if (!hook) return;
    const channel = new HookEventChannel();
    const ctx: IterationHookContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      iteration,
      runId: this.runInvariants.runId ?? '',
      requestForceFinal: (reason) => {
        this.runInvariants.forceFinalRef.current = { reason };
      },
    };
    yield* channel.drain(
      runHookFailSoft(hookName, channel, () => hook(ctx)),
    );
  }

  async *runCompactHook(
    hookName: 'beforeCompact' | 'afterCompact',
    stats: Record<string, unknown> | undefined,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const channel = new HookEventChannel();
    const ctx = {
      ...makeHookEventSink(channel),
      state: this.state,
      mode: 'auto',
      stats,
    };
    for (const stage of this.stages) {
      const hook = stage[hookName];
      if (!hook) continue;
      yield* channel.drain(runHookFailSoft(hookName, channel, () => hook(ctx)));
    }
  }

  async *runBeforeModel(args: {
    iteration: number;
    appendSystemSection: (
      name: SystemSectionName,
      content: string,
      source: string,
      opts?: { placement?: 'static' | 'dynamic' },
    ) => void;
  }): AsyncGenerator<StreamEvent, BeforeModelHookOutcome, undefined> {
    const outcome: BeforeModelHookOutcome = { graceTurn: false, toolAllowlist: null, forceToolCall: false, terminate: false, budgetSnapshot: null };
    const channel = new HookEventChannel();
    const ctx: BeforeModelContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      iteration: args.iteration,
      appendSystemSection: args.appendSystemSection,
      setGraceTurn: () => {
        outcome.graceTurn = true;
      },
      isGraceTurn: () => outcome.graceTurn,
      restrictToolsForTurn: (toolNames, opts) => {
        outcome.toolAllowlist = [...toolNames];
        if (opts?.forceCall) outcome.forceToolCall = true;
      },
      requestTerminate: () => {
        outcome.terminate = true;
      },
      setBudgetEvaluation: (snapshot) => {
        outcome.budgetSnapshot = snapshot;
      },
    };
    // 逐段独立 fail-soft：任一 stage 抛错只跳过该 stage（：post 各策略
    // 必须各自成段，否则 composeHooks 会让 governance 连坐吞掉 budget grace）。
    for (const stage of this.stages) {
      if (!stage.beforeModel) continue;
      yield* channel.drain(
        runHookFailSoft('beforeModel', channel, () => stage.beforeModel!(ctx)),
      );
    }
    return outcome;
  }

  async *runAfterModel(args: {
    iteration: number;
    assistantMessage: Message;
    toolUseBlocks: ToolUseBlock[];
    stopReason: string | undefined;
  }): AsyncGenerator<StreamEvent, void, undefined> {
    const channel = new HookEventChannel();
    const ctx: AfterModelContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      iteration: args.iteration,
      assistantMessage: args.assistantMessage,
      toolUseBlocks: args.toolUseBlocks,
      stopReason: args.stopReason,
    };
    for (const stage of this.stages) {
      if (!stage.afterModel) continue;
      yield* channel.drain(
        runHookFailSoft('afterModel', channel, () => stage.afterModel!(ctx)),
      );
    }
  }

  async *runAfterToolResult(args: {
    executionResults: ToolExecutionResult[];
    /**
     * 预算裁剪前的 raw 结果（`applyToolResultPolicy` 已产出）——按 toolUseId 配对
     * 暴露到 ctx 的 `rawResult`，让 hook 能同时改写 raw 与 execution 两个视图
     * （见 `ToolHookExecutionResult.rawResult`）。缺省空数组（旧调用点不接线时
     * `rawResult` 为 undefined，行为回退）。
     */
    rawExecutionResults?: ToolExecutionResult[];
    toolUseBlocks: ToolUseBlock[];
    iteration: number;
  }): AsyncGenerator<StreamEvent, AfterToolResultHookOutcome, undefined> {
    const channel = new HookEventChannel();
    let hardStop: PendingHardStop = null;
    let hostHandoff: { reason: string } | null = null;
    const toolInputById = new Map<string, unknown>();
    for (const toolUse of args.toolUseBlocks) toolInputById.set(toolUse.id, toolUse.input);
    const rawResultByToolUseId = new Map<string, ToolResult>();
    for (const raw of args.rawExecutionResults ?? []) rawResultByToolUseId.set(raw.toolUseId, raw.result);
    const ctx = {
      ...makeHookEventSink(channel),
      state: this.state,
      runId: this.runInvariants.runId ?? '',
      iteration: args.iteration,
      results: args.executionResults.map((er) => ({
        toolName: er.toolName,
        toolUseId: er.toolUseId,
        input: toolInputById.get(er.toolUseId),
        result: er.result,
        rawResult: rawResultByToolUseId.get(er.toolUseId),
        durationMs: er.durationMs,
      })),
      requestHardStop: (source: string) => {
        hardStop = { source: source as 'tool_failure' | 'tool_repetition' };
      },
      requestStopAfterToolResults: (reason: string) => {
        const normalized = reason.trim();
        if (!hostHandoff && normalized) hostHandoff = { reason: normalized };
      },
      emitDetachedMiniMessage: (mini: {
        role?: 'user' | 'assistant';
        block: DetachedMiniMessageBlock;
        deltaPayload?: DetachedMiniMessageDelta;
        messageId?: string;
        blockId?: string;
      }) => {
        const ee = this.runInvariants.envelopeEmitter;
        if (!ee) return;
        for (const ev of ee.emitDetachedMiniMessage(mini)) channel.push(ev);
      },
    };
    for (const stage of this.stages) {
      if (!stage.afterToolResult) continue;
      yield* channel.drain(
        runHookFailSoft('afterToolResult', channel, () => stage.afterToolResult!(ctx)),
      );
    }
    return { pendingHardStop: hardStop, hostHandoff };
  }

  async *runBeforeTool(args: {
    toolUseId: string;
    tool: Tool;
    input: unknown;
  }): AsyncGenerator<StreamEvent, BeforeToolHookOutcome, undefined> {
    const channel = new HookEventChannel();
    let skipReason: string | null = null;
    const ctx: ToolHookContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      runId: this.runInvariants.runId ?? '',
      toolUseId: args.toolUseId,
      tool: args.tool,
      input: args.input,
      skipCurrentTool: (reason: string) => {
        const normalized = reason.trim();
        if (!skipReason && normalized) skipReason = normalized;
      },
    };
    yield* channel.drain(
      runHookFailSoft('beforeTool', channel, async () => {
        await this.composed.beforeTool?.(ctx);
      }),
    );
    return { skipReason };
  }

  async *runAfterTool(args: {
    toolUseId: string;
    tool: Tool;
    input: unknown;
    result: ToolResult;
  }): AsyncGenerator<StreamEvent, void, undefined> {
    const channel = new HookEventChannel();
    const ctx: ToolHookContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      runId: this.runInvariants.runId ?? '',
      toolUseId: args.toolUseId,
      tool: args.tool,
      input: args.input,
      skipCurrentTool: () => {},
      result: args.result,
    };
    yield* channel.drain(
      runHookFailSoft('afterTool', channel, async () => {
        await this.composed.afterTool?.(ctx);
      }),
    );
  }

  async *runOnModelError(args: {
    error: unknown;
    classified: ClassifiedError;
    errorMsg: string;
  }): AsyncGenerator<StreamEvent, ModelErrorDirective | null, undefined> {
    const channel = new HookEventChannel();
    let directive: ModelErrorDirective | undefined;
    const ctx: ModelErrorContext = {
      ...makeHookEventSink(channel),
      state: this.state,
      error: args.error,
      errorMessage: args.errorMsg,
      errorCode: args.classified.code,
      category: args.classified.category,
      statusCode: args.classified.statusCode,
    };
    // 段间同样短路：首个返回非 undefined 指令的段生效（段内由 composeHooks 短路）。
    for (const stage of this.stages) {
      if (!stage.onModelError) continue;
      yield* channel.drain(
        runHookFailSoft('onModelError', channel, async () => {
          directive = await stage.onModelError!(ctx);
        }),
      );
      if (directive !== undefined) break;
    }
    return directive ?? null;
  }
}
