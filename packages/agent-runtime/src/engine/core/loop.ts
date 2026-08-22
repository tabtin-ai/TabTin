/**
 * @tabtin/agent-runtime — Agent 执行微内核主循环（原 query.ts， 批次 6 收官）。
 *
 * 本文件只拥有一件事：**run 生命周期状态机**——
 *
 *   start → [prepare → 模型流 → 完成判定 → 工具相位 → 后处理]* → catch → finalize
 *
 * 每一步的 continue / break 决策、`EngineState` 所有权（messages 推进 /
 * iteration 计数）、abort 传播、以及各领域协作对象与 hook 消费点的**调度时机**
 * 归这里；「怎么做」全部在领域协作对象里（构造时注入一次 RunContext）：
 *
 *   RunPrelude（前置装填）· HookRunner（策略栈消费）· LlmRequestBuilder
 *   （prompt/请求装配）· ToolPhase（工具相位）· RunTerminator（DONE 协议
 *   单点）· RunObservability（观测事件形态）· ContextManager / ToolGate /
 *   InterruptPort / observe（QueryDeps 端口注入）。
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import { RuntimeLlmRequestEvent, RuntimeLlmSnapshotEvent, RuntimeLlmUsageEvent } from '../../event/events/llm-events.js';
import { nextArrivalSeq } from '../../event/event-emitter.js';
import { EnvelopeEmitter, closeCurrentEnvelope, emitToolResultEnvelope } from '../wire/envelope-emitter.js';
import { ToolStreamEmitter } from '../wire/tool-stream-emitter.js';
import { RunObservability } from '../wire/run-observability.js';
import { buildPersistMessageEvent } from '../wire/done-payloads.js';
import { ToolRegistry } from '../tooling/tool-system.js';
import { resolveToolResultStorage } from '../tooling/tool-result-storage.js';
import { buildToolParams } from '../tooling/tool-params.js';
import { DynamicToolManager } from '../tooling/dynamic-tool-manager.js';
import { createSkillSlashHook } from '../tooling/skill-slash.js';
import { recordDynamicToolUsage, evictDynamicTools } from '../tooling/dynamic-tool-lifecycle.js';
import { ToolPhase } from '../tooling/tool-phase.js';
import type { ToolExecutionResult } from '../tooling/tool-orchestration.js';
import { TokenEstimator } from '../context/token-budget.js';
import { CompactionController } from '../context/compaction-controller.js';
import {
  applyToolResultSideEffects,
  recalculatePostInjectPressure,
  updateContextPressureAfterTurn,
} from '../context/turn-post-process.js';
import type { MessageOversizedIncompressible } from '../guards/message-size-budget.js';
import { classifyError } from '../errors/error-classifier.js';
import { DEFAULT_TOOL_SCHEMA_VALIDATION } from '../tooling/tool-schema-validator.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../contracts/context-capability.js';
import {
  AgentError,
} from '../contracts/kernel.js';
import type { IterationBudgetEvaluation } from '../guards/iteration-budget.js';
import type {
  LLMCallSnapshot,
  StreamEvent,
} from '../contracts/wire-protocol.js';
import type {
  ContentBlock,
  Message,
  SystemBlock,
  ToolParam,
  ToolResultBlock,
  ToolUseBlock,
} from '../contracts/conversation.js';
import type {
  LLMRequest,
  LLMRequestMetadata,
  LLMResponseChunk,
} from '../contracts/model-llm.js';
import type {
  Tool,
  ToolCallMetadata,
} from '../contracts/tools.js';
import type {
  KernelRuntime,
  ContextManager,
  EngineConfig,
  EngineState,
  IterationBudgetSnapshot,
  QueryDeps,
  QueryParams,
} from '../contracts/kernel.js';
import { createRetryState, type RetryState } from './retry-state.js';
import { checkAbort, isAbortError } from './abort.js';
import { flattenSystemPrompt } from '../context/system-prompt-text.js';
import { buildLLMCallSnapshot, CONTENT_PREVIEW_LIMIT } from './llm-call-snapshot.js';
import { buildDefaultPolicyPreHooks, buildDefaultPolicyPostStages } from './default-policy-hooks.js';
import type { RunContext } from './run-context.js';
import { HookRunner } from './hook-runner.js';
import { RunPrelude } from './run-prelude.js';
import { LlmRequestBuilder, type PromptAssemblyState } from './llm-request-builder.js';
import {
  RunTerminator,
  type AssistantPersistSnapshot,
  type PendingHardStop,
} from './completion.js';
import { streamModelResponse, commitAssistantCurrentBlock, type LLMStreamAccumulator } from './model-stream.js';
import { TelemetryEvents } from '../../telemetry/events.js';

// ─── createKernelRuntime (kernel entry point) ────────────────────────

/**
 * 微内核入口：deps **必填**——内核不组装任何默认依赖。
 *
 * 默认装配（provider 投影闸 / ContextManager / toolGate / interrupt /
 * observe / stamp 包装 / compactCheckpoint 等）统一在组装根
 * `src/runtime-assembly.ts` 的 `createRuntime(config)` 完成；宿主与
 * fork-query 都应经组装根获取 `AgentRuntime`，不要直接调本函数。
 */
export function createKernelRuntime(config: EngineConfig, deps: QueryDeps): KernelRuntime {
  // §17.6 D4.c：runtime 实例 UUID。原变量名 `sessionId` 改成 `runtimeId`，
  // 让"runtime UUID"vs"业务对话 thread"两个概念在命名上彻底无歧义。
  //
  //  loop id 统一：subagent 直接复用 childId（= config.subagentRunId）作为
  // runtime 实例 id，使主/子 agent 都由单一 loop id（runtimeId）定位，host 用它
  // 绑业务上下文；主 agent（无 subagentRunId）仍随机生成。注意仅统一实例级
  // runtimeId，run 级 runId/traceId 仍每 run 新生成（resume 同 childId 会多次 run）。
  const runtimeId = config.subagentRunId ?? crypto.randomUUID();
  let currentAbortController: AbortController | null = null;

  return {
    async *query(params: QueryParams): AsyncGenerator<StreamEvent, void, undefined> {
      // 6 件套是唯一协议——Django `relay_message_writer` 走 `_write_chat_messages_from_reassembler`
      // 主路径，按 `message_stop` 触发 `ChatMessage` 落库；前端 `contentBlockHandler`
      // 走 `useChatRuntimeStore.contentBlocksBySessionId` 实时索引。
      //
      // egress 盖章已上收 runtime-assembly 的 query-scoped EventEmitter；微内核
      // 只产出领域事件，不再持有 event_id/arrival_seq/trace/thread 协议约定。
      for await (const ev of runLoop(
        params, config, deps, runtimeId,
        (ac) => { currentAbortController = ac; },
      )) {
        yield ev;
      }
    },
    abort() {
      currentAbortController?.abort();
    },
    getRuntimeId() {
      return runtimeId;
    },
  };
}

// ─── 状态机类型 ───────────────────────────────────────────────────────

type LoopAction = 'continue' | 'break';

type StreamAction = StreamResult | LoopAction;

interface IterationPlan {
  iteration: number;
  isGraceCallTurn: boolean;
  budgetEval: IterationBudgetEvaluation;
  totalTokensSoFar: number;
  tokenBudgetMax: number;
  budgetTelemetrySessionId: string;
  llmRequest: LLMRequest;
  llmCallSnapshot: LLMCallSnapshot;
  requestMetadata?: LLMRequestMetadata;
}

interface StreamResult {
  fullText: string;
  toolUseBlocks: ToolUseBlock[];
  toolCallMetadataById: ReadonlyMap<string, ToolCallMetadata>;
  currentAssistantContent: ContentBlock[];
  preStartedTools: LLMStreamAccumulator['preStartedTools'];
  currentLLMMessageId: string;
  durationMs: number;
  usageBaseline: UsageCounters;
  byModelBaseline?: ReturnType<NonNullable<EngineConfig['budgetTracker']>['getByModelRaw']>;
  stopReason?: LLMResponseChunk['stopReason'];
}

interface AssistantResult extends StreamResult {
  assistantMessage: Message;
}

interface PostToolResult {
  toolResultBlocks: ToolResultBlock[];
  assistantPersistSnapshot: AssistantPersistSnapshot;
  pendingHardStop: PendingHardStop;
  hostHandoff: { reason: string } | null;
  hasInjectedMessages: boolean;
}

interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  creditsCharged: number;
}

// ─── AgentLoop（原 QueryRun）──────────────────────────────────────────

class AgentLoop {
  private readonly abortController = new AbortController();
  private readonly runId: string;
  private readonly runStartedAt = Date.now();
  private readonly anchorId: string;
  private readonly traceId: string;
  private readonly envelopeEmitter: EnvelopeEmitter;
  private readonly toolStreamEmitter: ToolStreamEmitter;
  private readonly maxTurns: number;
  private readonly toolMap: Map<string, Tool>;
  private readonly toolRegistry = new ToolRegistry();
  private readonly toolResultStorage: ReturnType<typeof resolveToolResultStorage>;
  private readonly dynamicToolManager = new DynamicToolManager();
  private readonly staticToolNames: Set<string>;
  private readonly state: EngineState;
  /** 上下文治理端口实例——压缩编排状态在实现内部，随 run 生命周期。 */
  private readonly contextManager: ContextManager;
  private readonly budget: typeof DEFAULT_CONTEXT_BUDGET;
  private readonly tokenEstimator = new TokenEstimator();
  private readonly retryState: RetryState;

  // ── run 内可变项（所有权在 loop，协作对象经 RunContext accessor 读写）──
  private systemPromptRaw: string | SystemBlock[] | undefined;
  private toolParams: ToolParam[];
  private continuationCount = 0;
  private todoCompletionNudgeCount = 0;
  private preDeeplyNested: MessageOversizedIncompressible[] = [];
  private preDeeplyNestedRef = { current: [] as MessageOversizedIncompressible[] };
  private assistantClientEventId = '';
  private inflightAssistantText = '';
  private inflightAssistantBlocks: ContentBlock[] = [];
  private finalTurnObservationStatus: 'completed' | 'failed' = 'completed';
  private finalTurnObservationReason = 'run_finished';
  /**  批次 9：iteration-budget outcome 快照（原 state.__iterationBudget* 黑板）。 */
  private budgetSnapshot: IterationBudgetSnapshot | null = null;
  /**  批次 9：stall retry 信号（原 state.__stallRetryPending）。 */
  private readonly stallRetryRef = { current: false };
  /**  Phase 0：force_final 显式通道（原 state.__forceFinal 黑板偷渡）。 */
  private readonly forceFinalRef = { current: null as { reason: string } | null };
  /**  批次 10：活动 Skill（原 state.__activeSkillKey / __activeSkillPrimaryEnv）。 */
  private readonly activeSkillRef = { current: null as { skillKey: string; primaryEnv?: string } | null };

  // ── 领域协作对象（构造时注入一次 RunContext）──
  private readonly ctx: RunContext;
  private readonly observability: RunObservability;
  private readonly hookRunner: HookRunner;
  private readonly prelude: RunPrelude;
  private readonly requestBuilder: LlmRequestBuilder;
  private readonly compactionController: CompactionController;
  private readonly toolPhase: ToolPhase;
  private readonly terminator: RunTerminator;

  constructor(
    private readonly params: QueryParams,
    private readonly config: EngineConfig,
    private readonly deps: QueryDeps,
    private readonly runtimeId: string,
    registerAbort: (ac: AbortController) => void,
  ) {
    registerAbort(this.abortController);
    // 已 aborted 的 signal 不会再派发 abort 事件——必须同步认一次，否则
    // 「abort 发生在 query() 构造之前」会整轮跑完（发出后立即停止的根因之一）。
    if (params.signal?.aborted) {
      this.abortController.abort();
    } else {
      params.signal?.addEventListener('abort', () => this.abortController.abort(), { once: true });
    }
    this.contextManager = deps.createContextManager(params);
    const rawHostRunId = params.hostRunId;
    const hostRunId = typeof rawHostRunId === 'string' ? rawHostRunId.trim() : '';
    if (!hostRunId) {
      throw new AgentError(
        'QueryParams.hostRunId is required and must be non-empty ',
        'INTERNAL',
      );
    }
    this.runId = hostRunId;
    this.anchorId = config.fileHistoryAnchorId ?? this.runId;
    this.traceId = this.runId;
    this.envelopeEmitter = new EnvelopeEmitter({
      traceId: this.traceId,
      threadId: config.sessionConfig.threadId,
      runId: this.runId,
      subagentRunId: config.subagentRunId,
    });
    this.toolStreamEmitter = new ToolStreamEmitter(this.envelopeEmitter, config, () => this.state.model);
    // ：未显式传入 maxTurns 时不套产品推荐值硬墙（Infinity = 不限制轮次）。
    // IterationBudget 对非有限 max 会禁用 iteration 通路，与 CostCap credits 语义一致。
    this.maxTurns = params.maxTurns ?? config.maxTurns ?? Number.POSITIVE_INFINITY;
    this.systemPromptRaw = params.systemPrompt ?? config.systemPrompt;
    const allTools = config.tools.getTools();
    this.toolParams = buildToolParams(allTools);
    this.toolMap = new Map<string, Tool>(allTools.map((tool) => [tool.name, tool]));
    this.toolRegistry.loadTools(config.tools);
    this.toolResultStorage = resolveToolResultStorage(config);
    this.staticToolNames = new Set(allTools.map((tool) => tool.name));
    this.state = this.createInitialState();
    this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...config.contextBudget };
    this.tokenEstimator.setModel(config.model);
    this.state._tokenEstimator = this.tokenEstimator;
    this.retryState = createRetryState(config.model, config.querySource);

    // ── RunContext：run 级不变量单点，协作对象构造时注入一次。──
    this.ctx = {
      runId: this.runId,
      traceId: this.traceId,
      anchorId: this.anchorId,
      runtimeId: this.runtimeId,
      params: this.params,
      config: this.config,
      deps: this.deps,
      state: this.state,
      abortController: this.abortController,
      envelopeEmitter: this.envelopeEmitter,
      toolStreamEmitter: this.toolStreamEmitter,
      contextManager: this.contextManager,
      tokenEstimator: this.tokenEstimator,
      budget: this.budget,
      maxTurns: this.maxTurns,
      retryState: this.retryState,
      // 策略 knob 解析单点：消费点（tool-phase / model-stream / request-builder）读这里。
      toolSchemaValidation: config.toolSchemaValidation ?? DEFAULT_TOOL_SCHEMA_VALIDATION,
      toolOutputScan: config.toolOutputScan ?? true,
      toolMap: this.toolMap,
      toolRegistry: this.toolRegistry,
      staticToolNames: this.staticToolNames,
      dynamicToolManager: this.dynamicToolManager,
      toolResultStorage: this.toolResultStorage,
      getToolParams: () => this.toolParams,
      getSystemPromptRaw: () => this.systemPromptRaw,
      setSystemPromptRaw: (value) => { this.systemPromptRaw = value; },
      getAssistantClientEventId: () => this.assistantClientEventId,
      getInflightAssistantText: () => this.inflightAssistantText,
      getInflightAssistantBlocks: () => this.inflightAssistantBlocks,
      clearInflightAssistantText: () => {
        this.inflightAssistantText = '';
        this.inflightAssistantBlocks = [];
      },
      getBudgetSnapshot: () => this.budgetSnapshot,
      getForceFinal: () => this.forceFinalRef.current,
      forceFinalRef: this.forceFinalRef,
      stallRetryRef: this.stallRetryRef,
      activeSkillRef: this.activeSkillRef,
    };

    this.observability = new RunObservability({
      runId: this.runId,
      traceId: this.traceId,
      runStartedAt: this.runStartedAt,
    });

    //  / ：engine 默认策略栈——注入类（pre）在宿主钩子之前，治理类
    // （post stages）在宿主钩子之后。每个 run 新建实例。
    //
    // **逐段独立 fail-soft**：pre / host / 各 post 策略各自一段——host 抛错不
    // 连坐 governance；governance 抛错也不连坐 IterationBudget（，避免
    // grace 被 composeHooks 整段吞掉后只能 MAX_TURNS 硬切）。
    this.hookRunner = new HookRunner([
      buildDefaultPolicyPreHooks(config, deps),
      config.hooks ?? {},
      createSkillSlashHook({
        request: params.skillSlashInvoke,
        activation: config.skillActivation,
        // ：enablement 已在 runBeforeLoopPrelude() 的 beforeRun 前刷新，
        // 此处不得在 Run 快照冻结后再次替换可见性版本。
        refreshEnablement: undefined,
        deps,
        tokenEstimator: this.tokenEstimator,
        activeSkillRef: this.activeSkillRef,
      }),
      ...buildDefaultPolicyPostStages(config, deps, {
        getPreDeeplyNested: () => this.preDeeplyNested,
        clearPreDeeplyNested: () => {
          this.preDeeplyNested = [];
        },
        getMaxTurns: () => this.maxTurns,
        getRetryState: () => this.retryState,
        getTokenEstimator: () => this.tokenEstimator,
        getToolParams: () => this.toolParams,
        getContextManager: () => this.contextManager,
      }),
    ], this.state, {
      runId: this.runId,
      //  Phase 0：forceFinalRef 必须与 RunContext.forceFinalRef 是同一
      // 引用，hook 写入后 getForceFinal 读得到。
      forceFinalRef: this.forceFinalRef,
      // ：afterToolResult host hook 的通用 detached mini-message 发送器。
      // core 只提供通用 envelopeEmitter（发任意 wire content-block）；展示层块
      // （tabtin_rich_content 等）的构造在 host hook 侧，不进 core。
      envelopeEmitter: this.envelopeEmitter,
    });
    this.compactionController = new CompactionController({
      state: this.state,
      contextManager: this.contextManager,
      budget: this.budget,
      config: this.config,
      getToolParams: () => this.toolParams,
      tokenEstimator: this.tokenEstimator,
      traceId: this.traceId,
      hooks: this.hookRunner,
    });

    this.prelude = new RunPrelude(this.ctx, this.preDeeplyNestedRef);
    this.requestBuilder = new LlmRequestBuilder(this.ctx);
    this.toolPhase = new ToolPhase(this.ctx, this.hookRunner, this.observability.activeTurnRef);
    this.terminator = new RunTerminator(this.ctx);
  }

  async *execute(): AsyncGenerator<StreamEvent, void, undefined> {
    yield* this.initializeSnapshotAndState();
    yield this.observability.buildLifecycleStartEvent();
    try {
      yield* this.runBeforeLoopPrelude();
      yield* this.runMainLoop();
    } catch (error) {
      yield* this.handleCatch(error);
    } finally {
      yield* this.finalizeRun();
    }
  }

  private createInitialState(): EngineState {
    const state: EngineState = {
      messages: [],
      systemPrompt: flattenSystemPrompt(this.systemPromptRaw),
      model: this.config.model,
      iteration: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      _cachedInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalReasoningTokens: 0,
      compactInputTokens: 0,
      compactOutputTokens: 0,
      contextPressure: 0,
      creditsCharged: 0,
      abortController: this.abortController,
      traceId: this.traceId,
      __pendingNotices: [],
    };
    this.applyBudgetTrackerBaseline(state);
    return state;
  }

  private applyBudgetTrackerBaseline(state: EngineState): void {
    if (this.config.budgetScope || !this.config.budgetTracker) return;
    state._budgetRunBaseline = this.config.budgetTracker.getAccumulated();
    state._budgetRunBaselineByModel = this.config.budgetTracker.getByModelRaw();
  }

  private async *initializeSnapshotAndState(): AsyncGenerator<StreamEvent, void, undefined> {
    try {
      await this.config.fileHistory?.beginSnapshot(this.anchorId);
    } catch {
      // fail-soft：beginSnapshot 失败时 trackEdit 会兜底建 bootstrap anchor。
    }
    this.preDeeplyNestedRef.current = this.preDeeplyNested;
    this.prelude.applyInitialMessages();
    this.preDeeplyNested = this.preDeeplyNestedRef.current;
    yield* this.prelude.restorePendingApprovals();
  }

  private async *runBeforeLoopPrelude(): AsyncGenerator<StreamEvent, void, undefined> {
    // ：不再 emit system_prompt_context——本轮规则只走 llmRequest.system；
    // 落库副本会跨轮以 user history 回灌，与 system 双通道重复。
    yield* this.prelude.emitMainUserEvent();
    this.assistantClientEventId = this.deps.generateUUID();
    //  / ：斜杠直链先 force 刷新 enablement，随后 beforeRun
    // 冻结本 Run 快照；Prompt、直链 invoke 与后续工具因此使用同一版本。
    if (this.params.skillSlashInvoke?.skillKey) {
      await this.config.refreshSkillEnablementForSlash?.();
    }
    yield* this.hookRunner.runBeforeRun();
  }

  // ── 主循环状态机 ────────────────────────────────────────────────────

  private async *runMainLoop(): AsyncGenerator<StreamEvent, void, undefined> {
    while (true) {
      const action = yield* this.runOneIteration();
      if (action === 'break') break;
    }
  }

  private async *runOneIteration(): AsyncGenerator<StreamEvent, LoopAction, undefined> {
    const plan = yield* this.prepareIteration();
    if (!plan) return 'break';
    const assistantResult = yield* this.streamAndAssembleAssistant(plan);
    if (assistantResult === 'continue' || assistantResult === 'break') return assistantResult;
    const completionAction = yield* this.handleCompletionWithoutTools(plan, assistantResult);
    if (completionAction) return completionAction;
    return yield* this.executeToolsAndPostProcess(plan, assistantResult);
  }

  private async *prepareIteration(): AsyncGenerator<StreamEvent, IterationPlan | null, undefined> {
    await this.params.waitIfPaused?.(this.abortController.signal);
    checkAbort(this.abortController);
    const iteration = this.state.iteration;
    const previousTurnEnd = this.observability.finishTurn('completed', { reason: 'next_iteration' });
    if (previousTurnEnd) yield previousTurnEnd;
    yield this.observability.beginTurn(iteration);
    yield* this.hookRunner.runIterationHook('beforeIteration', iteration);
    yield* this.prelude.emitPendingEnvironmentContext();
    yield* this.prelude.emitPendingAgentProfile();
    if (yield* this.runCompactionPhase()) return null;
    // ：host 消息注入（run-observations / thread-notifications）已迁到
    // beforeModel 默认策略栈——注入槽位不变（compaction 之后、LLM 调用之前）。
    return yield* this.buildAndEmitLlmRequest(iteration);
  }

  private async *runCompactionPhase(): AsyncGenerator<StreamEvent, boolean, undefined> {
    return yield* this.compactionController.runBeforeModelCall();
  }

  private async *buildAndEmitLlmRequest(
    iteration: number,
  ): AsyncGenerator<StreamEvent, IterationPlan | null, undefined> {
    const phaseStartedAt = Date.now();
    let lastMark = phaseStartedAt;
    const emitTiming = (phase: string, durationMs: number, extras?: Record<string, unknown>): StreamEvent => {
      this.deps.observe(
        TelemetryEvents.LLM_TIMING,
        {
          phase,
          duration_ms: Math.round(durationMs),
          model: this.state.model,
          iteration,
          source: 'runtime',
          ...(extras ?? {}),
        },
        {
          ...(this.config.sessionConfig.threadId ? { session_id: this.config.sessionConfig.threadId } : {}),
          ...(this.state.traceId ? { trace_id: this.state.traceId } : {}),
        },
      );
      return new RuntimeSystemNoticeEvent({
          content: `[llm_timing] ${phase}`,
          notice_type: 'llm_timing',
          severity: 'silent',
          phase,
          duration_ms: Math.round(durationMs),
          model: this.state.model,
          iteration,
          source: 'runtime',
          ...(extras ?? {}),
      }).toStreamEvent();
    };
    const mark = (phase: string, extras?: Record<string, unknown>): StreamEvent => {
      const now = Date.now();
      const event = emitTiming(phase, now - lastMark, extras);
      lastMark = now;
      return event;
    };

    const promptAssembly = this.requestBuilder.createAssembly();
    // beforeModel 承载全部 per-iteration 策略：pre 注入（obs/notif/sections）
    // → 宿主钩子 → post 治理/预算/nudge（-#3944）。system 段统一经
    // promptAssembly 注入；grace / terminate 决策经 outcome 信号回传，
    // DONE 协议 payload 由 RunTerminator 拼装（协议单点）。
    const outcome = yield* this.hookRunner.runBeforeModel({
      iteration,
      appendSystemSection: (name, content, source, opts) =>
        this.requestBuilder.appendSection(promptAssembly, name, content, source, opts?.placement),
    });
    yield mark('prepare_before_model_hooks', {
      section_count: promptAssembly.staticSections.length + promptAssembly.dynamicSections.length,
      static_section_count: promptAssembly.staticSections.length,
      dynamic_section_count: promptAssembly.dynamicSections.length,
    });
    //  批次 9：策略经 outcome 回传预算快照，loop 收下供 terminator /
    // grace completion 消费（策略未挂载时保持上一轮快照或 null，terminator 兜底重算）。
    if (outcome.budgetSnapshot) this.budgetSnapshot = outcome.budgetSnapshot;
    if (outcome.terminate) {
      yield* this.terminator.budgetExhaustedBeforeModel();
      return null;
    }
    const budgetInput = this.terminator.resolveBudgetSnapshot(iteration);
    //  批次 10：hook 栈只收集 section，此处交给 prompt section registry
    // 一次性 materialize；字节序与 hook 栈位解耦。
    const materialized = this.requestBuilder.materialize(promptAssembly);
    yield mark('prepare_materialize_prompt', {
      section_count: materialized.sectionRegistry.length,
    });
    const llmRequest = this.requestBuilder.buildRequest(
      outcome.graceTurn,
      outcome.toolAllowlist,
      outcome.forceToolCall,
      materialized.effectiveSystemPrompt,
    );
    yield mark('prepare_build_llm_request', {
      message_count: llmRequest.messages.length,
      tool_count: llmRequest.tools?.length ?? 0,
    });
    const requestMetadata = this.config.provider.getRequestMetadata?.(llmRequest);
    const llmCallSnapshot = buildLLMCallSnapshot(
      llmRequest,
      iteration,
      this.runId,
      materialized.sectionRegistry,
      requestMetadata,
    );
    yield mark('prepare_build_llm_snapshot', {
      message_count: llmCallSnapshot.messageCount,
      tool_count: llmCallSnapshot.toolCount,
      content_preview_limit: CONTENT_PREVIEW_LIMIT === Infinity ? 'infinity' : CONTENT_PREVIEW_LIMIT,
    });
    yield emitTiming('prepare_total_before_llm_request_event', Date.now() - phaseStartedAt, {
      message_count: llmCallSnapshot.messageCount,
      tool_count: llmCallSnapshot.toolCount,
    });
    yield this.buildLlmRequestEvent(llmCallSnapshot);
    yield this.observability.buildThinkingStepEvent(iteration, 'running');
    return {
      iteration,
      isGraceCallTurn: outcome.graceTurn,
      budgetEval: budgetInput.budgetEval,
      totalTokensSoFar: budgetInput.totalTokensSoFar,
      tokenBudgetMax: budgetInput.tokenBudgetMax,
      budgetTelemetrySessionId: this.config.sessionConfig.threadId,
      llmRequest,
      llmCallSnapshot,
      requestMetadata,
    };
  }

  private buildLlmRequestEvent(llmCallSnapshot: LLMCallSnapshot): StreamEvent {
    return new RuntimeLlmRequestEvent(
      llmCallSnapshot as LLMCallSnapshot & Record<string, unknown>,
    ).toStreamEvent();
  }

  // ── 模型流相位 ──────────────────────────────────────────────────────

  private async *streamAndAssembleAssistant(
    plan: IterationPlan,
  ): AsyncGenerator<StreamEvent, AssistantResult | LoopAction, undefined> {
    const streamResult = yield* this.streamAssistant(plan);
    if (streamResult === 'continue' || streamResult === 'break') return streamResult;
    yield* this.flushLlmSuccess(plan.iteration);
    const assistantMessage = this.pushAssistantMessage(streamResult);
    yield this.buildEnrichedLlmSnapshot(plan.llmCallSnapshot, assistantMessage, streamResult.stopReason);
    yield this.buildLlmUsageEvent(plan, streamResult);
    yield* this.hookRunner.runAfterModel({
      iteration: plan.iteration,
      assistantMessage,
      toolUseBlocks: streamResult.toolUseBlocks,
      stopReason: typeof streamResult.stopReason === 'string' ? streamResult.stopReason : undefined,
    });
    yield* this.hookRunner.runIterationHook('afterIteration', plan.iteration);
    return { ...streamResult, assistantMessage };
  }

  private async *streamAssistant(
    plan: IterationPlan,
  ): AsyncGenerator<StreamEvent, StreamAction, undefined> {
    const accumulator: LLMStreamAccumulator = {
      fullText: '',
      fullReasoning: '',
      toolUseBlocks: [],
      toolCallMetadataById: new Map(),
      currentAssistantContent: [],
      currentBlock: null,
      preStartedTools: new Map(),
      currentLLMMessageId: nodeRandomUUID(),
    };
    const usageBaseline = this.snapshotUsageCounters();
    const byModelBaseline = this.config.budgetTracker?.getByModelRaw();
    const streamStartedAt = Date.now();
    const messageCountBeforeLLM = this.state.messages.length;
    this.inflightAssistantText = '';
    this.inflightAssistantBlocks = [];
    yield* this.envelopeEmitter.beginMessage({
      messageId: accumulator.currentLLMMessageId,
      modelId: this.state.model,
      modelName: this.state.model,
      role: 'assistant',
      messageKind: 'llm',
    });
    try {
      yield* streamModelResponse({
        llmRequest: plan.llmRequest,
        deps: this.deps,
        abortController: this.abortController,
        envelopeEmitter: this.envelopeEmitter,
        acc: accumulator,
        state: this.state,
        stallRetryRef: this.stallRetryRef,
        config: this.config,
        toolSchemaValidation: this.ctx.toolSchemaValidation,
        tokenEstimator: this.tokenEstimator,
        messageCountBeforeLLM,
        preStartToolContext: this.toolPhase.buildToolContext(),
        toolMap: this.toolMap,
        setInflightAssistantText: (text) => {
          this.inflightAssistantText = text;
        },
        setInflightAssistantBlocks: (blocks) => {
          this.inflightAssistantBlocks = blocks;
        },
      });
      commitAssistantCurrentBlock(accumulator);
      return {
        fullText: accumulator.fullText,
        toolUseBlocks: accumulator.toolUseBlocks,
        toolCallMetadataById: accumulator.toolCallMetadataById,
        currentAssistantContent: accumulator.currentAssistantContent,
        preStartedTools: accumulator.preStartedTools,
        currentLLMMessageId: accumulator.currentLLMMessageId,
        durationMs: Date.now() - streamStartedAt,
        usageBaseline,
        ...(byModelBaseline ? { byModelBaseline } : {}),
        stopReason: accumulator.stopReason,
      };
    } catch (error) {
      // 保持既有行为：流式调用抛错时外层 fullText 尚未从 accumulator 同步。
      return yield* this.handleLlmStreamError(error, '');
    }
  }

  private async *handleLlmStreamError(
    error: unknown,
    fullText: string,
  ): AsyncGenerator<StreamEvent, LoopAction, undefined> {
    // ：流式文本复读 → 静默硬停（不走用户 Abort / 报红错误路径）。
    if (error instanceof AgentError && error.code === 'DOOM_LOOP_DETECTED') {
      yield* this.flushPendingNotices();
      yield* this.terminator.textRepetitionHardStop();
      return 'break';
    }
    if (isAbortError(error)) throw error;
    yield* this.flushPendingNotices();
    const classified = classifyError(error);
    const agentError = error instanceof AgentError ? error : null;
    const errorMsg = error instanceof Error ? error.message : String(error);
    // ：context-overflow 三段恢复 + 529/5xx 模型降级已迁 onModelError
    // 默认策略栈（短路合并、recovery 优先）。'retry' = hook 已修复上下文/换模型。
    const hookDirective = yield* this.hookRunner.runOnModelError({ error, classified, errorMsg });
    if (hookDirective === 'retry') return 'continue';
    if (hookDirective === 'break') return 'break';
    // hook 未处理的 context_overflow = 三段恢复 attempts 已耗尽 → failed 收尾。
    if (classified.category === 'context_overflow') {
      yield* this.terminator.contextOverflowRecoveryFailed(classified);
      return 'break';
    }
    if (fullText.length > 0 && classified.category === 'network') {
      yield* this.terminator.networkPartialDone({ fullText, errorMsg, classified });
      return 'break';
    }
    // ：不再 emit SYSTEM_NOTICE(`LLM error: ${raw}`)——终态错误卡已由
    // handleErrorRunCatch / DONE 表达；透传上游原文会与黄卡叠成双条，且把
    // burst 英文漏到蓝条。
    if (agentError) throw agentError;
    throw this.terminator.toLlmAgentError(error, classified, errorMsg);
  }

  private *flushLlmSuccess(iteration: number): Generator<StreamEvent, void, undefined> {
    yield* this.flushPendingNotices();
    this.retryState.consecutive5xxCount = 0;
    yield this.observability.buildThinkingStepEvent(iteration, 'done');
  }

  private *flushPendingNotices(): Generator<StreamEvent, void, undefined> {
    const pendingNotices = this.state.__pendingNotices ?? [];
    this.state.__pendingNotices = [];
    for (const notice of pendingNotices) yield notice;
  }

  /** messages 所有权在 loop：assistant 消息推进状态机。 */
  private pushAssistantMessage(streamResult: StreamResult): Message {
    const assistantMessage: Message = {
      role: 'assistant',
      content: streamResult.currentAssistantContent.length > 0
        ? streamResult.currentAssistantContent
        : streamResult.fullText,
    };
    this.state.messages.push(assistantMessage);
    this.inflightAssistantBlocks = Array.isArray(assistantMessage.content)
      ? assistantMessage.content
      : [{ type: 'text', text: String(assistantMessage.content) }];
    // ：HITL 挂起前的 partial persist 需要与整轮 final persist upsert
    // 同一条 ChatMessage —— 让 ToolContext 拿得到与 `buildAssistantPersistEvent`
    // 相同的 `messageId`。
    this.state.currentAssistantMessageId = streamResult.currentLLMMessageId;
    return assistantMessage;
  }

  private buildEnrichedLlmSnapshot(
    llmCallSnapshot: LLMCallSnapshot,
    assistantMessage: Message,
    stopReason: LLMResponseChunk['stopReason'] | undefined,
  ): StreamEvent {
    const assistantContent = assistantMessage.content;
    const respIsText = typeof assistantContent === 'string';
    const respRaw: string = respIsText ? assistantContent : JSON.stringify(assistantContent) ?? '';
    const enrichedSnapshot: LLMCallSnapshot = {
      ...llmCallSnapshot,
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      phase: 'response',
      response: {
        format: respIsText ? 'text' : 'blocks',
        contentPreview: respRaw.slice(0, CONTENT_PREVIEW_LIMIT),
        charCount: respRaw.length,
        stopReason: typeof stopReason === 'string' ? stopReason : undefined,
      },
    };
    return new RuntimeLlmSnapshotEvent(
      enrichedSnapshot as LLMCallSnapshot & Record<string, unknown>,
    ).toStreamEvent();
  }

  private snapshotUsageCounters(): UsageCounters {
    return {
      inputTokens: this.state.totalInputTokens,
      outputTokens: this.state.totalOutputTokens,
      cacheReadTokens: this.state.totalCacheReadTokens,
      cacheCreationTokens: this.state.totalCacheCreationTokens,
      reasoningTokens: this.state.totalReasoningTokens,
      creditsCharged: this.state.creditsCharged,
    };
  }

  private buildLlmUsageEvent(
    plan: IterationPlan,
    streamResult: StreamResult,
  ): StreamEvent {
    const current = this.snapshotUsageCounters();
    const baseline = streamResult.usageBaseline;
    const anchor = this.state._lastUsageAnchor;
    return new RuntimeLlmUsageEvent({
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      runId: this.runId,
      iterationId: plan.llmCallSnapshot.iterationId ?? `${this.runId}:${plan.iteration}`,
      iteration: plan.iteration,
      model: this.state.model,
      ...(plan.llmRequest.requestSource ? { requestSource: plan.llmRequest.requestSource } : {}),
      ...plan.requestMetadata,
      durationMs: Math.max(0, streamResult.durationMs),
      messageCount: plan.llmCallSnapshot.messageCount,
      toolCount: plan.llmCallSnapshot.toolCount,
      input_tokens: Math.max(0, current.inputTokens - baseline.inputTokens),
      output_tokens: Math.max(0, current.outputTokens - baseline.outputTokens),
      cache_read_input_tokens: Math.max(0, current.cacheReadTokens - baseline.cacheReadTokens),
      cache_creation_input_tokens: Math.max(0, current.cacheCreationTokens - baseline.cacheCreationTokens),
      reasoning_tokens: Math.max(0, current.reasoningTokens - baseline.reasoningTokens),
      credits_charged: Math.max(0, current.creditsCharged - baseline.creditsCharged),
      ...(anchor?.inputTokens !== undefined ? { last_input_tokens: anchor.inputTokens } : {}),
      ...(anchor?.cacheReadTokens !== undefined ? { last_cache_read_input_tokens: anchor.cacheReadTokens } : {}),
      ...(anchor?.cacheCreationTokens !== undefined ? { last_cache_creation_input_tokens: anchor.cacheCreationTokens } : {}),
      ...(this.config.budgetTracker
        ? { by_model: this.config.budgetTracker.getByModelSince(streamResult.byModelBaseline) }
        : {}),
    }).toStreamEvent();
  }

  // ── 完成判定相位 ────────────────────────────────────────────────────

  private *handleCompletionWithoutTools(
    plan: IterationPlan,
    assistantResult: AssistantResult,
  ): Generator<StreamEvent, LoopAction | null, undefined> {
    const graceCompleted = yield* this.terminator.graceCompletion({
      isGraceCallTurn: plan.isGraceCallTurn,
      toolUseBlocks: assistantResult.toolUseBlocks,
      budgetEval: plan.budgetEval,
      iteration: plan.iteration,
      totalTokensSoFar: plan.totalTokensSoFar,
      tokenBudgetMax: plan.tokenBudgetMax,
      fullText: assistantResult.fullText,
      sessionId: plan.budgetTelemetrySessionId,
    });
    if (graceCompleted) return 'break';
    const noToolResult = yield* this.terminator.noToolUseCompletion({
      toolUseBlocks: assistantResult.toolUseBlocks,
      stopReason: assistantResult.stopReason,
      continuationCount: this.continuationCount,
      todoCompletionNudgeCount: this.todoCompletionNudgeCount,
      assistantMessage: assistantResult.assistantMessage,
      currentLLMMessageId: assistantResult.currentLLMMessageId,
      fullText: assistantResult.fullText,
    });
    if (noToolResult === 'continue') this.continuationCount++;
    if (noToolResult === 'continue_todo') this.todoCompletionNudgeCount++;
    return noToolResult === 'none' ? null : (noToolResult === 'break' ? 'break' : 'continue');
  }

  // ── 工具相位 + 后处理 ───────────────────────────────────────────────

  private async *executeToolsAndPostProcess(
    plan: IterationPlan,
    assistantResult: AssistantResult,
  ): AsyncGenerator<StreamEvent, LoopAction, undefined> {
    const toolExecution = yield* this.toolPhase.executeTools({
      toolUseBlocks: assistantResult.toolUseBlocks,
      toolCallMetadataById: assistantResult.toolCallMetadataById,
      preStartedTools: assistantResult.preStartedTools,
    });
    const termination = this.toolPhase.scanSignals(toolExecution.executionResults);
    let suspensionCommitted = false;
    try {
      if (yield* this.terminator.conversationTermination({
        ...termination,
        fullText: assistantResult.fullText,
      })) return 'break';
      const postToolResult = yield* this.postProcessToolResults(plan, assistantResult, toolExecution);
      // 宿主交接代表当前工具已经完成了不可回退的宿主侧状态变更。
      // 工具结果已在 postProcessToolResults 中持久化；此时必须先发成功 handoff
      // 终态，不能再被只影响后续模型迭代的硬停或预算检查吞掉。
      if (postToolResult.hostHandoff) {
        return yield* this.emitToolResultAndIterationEnd(
          postToolResult.toolResultBlocks,
          postToolResult.assistantPersistSnapshot,
          postToolResult.hostHandoff,
        );
      }
      const postToolBreak = yield* this.handlePostToolBreaks(postToolResult);
      if (postToolBreak) return postToolBreak;
      const action = yield* this.emitToolResultAndIterationEnd(
        postToolResult.toolResultBlocks,
        postToolResult.assistantPersistSnapshot,
        null,
        termination.suspension,
      );
      suspensionCommitted = termination.suspension != null && action === 'break';
      return action;
    } finally {
      if (termination.suspension && !suspensionCommitted) {
        termination.suspension.onDiscard?.();
      }
    }
  }

  private async *postProcessToolResults(
    plan: IterationPlan,
    assistantResult: AssistantResult,
    toolExecution: { rawExecutionResults: ToolExecutionResult[]; executionResults: ToolExecutionResult[] },
  ): AsyncGenerator<StreamEvent, PostToolResult, undefined> {
    recordDynamicToolUsage(toolExecution.executionResults, this.dynamicToolManager, plan.iteration);
    // ：工具循环治理（失败 streak / 成功复读三档升级）已迁到
    // afterToolResult 默认策略栈，硬停信号经 ctx.requestHardStop 回传。
    // ：afterToolResult **必须先于** buildToolResultBlockSets——host
    // hook 可原位改写 `results[i].result`（如把业务摘要写进 llmContextContent）
    // 并清除瞬态 hostMetadata；随后构建的 LLM / canonical 视图才反映改写结果，
    // 也保证 hostMetadata 在落库前被清掉。buildToolResultBlockSets 不产事件，
    // 顺序前置不改变 wire 事件序（prompt-cache-prefix-stability 不受影响）。
    const hookOutcome = yield* this.hookRunner.runAfterToolResult({
      executionResults: toolExecution.executionResults,
      rawExecutionResults: toolExecution.rawExecutionResults,
      toolUseBlocks: assistantResult.toolUseBlocks,
      iteration: plan.iteration,
    });
    const { llmToolResultBlocks, canonicalToolResultBlocks } = this.toolPhase.buildToolResultBlockSets(
      toolExecution.rawExecutionResults,
      toolExecution.executionResults,
    );
    // messages 所有权在 loop：tool_result 消息推进状态机。
    this.state.messages.push({ role: 'user', content: llmToolResultBlocks });
    const assistantPersist = this.buildAssistantPersistEvent(
      assistantResult,
      canonicalToolResultBlocks,
    );
    yield assistantPersist.event;
    const hasInjectedMessages = yield* this.applyToolSideEffects(toolExecution.executionResults);
    return {
      toolResultBlocks: llmToolResultBlocks,
      assistantPersistSnapshot: assistantPersist.snapshot,
      pendingHardStop: hookOutcome.pendingHardStop,
      hostHandoff: hookOutcome.hostHandoff,
      hasInjectedMessages,
    };
  }

  private buildAssistantPersistEvent(
    assistantResult: AssistantResult,
    toolResultBlocks: ToolResultBlock[],
  ): { event: StreamEvent; snapshot: AssistantPersistSnapshot } {
    const assistantBlocks: ContentBlock[] = Array.isArray(assistantResult.assistantMessage.content)
      ? assistantResult.assistantMessage.content
      : [{ type: 'text', text: String(assistantResult.assistantMessage.content ?? '') } as ContentBlock];
    const modelId = typeof this.state.model === 'string' ? this.state.model.trim() : '';
    const blocks = [...assistantBlocks, ...toolResultBlocks];
    return {
      event: buildPersistMessageEvent({
        messageId: assistantResult.currentLLMMessageId,
        role: 'assistant',
        blocks,
        agentRunId: this.runId,
        arrivalSeq: nextArrivalSeq(),
        subagentRunId: this.config.subagentRunId,
        stopReason: 'tool_use',
        ...(modelId ? { modelId, modelName: modelId } : {}),
      }),
      snapshot: { messageId: assistantResult.currentLLMMessageId, blocks },
    };
  }

  private async *applyToolSideEffects(
    executionResults: ToolExecutionResult[],
  ): AsyncGenerator<StreamEvent, boolean, undefined> {
    const systemPromptRawRef = { current: this.systemPromptRaw };
    const hasInjectedMessages = yield* applyToolResultSideEffects({
      executionResults,
      state: this.state,
      deps: this.deps,
      tokenEstimator: this.tokenEstimator,
      config: this.config,
      toolParams: this.toolParams,
      toolMap: this.toolMap,
      staticToolNames: this.staticToolNames,
      toolRegistry: this.toolRegistry,
      systemPromptRawRef,
      activeSkillRef: this.activeSkillRef,
    });
    this.systemPromptRaw = systemPromptRawRef.current;
    return hasInjectedMessages;
  }

  private *handlePostToolBreaks(
    postToolResult: PostToolResult,
  ): Generator<StreamEvent, LoopAction | null, undefined> {
    const snapshot = postToolResult.assistantPersistSnapshot;
    if (yield* this.terminator.pendingHardStop(postToolResult.pendingHardStop, snapshot)) return 'break';
    recalculatePostInjectPressure({
      hasInjectedMessages: postToolResult.hasInjectedMessages,
      state: this.state,
      config: this.config,
      tokenEstimator: this.tokenEstimator,
    });
    if (yield* this.terminator.sharedBudgetExhausted(snapshot)) return 'break';
    if (yield* this.terminator.runCreditsExceeded(snapshot)) return 'break';
    const evictionNotice = evictDynamicTools(
      this.dynamicToolManager,
      this.state.iteration,
      this.toolParams,
      this.toolMap,
      this.state,
    );
    if (evictionNotice) yield evictionNotice;
    return null;
  }

  private *emitToolResultAndIterationEnd(
    toolResultBlocks: ToolResultBlock[],
    assistantPersistSnapshot: AssistantPersistSnapshot,
    hostHandoff: { reason: string } | null = null,
    suspension: {
      reason: 'awaiting_subagents';
      pendingSubagentIds: string[];
      onDiscard?: () => void;
    } | null = null,
  ): Generator<StreamEvent, LoopAction, undefined> {
    yield* closeCurrentEnvelope(this.envelopeEmitter);
    yield* emitToolResultEnvelope({
      toolResultBlocks,
      envelopeEmitter: this.envelopeEmitter,
      model: this.state.model,
    });
    // 迭代计数是状态机推进——留在 loop 本体，不藏在 completion 的副作用里。
    this.state.iteration++;
    if (hostHandoff) {
      this.finalTurnObservationReason = hostHandoff.reason;
      yield this.terminator.buildHostHandoffDoneEvent(hostHandoff.reason);
      return 'break';
    }
    if (suspension) {
      this.finalTurnObservationReason = suspension.reason;
      yield this.terminator.buildSuspendedDoneEvent(suspension);
      return 'break';
    }
    if (yield* this.terminator.maxTurnsExceeded(assistantPersistSnapshot)) return 'break';
    updateContextPressureAfterTurn(this.state, this.config, this.tokenEstimator);
    if (yield* this.terminator.forceFinal(assistantPersistSnapshot)) return 'break';
    return 'continue';
  }

  // ── catch / finalize ────────────────────────────────────────────────

  private *handleCatch(error: unknown): Generator<StreamEvent, void, undefined> {
    this.finalTurnObservationStatus = 'failed';
    yield* this.terminator.handleRunCatch({
      error,
      emitToolErrorEnvelope: (args) => this.toolStreamEmitter.emitToolErrorEnvelope(args),
    });
  }

  private async *finalizeRun(): AsyncGenerator<StreamEvent, void, undefined> {
    try {
      await this.config.fileHistory?.flushNow?.();
    } catch {
      /* fail-soft：flush 失败不阻断 run 收尾 */
    }
    const finalTurnEnd = this.observability.finishTurn(this.finalTurnObservationStatus, {
      reason: this.finalTurnObservationReason,
    });
    if (finalTurnEnd) yield finalTurnEnd;
    await this.hookRunner.runAfterRun();
    yield this.observability.buildLifecycleEndEvent();
  }
}

async function* runLoop(
  params: QueryParams,
  config: EngineConfig,
  deps: QueryDeps,
  runtimeId: string,
  registerAbort: (ac: AbortController) => void,
): AsyncGenerator<StreamEvent, void, undefined> {
  yield* new AgentLoop(params, config, deps, runtimeId, registerAbort).execute();
}

export type { PromptAssemblyState };
