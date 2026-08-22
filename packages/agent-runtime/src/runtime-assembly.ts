/**
 * Runtime Assembly —— 组装点（composition root）。
 *
 * **唯一**构造微内核具体依赖图的地方：provider 投影闸、autoCompact 压缩策略、
 * 事件 stamp 包装、`compactCheckpoint` 等非主循环 API 都在这里装配。
 * 微内核入口 `createKernelRuntime(config, deps)` 的 deps 必填、内核自身
 * 不组装任何默认依赖——宿主与 fork-query 一律经本文件的 `createRuntime`
 * 获取 `AgentRuntime`。
 *
 * 分层契约（由 `scripts/check-engine-layering.mjs` 守卫）：
 *   - 微内核 `engine/**` 不 import 任何「高级能力 / 会与主循环成环」的兄弟目录
 *     （subagent / capability / session / tools / host / providers / skills / state，
 *     以及 permissions 的策略实现）——这些能力经 `EngineConfig` / `QueryDeps` 注入。
 *   - 本文件是组装根，可以 import 任何实现；但 `engine/**` 不得反向 import 本文件。
 */

import type {
  LLMRequest,
} from './engine/contracts/model-llm.js';
import type {
  AgentRuntime,
  EngineConfig,
  QueryDeps,
  ToolGate,
} from './engine/contracts/kernel.js';
import { createKernelRuntime } from './engine/core/loop.js';
import { deriveBillingIdempotencyKey } from './engine/core/llm-request-builder.js';
import { EventEmitter } from './event/event-emitter.js';
import { flattenSystemPrompt } from './engine/context/system-prompt-text.js';
import { projectLlmRequest } from './engine/context/llm-context-projection.js';
import { createCompactContextManager } from './compact/context-manager.js';
import { summarizeHistoryForCheckpoint } from './compact/checkpoint.js';
import { emitTelemetryEvent } from './telemetry/emitter.js';
import { createInterruptAdapter } from './permissions/interrupt-adapter.js';
import { runWithHumanInteractionContext } from './permissions/human-interaction-hooks.js';

/**
 * Default QueryDeps factory.
 *
 * Wires EngineConfig's provider into the compact pipeline so the ReAct
 * loop actually performs context management.
 *
 * W1（压缩路径简化）：删除 `microCompact` 注入。
 * 原本 query-deps 会把"自创 micro 改写"包装后注入 deps.microCompact，
 * 让 query.ts 每轮 LLM 调用前跑一次"按 filePath 分组 read_file dedup +
 * 长 tool_result 截断 + 老 thinking trim"——三块都是 TabTin 自创、
 * 不再做的"事后改写本地 messages 内容"，破坏跨轮 byte-
 * identical 与 prompt cache 稳定性，是 dogfood calculator.html 死循环
 * 的根因之一（C1 §2.1 / §2.2 / §2.6）。
 */
export function createDefaultQueryDeps(config: EngineConfig): QueryDeps {
  // ──  fence 后移的 LLM 出口收口 ──
  //
  // FR-09 fence 不再写进 canonical 工具结果（UI / 落库 / transcript 拿干净
  // 内容），改在「发给 provider 前」统一投影施加。这里把 provider 包一层，
  // 让**本 runtime 的所有 LLM 出口**（主循环 llmRequest、compaction 摘要、
  // checkpoint 摘要、summary reuse 增量摘要、413 恢复 autoCompact）都过同一
  // 道投影闸——否则 compaction 家族直连 createStream 会把未 fence 的外部
  // 不可信字节（web/mcp/fetch 结果）裸喂给摘要 LLM，摘要变成注入洗白通道。
  //
  //  投影单点：与 query.ts buildLlmRequest 调同一个 projectLlmRequest
  // （幂等双过）——fenceEnabled 解析与投影语义只定义在
  // llm-context-projection.ts 一处。主循环自己已投影一次（为了 LLM_REQUEST
  // debug 快照与实际入模一致）；这里必须保留，兜住 compaction 家族直连
  // createStream 的出口。投影幂等，双过与单过 byte 等价。
  const guardedCreateStream = (req: LLMRequest) =>
    config.provider.createStream(
      projectLlmRequest(req, {
        toolOutputScan: config.toolOutputScan,
        isUntrustedShellCommand: config.isUntrustedShellCommand,
      }),
    );

  return {
    callModel: guardedCreateStream,

    // 上下文治理端口：压缩编排（orchestrator 状态 / 时机 / reuse /
    // time-based / 413 恢复的 autoCompact）全部收在 compact 实现内部。
    // FR-16 H3-B 的 `previousSummary` + reuse 配置由 orchestrator 单一真相源
    // 解析——组装根不读 EngineConfig 的 reuse 字段，避免两处默认值漂移。
    createContextManager: (params) => {
      const billingCallCounts = new Map<string, number>();
      const compactCreateStream = (req: LLMRequest) => {
        if (req.billingIdempotencyKey || !params.billingIdempotencyScope) {
          return guardedCreateStream(req);
        }
        const source = req.requestSource ?? '_compact';
        const callIndex = billingCallCounts.get(source) ?? 0;
        billingCallCounts.set(source, callIndex + 1);
        return guardedCreateStream({
          ...req,
          billingIdempotencyKey: deriveBillingIdempotencyKey(
            params.billingIdempotencyScope,
            source,
            callIndex,
          ),
        });
      };
      const scopedForkConfig = config.provider
        && config.tools
        && config.permissionHandler
        && config.sessionConfig
        ? {
            provider: { createStream: compactCreateStream },
            tools: config.tools,
            permissionHandler: config.permissionHandler,
            sessionConfig: config.sessionConfig,
          }
        : undefined;
      return createCompactContextManager({
        config,
        callModel: compactCreateStream,
        forkConfig: scopedForkConfig,
      });
    },

    // 观测出口：内核经 deps.observe 报事实；默认绑定进程级 telemetry
    // emitter（宿主启动时 setTelemetrySink 注入实际落地，与既有链路一致）。
    observe: emitTelemetryEvent,

    // 工具门：宿主注入 toolGate 实例，或 bindToolGate(config) 按当前
    // agentMode 绑定（ Stage 4）；缺省放行闸仅供测试。
    toolGate: config.toolGate
      ?? (config.bindToolGate ? config.bindToolGate(config) : PERMISSIVE_TOOL_GATE),

    // HITL 单原语：四条通道（批量审批 / judge ask /
    // ask 三件套 / switch_mode）的「挂起等人」收成一个端口。宿主注入面不变
    // （waitForUserInput / userInteractiveChannel 照旧），这里包成 interrupt。
    // 子 Agent 场景：fork/agent-tool 包装的是 config 上的宿主原语，本工厂为
    // 子 runtime 构造适配器时拿到的已是包装后的版本，行为不变。
    interrupt: createInterruptAdapter({
      emitStreamEvent: config.emitStreamEvent,
      waitForUserInput: config.waitForUserInput,
      userInteractiveChannel: config.userInteractiveChannel,
      threadId: config.sessionConfig.threadId,
    }),

    generateUUID: () => crypto.randomUUID(),
  };
}

/** 无宿主注入时的放行闸（测试 / 无模式场景）。 */
const PERMISSIVE_TOOL_GATE: ToolGate = {
  isRestrictedMode: () => false,
  evaluate: () => ({ allowed: true }),
  isPlanTargetGuarded: () => false,
};

/**
 * 官方 runtime 入口：组装默认 deps → 调微内核 → 补齐非主循环 API。
 */
export function createRuntime(config: EngineConfig): AgentRuntime {
  // 单个 query 的 generator 出口与 emitStreamEvent 旁路共享同一个 EventEmitter：
  // event_id / arrival_seq / protocol / thread / run / trace 在 runtime 源头统一盖章。
  // lifecycle.start 首先提供 run_id/trace_id，emitter 吸收后补到本 query 后续所有事件。
  const runtimeEvents = config.eventEmitter ?? new EventEmitter(config.emitStreamEvent, {
    threadId: config.sessionConfig.threadId,
    subagentRunId: config.subagentRunId,
  });
  const stampedConfig: EngineConfig = config.emitStreamEvent
    ? {
        ...config,
        eventEmitter: runtimeEvents,
        emitStreamEvent: (event) => runtimeEvents.emitStream(event),
      }
    : { ...config, eventEmitter: runtimeEvents };
  const deps = createDefaultQueryDeps(stampedConfig);
  const kernel = createKernelRuntime(stampedConfig, deps);

  return {
    ...kernel,
    async *query(params) {
      runtimeEvents.beginScope();
      const iterator = kernel.query(params)[Symbol.asyncIterator]();
      const interactionMode = typeof stampedConfig.runtimeMode === 'function'
        ? stampedConfig.runtimeMode()
        : stampedConfig.runtimeMode ?? 'interactive';
      const interactionContext = {
        threadId: stampedConfig.sessionConfig.threadId,
        interactionMode,
      };
      try {
        while (true) {
          const next = await runWithHumanInteractionContext(
            interactionContext,
            () => iterator.next(),
          );
          if (next.done) break;
          yield runtimeEvents.buildStream(next.value);
        }
      } finally {
        await iterator.return?.();
        runtimeEvents.endScope();
      }
    },
    // checkpoint 摘要不是主循环职责——组装根直连 compact 实现。
    compactCheckpoint(params) {
      return summarizeHistoryForCheckpoint({
        messages: params.messages,
        systemPrompt: flattenSystemPrompt(stampedConfig.systemPrompt),
        model: stampedConfig.model,
        callModel: deps.callModel,
        keepLastN: params.keepLastN,
        contextWindowTokens: stampedConfig.contextWindowTokens,
        summaryFocus: params.summaryFocus,
      });
    },
  };
}
