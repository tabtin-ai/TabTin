/**
 * RunContext —— run 级不变量单点（ 批次 6a）。
 *
 * 病根：原 query.ts 的模块级函数每个吃 10+ 字段的 args 对象，QueryRun 在每个
 * 调用点手工转发一遍（参数汤）。RunContext 把 run 级不变量收成一个对象，
 * 各领域协作对象（RunPrelude / LlmRequestBuilder / ToolPhase / RunTerminator /
 * HookRunner / RunObservability）**构造时注入一次**；少数 run 内可变项
 * （toolParams / systemPromptRaw / inflight 文本等）走 accessor，所有权仍在
 * 主循环（AgentLoop）。
 */

import type {
  ContentBlock,
  SystemBlock,
  ToolParam,
} from '../contracts/conversation.js';
import type {
  Tool,
} from '../contracts/tools.js';
import type {
  ContextBudget,
} from '../contracts/context-capability.js';
import type {
  ContextManager,
  EngineConfig,
  EngineState,
  IterationBudgetSnapshot,
  QueryDeps,
  QueryParams,
} from '../contracts/kernel.js';
import type { TokenEstimator } from '../context/token-budget.js';
import type { ToolSchemaValidationLevel } from '../tooling/tool-schema-validator.js';
import type { RetryState } from './retry-state.js';
import type { ToolRegistry } from '../tooling/tool-system.js';
import type { resolveToolResultStorage } from '../tooling/tool-result-storage.js';
import type { DynamicToolManager } from '../tooling/dynamic-tool-manager.js';
import type { EnvelopeEmitter } from '../wire/envelope-emitter.js';
import type { ToolStreamEmitter } from '../wire/tool-stream-emitter.js';

export interface RunContext {
  // ── 标识 ──
  readonly runId: string;
  readonly traceId: string;
  readonly anchorId: string;
  readonly runtimeId: string;

  // ── 注入面 ──
  readonly params: QueryParams;
  readonly config: EngineConfig;
  readonly deps: QueryDeps;

  // ── run 级所有权对象（loop 拥有，协作对象读写字段） ──
  readonly state: EngineState;
  readonly abortController: AbortController;
  readonly envelopeEmitter: EnvelopeEmitter;
  readonly toolStreamEmitter: ToolStreamEmitter;
  readonly contextManager: ContextManager;
  readonly tokenEstimator: TokenEstimator;
  readonly budget: ContextBudget;
  readonly maxTurns: number;
  readonly retryState: RetryState;
  /**
   *  批次 12：`EngineConfig.toolSchemaValidation` 的解析单点——loop 构造
   * 时兜底一次（`?? DEFAULT_TOOL_SCHEMA_VALIDATION`），tool-phase 与
   * model-stream 两个消费点都读这里，不再各自独立兜底同一默认值。
   */
  readonly toolSchemaValidation: ToolSchemaValidationLevel;
  /**
   *  批次 12：`EngineConfig.toolOutputScan` 的解析单点（`?? true`，
   * 与 toolSchemaValidation 同模式）——tool-phase / llm-request-builder
   * 消费点读这里。
   */
  readonly toolOutputScan: boolean;

  // ── 工具面 ──
  readonly toolMap: Map<string, Tool>;
  readonly toolRegistry: ToolRegistry;
  readonly staticToolNames: Set<string>;
  readonly dynamicToolManager: DynamicToolManager;
  readonly toolResultStorage: ReturnType<typeof resolveToolResultStorage>;

  // ── run 内可变项（accessor：所有权在 loop，skill 热切 / mode 热切会重建） ──
  getToolParams(): ToolParam[];
  getSystemPromptRaw(): string | SystemBlock[] | undefined;
  setSystemPromptRaw(value: string | SystemBlock[] | undefined): void;
  getAssistantClientEventId(): string;
  getInflightAssistantText(): string;
  getInflightAssistantBlocks(): ContentBlock[];
  clearInflightAssistantText(): void;
  /**
   *  批次 9：iteration-budget-policy 经 beforeModel outcome 回传的最新
   * 预算快照（loop 持有）。RunTerminator 的 grace completion / budget DONE
   * 从这里读，替代原 `state.__iterationBudget*` 黑板字段。
   */
  getBudgetSnapshot(): IterationBudgetSnapshot | null;
  /**
   *  Phase 0：force_final 显式通道——iteration hook 经
   * `IterationHookContext.requestForceFinal(reason)` 写入 `forceFinalRef`，
   * 内核（后续 Phase 1/2 的 RunTerminator）从这里读，替代 `state.__forceFinal`
   * 等黑板偷渡。本 Phase 只补通道、不迁移消费者（旧字段保留）。
   */
  getForceFinal(): { reason: string } | null;
  /**
   *  Phase 0：force_final 信号 ref（对齐 stallRetryRef 的 ref 模式）。
   * 与 HookRunner 传入的 forceFinalRef 是**同一引用**，保证 hook 写入后
   * getForceFinal 读得到。
   */
  readonly forceFinalRef: { current: { reason: string } | null };
  /**
   *  批次 9：stall retry 信号（原 `state.__stallRetryPending`）。
   * llm-request-builder 的 onRetryAttempt 置 true，model-stream 在下一个
   * 内容 chunk 消费并复位（切换 stall retry 消息）。
   */
  readonly stallRetryRef: { current: boolean };
  /**
   *  批次 10：当前活动 Skill（原 `state.__activeSkillKey` /
   * `__activeSkillPrimaryEnv`）。Wave 1.5 密钥注入语义不变：skill_invoke
   * 展开后整个 run 继承（含裸 run_terminal_command），下一次 skill_invoke
   * 覆盖，`contextModifier.activeSkill: null` 显式清空。ToolPhase 每轮据此
   * 构造 `ToolContext.skillContext`。
   */
  readonly activeSkillRef: { current: { skillKey: string; primaryEnv?: string } | null };
}
