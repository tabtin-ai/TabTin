/**
 * AuditCap —— Governance Capability：把 Agent 一次 run 的关键生命周期事件
 * 流向宿主注入的 trace writer，让 W3 / 后续 Harness 专题能直接消费。
 *
 * **W2.2.3 范围**（D-tech-7 / D-tech-8）：
 *   - 暴露 `hooks-only` 模板（tools 为空、无 instructions），
 *     与 W2.2.1 / W2.2.2 已落 5 模板（纯工具 / 配置容器 /
 *     工具+hooks+状态 / dispatcher 派发）形成第 5 + 6 类形态对照。
 *   - **不接 Django ExecutionTrace**：D-tech-7 拍板"本期不实装任何
 *     HarnessEvent 发射；连写 ExecutionTrace.TraceEvent 也不做"——所以本
 *     Cap 仅定义 `AuditWriter` interface 契约层，宿主 W3 / Harness 专题
 *     落地时再注入真正的 writer 实现。
 *   - **不替代** 现有 telemetry：`packages/agent-runtime/src/telemetry/*`
 *     是另一条 sink 通路（W2.2.3 不动）。AuditCap 是给"业务 trace"用的
 *     专用通路，与系统 telemetry 正交。
 *
 * **职责边界**：
 *   - 做：在 EngineHooks 的 run / iteration / tool 6 个生命周期回调里把"agent / iteration / tool"
 *     维度的事件发给 writer；负责保留 `event_seq` 单调递增 + 装填基础
 *     payload（iteration 号 / tool name / 持续时间 / input/output 摘要）
 *   - 不做：脱敏 / PII 检测（W3 + redactSecretsInOutput 链路负责）/
 *     幂等去重 / 持久化重试（writer 实装方决定）/ 计成本（CostCap 职责）
 *
 * **配置来源**（W2.3 / Harness 专题装配时注入）：
 *   - 宿主层根据 `agent_config.capabilities.overrides.audit.authorization_rules`
 *     等顶层字段决定要不要装载 AuditCap 实例
 *   - `level: 'minimal' | 'standard' | 'verbose'` 控制写入粒度，避免在
 *     "verbose"模式下把每轮 input/output 全量塞 trace 撑爆 PG
 *
 * **永久规则**：本 Cap 不为 Harness / TabMemo / AdminDash / 移动端等"后续
 * 专题"加任何 fallback 或防御性代码（详见总控 §F6）。Writer interface
 * 是**唯一对外契约**，未注入 writer 时 Cap 行为是 no-op。
 */

import type {
  StreamEvent,
} from '../../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolResult,
} from '../../engine/contracts/tools.js';
import type {
  EngineHooks,
  EngineState,
  RunHookContext,
  IterationHookContext,
  ToolHookContext,
} from '../../engine/contracts/kernel.js';
import type { CapabilityCategory } from '../capability.js';
import { CapabilityBase } from '../base.js';
import {
  AUDIT_CAP_EVENT_TYPE,
  RuntimeAuditEvent,
} from '../../event/events/audit-events.js';

/** relay 落库用的 AuditCap 生命周期事件 type（passthrough，Django 本期不持久化）。 */
export const AUDIT_CAP_STREAM_EVENT_TYPE = AUDIT_CAP_EVENT_TYPE;

// ─── 审计事件类型 ────────────────────────────────────────────────────

/**
 * AuditCap 内部产出的事件 envelope。
 *
 * **设计要点**：
 *   - `seq` 单调递增（per AuditCap 实例）—— 让 writer 实装能 detect
 *     乱序 / 丢失，写入 PG 时也是 stable sort key
 *   - `phase` 与 EngineHooks 的 6 个 hook 一一对应；后续若新增 hook 类型
 *     （如 `beforeCompact` / `afterPermissionCheck`），按需扩展枚举
 *   - `payload` 是 plain object —— 确保 writer 可以 JSON.stringify 入库
 *     不踩函数 / Symbol / 循环引用
 *   - **不**包含 PII / 凭据：调用方在装填 payload 时已剔除（minimal 模式
 *     完全不带 input/output；standard 带 hash + 长度；verbose 带摘要 +
 *     裁剪后内容）
 */
export interface AuditEvent {
  /** 单调递增序号，per-cap 实例从 0 开始 */
  seq: number;
  /** 事件类型，对齐 EngineHooks 6 入口 */
  phase:
    | 'agent_start'
    | 'agent_end'
    | 'iteration_start'
    | 'iteration_end'
    | 'tool_start'
    | 'tool_end';
  /** 事件创建时刻（毫秒精度，wall clock）—— writer 入库时如有需要可以
   *  在 PG `created_at` 字段用 server time 覆盖 */
  ts: number;
  /** 当前 session 标识（CapabilityBase 的 _session.sessionId 复制过来）。
   *  null 表示 Cap 未 bind 到 session（理论上不会发生——hooks 只在 bind
   *  之后才被 query.ts 调）。 */
  sessionId: string | null;
  /** 业务 payload —— 字段集合按 phase 不同（详见各 hook 注释） */
  payload: Record<string, unknown>;
}

// ─── Writer 接口契约 ────────────────────────────────────────────────

/**
 * Audit writer —— W2.3 / Harness 专题落地时由宿主层注入。
 *
 * **接口语义**：
 *   - `write` 是异步 fire-and-forget 风格；AuditCap 不 await 该 Promise
 *     的具体结果（避免阻塞 ReAct 主循环），但**会** await 其 schedule，
 *     让 writer 内部能保证"每个 event 至少入了 buffer"。
 *   - writer 抛错**绝对不应**冒泡到 hook 调用方（query.ts 主循环）——
 *     AuditCap 内部 catch 并降级到 console.warn，避免审计失败 = 用户对话
 *     失败的不可接受耦合。
 *   - writer **可空**：宿主未注入时 AuditCap 完全 no-op（不发任何 event，
 *     不抛错）。这给"开发期不需要 trace"的场景留 escape hatch。
 *
 * **典型实装**（W3 / Harness 专题写）：
 *   ```ts
 *   const writer: AuditWriter = {
 *     async write(event) {
 *       await fetch(`${apiBase}/audit/trace-event`, {
 *         method: 'POST',
 *         body: JSON.stringify({
 *           trace_id: getCurrentTraceId(),
 *           event_type: event.phase,
 *           seq: event.seq,
 *           started_at: new Date(event.ts).toISOString(),
 *           input: event.payload.input,
 *           output: event.payload.output,
 *         }),
 *       });
 *     },
 *   };
 *   ```
 */
export interface AuditWriter {
  /**
   * 写入一条事件。
   *
   * AuditCap 调用约定：
   *   - 调用方（hook 内部）以 `await writer.write(event)` 形式调用，但
   *     writer 实装应让 await 在"已 schedule 到内部 buffer"后立即 resolve
   *     （不等真正的 IO 完成）。
   *   - 真实 IO 由 writer 内部异步完成（写文件 / 发 HTTP）；AuditCap 不
   *     关心其完成时刻。
   *   - 抛错由 AuditCap catch 后 console.warn —— 不要让审计失败拖垮 LLM
   *     主循环。
   */
  write(event: AuditEvent): Promise<void> | void;
}

/**
 * 把 AuditCap 生命周期事件经宿主 `emitStreamEvent` 转发到 relay 通路。
 *
 * W2.2.3 原设计 writer 由 W3 注入；本期最小闭环让 hooks() 不再 no-op，
 * 事件走 relay/telemetry，PermissionAudit 与 ExecutionTrace 持久化仍属后续专题。
 */
export function createRelayAuditWriter(
  emitStreamEvent?: (event: StreamEvent) => void,
): AuditWriter | undefined {
  if (!emitStreamEvent) return undefined;
  return {
    write(event: AuditEvent): void {
      try {
        emitStreamEvent(new RuntimeAuditEvent({
            seq: event.seq,
            phase: event.phase,
            ts: event.ts,
            session_id: event.sessionId,
            payload: event.payload,
            schema_version: 1,
        }).toStreamEvent());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[AuditCap] relay emit failed (phase=${event.phase}): ${msg}`);
      }
    },
  };
}

// ─── 配置 ───────────────────────────────────────────────────────────

/**
 * AuditCap 详细程度控制。
 *
 * - `minimal`：只发 phase + seq + ts + sessionId；payload 仅含工具名 / 迭代号，
 *   **不**带 tool input/output。适合生产 / 隐私敏感场景。
 * - `standard`（默认）：在 minimal 基础上加 input/output 长度 + 简单摘要
 *   （工具名 + arg keys + result success/error 标记）。
 * - `verbose`：input/output 完整带（裁剪到 `MAX_VERBOSE_PAYLOAD_CHARS`）。
 *   适合开发调试 / Harness 专题深度分析；**绝不**在生产开。
 */
export type AuditLevel = 'minimal' | 'standard' | 'verbose';

/** verbose 模式下单次 payload 字段值的最大字符数。超过截断 + 加 `[...truncated]` 标记。 */
const MAX_VERBOSE_PAYLOAD_CHARS = 4_000;

/**
 * standard 模式下生成的 input/output 摘要 cap —— 12 字段足够 dashboard 列表
 * 用，超过部分截断。
 */
const MAX_STANDARD_KEYS = 12;

export interface AuditCapInit {
  /**
   * 宿主注入的 trace writer。可空 —— 缺省时 AuditCap no-op（不发 event，
   * 不抛错），给"开发期不要 trace"的场景留逃生口。
   */
  writer?: AuditWriter;
  /**
   * 详细程度，缺省 `'standard'`。
   * 见上方 `AuditLevel` 注释；生产推荐 `'standard'`，调试可临时 `'verbose'`。
   */
  level?: AuditLevel;
}

// ─── 内部 helpers ───────────────────────────────────────────────────

/**
 * 把任意值压成"摘要字符串"——用于 standard / verbose 模式下的 payload
 * 装填，避免循环引用 / 函数 / Symbol 撑爆 writer。
 *
 * 算法：
 *   - 字符串 / number / boolean / null / undefined 直接 `String(v)`
 *   - object / array 走 `JSON.stringify` + try/catch（循环引用兜底为
 *     `'[unserializable]'`）
 *   - 长度超过 `cap` 则截断 + 加 `[...truncated]`
 */
function summarizeValue(v: unknown, cap: number): string {
  if (v == null) return String(v);
  if (typeof v === 'string') {
    return v.length > cap ? `${v.slice(0, cap)}[...truncated]` : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'function') return '[function]';
  if (typeof v === 'symbol') return v.toString();
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
  if (json == null) return String(v);
  return json.length > cap ? `${json.slice(0, cap)}[...truncated]` : json;
}

/**
 * 把 input record 压成"keys + 简短值摘要"，让 standard 模式既能保留
 * "调用形态"信息又不撑爆 trace。
 *
 * **不**保留具体 value（除非 verbose）——避免无意泄露 PII / 凭据。
 */
function describeInputKeys(input: unknown): { keys: string[]; truncated: boolean } {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { keys: [], truncated: false };
  }
  const allKeys = Object.keys(input as Record<string, unknown>);
  if (allKeys.length <= MAX_STANDARD_KEYS) {
    return { keys: allKeys, truncated: false };
  }
  return { keys: allKeys.slice(0, MAX_STANDARD_KEYS), truncated: true };
}

// ─── AuditCap ────────────────────────────────────────────────────────

/**
 * AuditCap：hooks-only 型 Capability，**不贡献工具**，**不贡献 instructions**
 * （`Capability.instructions?()` 已于阶段 2.3 下线），靠 hooks() 把 agent /
 * iteration / tool 6 类生命周期事件流向宿主注入的 writer。
 *
 * **type / category**：W2.1.0 §2 决议命名 `'audit'` / `'governance'`，与
 * `agent_config_v2.build_default_agent_config_v2()` 的
 * `capabilities.overrides.audit` 块对齐。
 *
 * **clone 行为**：override CapabilityBase.clone —— 内部 `_seq` 是单调递
 * 增计数器，clone 时必须重置为 0，否则不同 cloned 实例（W2.3 装配多
 * session 时必经路径）会用同一个 seq 池产生冲突。`_writer` / `_level`
 * 是构造期注入的不变引用 / 值，正常拷贝。
 *
 * **writer 抛错隔离**：所有 hook 内部对 `_writer.write` 调用都包 try/catch
 * 降级到 console.warn —— 严守"审计失败绝不冒泡到 LLM 主循环"。
 */
export class AuditCap extends CapabilityBase {
  readonly type = 'audit';
  readonly category: CapabilityCategory = 'governance';

  /**
   * 单调递增 event 序号。每次 hook 触发时 ++ 后写入 event。
   * **clone 时必须重置为 0**（override clone 处理）。
   */
  private _seq = 0;

  private readonly _writer?: AuditWriter;
  private readonly _level: AuditLevel;

  /**
   * tool_start 时刻记录，让 tool_end 能算出 `durationMs`。
   *
   * key = `tool.name + ':' + JSON.stringify(input)`（避免不同入参的同名
   * 工具调用串扰，参考 doom-loop hashToolCalls 模式）。
   *
   * **不**用 WeakMap：key 是字符串，且 hooks() 内 input 可能是 plain
   * object 在 beforeTool / afterTool 之间已被引擎替换（深
   * 拷贝路径），WeakMap 拿不到稳定引用。
   *
   * **clone 时必须重置为新 Map**：跨 session 共享会让 tool_end 错把别的
   * session 的 startTs 当 self（override clone 处理）。
   */
  private _toolStartTs: Map<string, number> = new Map();

  constructor(init?: AuditCapInit) {
    super();
    this._writer = init?.writer;
    this._level = init?.level ?? 'standard';
  }

  /**
   * 不贡献工具 —— hooks-only Cap 的标志特征。
   *
   * **设计决策**：与 SkillsCap（暴露 skills_search / skills_read 工具）
   * 不同，AuditCap 不应给 LLM 任何"主动 query 自己 trace 历史"的入口——
   * trace 数据应由 W3 + AdminDash 等管理面板消费，不让 LLM 自我探查
   * 防止 prompt injection 漏 secret。
   */
  tools(): Tool[] {
    return [];
  }

  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  /**
   * 6 个 EngineHooks 的实装 —— 每个钩子在事件发生时构造 AuditEvent 发给
   * writer。
   *
   * **顺序保证**：beforeRun / afterRun 一对、beforeIteration /
   * afterIteration 一对、beforeTool / afterTool 一对，三对生命周期
   * 都按钩子调用顺序串行 emit；`_seq` 在每个 hook 内 ++ 写入，让消费方
   * 拿到 stable 的事件流。
   *
   * **失败隔离**：`writer.write` 抛错全部被 catch 降级到 console.warn，
   * 严守"审计失败不影响主流程"原则（参见类注释 writer 抛错隔离段）。
   *
   * **writer 缺省时 no-op**：构造期未注入 writer，hooks() 仍返回完整对象
   * 但每个 hook 早 return（避免无效计算）—— 这是 hooks-only Cap 的常见
   * 模式，让 W2.3 装配方能"装而不接 writer"做契约层验证。
   */
  hooks(): EngineHooks | null {
    if (!this._writer) return null;
    const cap = this;

    return {
      // ：只读 state 写审计 sink，与 Skills/CLI/MCP beforeRun 无顺序依赖。
      beforeRunParallel: true,
      beforeRun: async (ctx: RunHookContext) => {
        await cap._emit('agent_start', cap._buildAgentPayload(ctx.state));
      },
      afterRun: async (ctx: RunHookContext) => {
        await cap._emit('agent_end', cap._buildAgentPayload(ctx.state));
      },
      beforeIteration: async (ctx: IterationHookContext) => {
        await cap._emit('iteration_start', cap._buildIterationPayload(ctx.state, ctx.iteration));
      },
      afterIteration: async (ctx: IterationHookContext) => {
        await cap._emit('iteration_end', cap._buildIterationPayload(ctx.state, ctx.iteration));
      },
      beforeTool: async (ctx: ToolHookContext) => {
        const key = cap._toolKey(ctx.tool, ctx.input);
        cap._toolStartTs.set(key, Date.now());
        await cap._emit('tool_start', cap._buildToolStartPayload(ctx.tool, ctx.input));
      },
      afterTool: async (ctx: ToolHookContext) => {
        const key = cap._toolKey(ctx.tool, ctx.input);
        const startTs = cap._toolStartTs.get(key);
        cap._toolStartTs.delete(key);
        const durationMs = startTs ? Date.now() - startTs : undefined;
        await cap._emit('tool_end', cap._buildToolEndPayload(ctx.tool, ctx.input, ctx.result, durationMs));
      },
    };
  }

  // ── 内部 helpers ────────────────────────────────────────────────────

  private async _emit(
    phase: AuditEvent['phase'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this._writer) return;
    const event: AuditEvent = {
      seq: this._seq++,
      phase,
      ts: Date.now(),
      sessionId: this._session?.sessionId ?? null,
      payload,
    };
    try {
      await this._writer.write(event);
    } catch (err) {
      // 严守"审计失败绝不冒泡"——降级到 console.warn 让运维能看到，但
      // 不让 LLM 主循环因 audit IO 故障中断。生产环境的 writer 实装应
      // 自带重试 / 队列降级，console.warn 仅是兜底。
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AuditCap] writer.write failed (phase=${phase}): ${msg}`);
    }
  }

  private _buildAgentPayload(state: EngineState): Record<string, unknown> {
    const base: Record<string, unknown> = {
      model: state.model,
      iteration: state.iteration,
    };
    if (this._level === 'minimal') return base;
    base.totalInputTokens = state.totalInputTokens;
    base.totalOutputTokens = state.totalOutputTokens;
    base.creditsCharged = state.creditsCharged;
    if (typeof state.contextPressure === 'number') {
      base.contextPressure = state.contextPressure;
    }
    return base;
  }

  private _buildIterationPayload(
    state: EngineState,
    iteration: number,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      iteration,
      messageCount: state.messages.length,
    };
    if (this._level === 'minimal') return base;
    base.totalInputTokens = state.totalInputTokens;
    base.totalOutputTokens = state.totalOutputTokens;
    base.creditsCharged = state.creditsCharged;
    if (typeof state.contextPressure === 'number') {
      base.contextPressure = state.contextPressure;
    }
    return base;
  }

  private _buildToolStartPayload(tool: Tool, input: unknown): Record<string, unknown> {
    const base: Record<string, unknown> = { toolName: tool.name };
    if (this._level === 'minimal') return base;
    if (this._level === 'verbose') {
      base.input = summarizeValue(input, MAX_VERBOSE_PAYLOAD_CHARS);
    } else {
      // standard
      const desc = describeInputKeys(input);
      base.inputKeys = desc.keys;
      if (desc.truncated) base.inputKeysTruncated = true;
    }
    return base;
  }

  private _buildToolEndPayload(
    tool: Tool,
    input: unknown,
    result: ToolResult | undefined,
    durationMs: number | undefined,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      toolName: tool.name,
      isError: result?.isError === true,
    };
    if (typeof durationMs === 'number') base.durationMs = durationMs;
    if (this._level === 'minimal') return base;
    if (this._level === 'verbose') {
      base.input = summarizeValue(input, MAX_VERBOSE_PAYLOAD_CHARS);
      // ToolResult.content 可能是 string 或 ContentBlock[]（结构化数据 / 多模态）。
      // 对 ContentBlock[] 走 summarizeValue 的 JSON.stringify 路径，
      // 仍然能截断到 MAX_VERBOSE_PAYLOAD_CHARS 不撑爆 trace。
      base.output = summarizeValue(result?.content, MAX_VERBOSE_PAYLOAD_CHARS);
    } else {
      // standard：只装填长度信息，不带具体内容
      let contentLen: number;
      if (typeof result?.content === 'string') {
        contentLen = result.content.length;
      } else if (Array.isArray(result?.content)) {
        // 结构化 content 走 JSON.stringify 估长度（避免对每个 block 的细分类型）
        try {
          contentLen = JSON.stringify(result.content).length;
        } catch {
          contentLen = 0;
        }
      } else {
        contentLen = 0;
      }
      base.outputLength = contentLen;
    }
    return base;
  }

  private _toolKey(tool: Tool, input: unknown): string {
    let argPart: string;
    try {
      argPart = JSON.stringify(input);
    } catch {
      argPart = '[unserializable]';
    }
    return `${tool.name}::${argPart}`;
  }

  /**
   * 测试 / W2.3 装配方观测点：当前 seq 计数（已 emit 的事件数）。
   *
   * **不**对外通过 `Capability` 接口暴露——这是 AuditCap 实例特化的
   * inspection 入口，宿主 / 测试通过 `(cap as AuditCap).getSeq()` 访问。
   * Capability 接口只承诺 7 hook + 2 lifecycle，inspection 是辅助。
   */
  getSeq(): number {
    return this._seq;
  }

  /**
   * Override clone —— 显式重置 `_seq` 到 0 + 重建 `_toolStartTs`。
   *
   * **理由**（与 SkillsCap clone 模式对齐）：默认 CapabilityBase.clone 走
   * structuredClone，但语义上 clone ≡ 新 session（Runtime 在 prepare_agent
   * 给每个 Run 分配独立 cap 实例），上一 session 的 seq 池 / 进行中工具
   * 启动时刻对新 session 无意义，反而会触发"seq 跨 session 串号"+ "tool
   * end 错把别 session 的 startTs 当 self"两类 bug。
   */
  clone(): AuditCap {
    const cloned = super.clone() as AuditCap;
    cloned._seq = 0;
    cloned._toolStartTs = new Map();
    return cloned;
  }
}
