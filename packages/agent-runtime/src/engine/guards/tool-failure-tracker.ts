/**
 * W3 — Stall detector + 主循环 nudge.
 *
 * 当 LLM 在 ReAct 主循环里**连续**用同一个工具撞同一类错误时，runtime
 * 主动给 LLM 塞一段简短中文 system reminder，让它知道"这条路走不通了，
 * 换思路 / 求助用户 / 文字总结收尾"，而不是闷头堆 32 步零产出。
 * 同时给真实用户发一条中文 SYSTEM_NOTICE，让他们也知道 runtime 在帮兜底。
 *
 * ### 设计参考
 *
 * - **DenialTracking**：同 tool + 同 reason 连续撞墙触发提示。
 * - **iteration-budget.ts**：状态机风格 + 中文 system prompt 注入 + 中文
 *   SYSTEM_NOTICE 双通路；W3 stall detector 与之**正交共存**——
 *   iteration-budget 关心 budget 比例，tool-failure-tracker 关心 streak 计数。
 *
 * ### 状态机
 *
 * `normal → notice → nudge → terminate` 单调递增。notice / nudge 在同一连续
 * streak 内升级；terminate 是更高优先级的硬熔断档（见下）。streak 被打破后
 * （成功调用 / 不同 tool / 不同 error_kind）重新从 normal 开始。tracker 是
 * **per-query** 实例（tool-loop-guard 每个 run `new ToolFailureTracker()`
 * 时新建），所以"用户新消息"打破 streak 由架构层自然吞掉——新一轮意图 = 新
 * tracker = 空 buffer，无需 tracker 暴露 reset 方法。
 *
 * - **normal**：未达阈值，runtime 不做事。
 * - **notice**：达 `notice` 阈值（默认 3）——给用户发一条中文 SYSTEM_NOTICE
 *   提醒"runtime 注意到 LLM 在反复撞同一类错"；**不**注入 LLM context
 *   （W2 已经在每条 tool_result 里给了 hint，再注入一遍是噪音）。
 * - **nudge**：达 `nudge` 阈值（默认 5）——除了发 SYSTEM_NOTICE，还**注入**
 *   一段英文 system reminder 到下一轮 LLM context，引导它考虑：
 *   (1) 调用真实存在的 ask 工具（ask_user / ask_form，按 error_kind 智能选择）、
 *   (2) 换工具 / 换路径、(3) 文字总结收尾。
 * - **terminate**：达 `terminate` 阈值（默认 8，按**同 tool 失败计数**
 *   判定，**不要求连续同 kind**）——runtime **静默硬停本轮**（query.ts 消费侧
 *   yield DONE + break，**不**向用户 emit 文案提示），不再调用 LLM。notice /
 *   nudge 是"软提示帮模型自纠"（弱模型可能不遵从、闷头烧 token）；terminate 是
 *   "硬刹车防烧穿"，不依赖模型遵从度。判定用同 tool 失败**总数**而非连续 streak，
 *   是为堵住"error_kind 在两类间抖动"（schema warn ↔ execute 内层校验交替）让
 *   连续 streak 永远算不满的死循环盲区——这是 「创建不成功就一直创建/烧
 *   token」的根因之一。
 *
 * ### streak 算法
 *
 * 环形缓冲（默认 N=10）记录最近调用历史，每个 entry 是
 * `{ tool, error_kind: string | null, ts }`（`error_kind=null` 表示成功调用）。
 * `evaluate()` 从尾部向前扫描：
 *
 * 1. 若末尾是成功调用 / buffer 为空 → `normal`
 * 2. 若末尾失败的 `error_kind` 在 **excludeKinds** 名单里（见下） → `normal`
 * 3. 否则统计末尾**连续同 tool + 同 error_kind** 的失败长度作为 streak
 * 4. streak ≥ nudge 阈值 → `nudge`；≥ notice 阈值 → `notice`；否则 `normal`
 *
 * 这与 prompt 描述的"同 tool+kind 才计入 streak"语义一一对应：
 * 同一个 tool 连撞两类错（kind A → kind B → kind A）不会累积为 streak=3，
 * 因为中间被 B 打断；这是有意设计——LLM 已经"换姿势"了，不应触发 stall。
 *
 * ### 排除 kinds（不计入 streak）
 *
 * 1. **用户主动行为类**：`aborted` / `aborted_by_user` / `budget_skipped` ——
 *    不是 LLM 撞墙，是用户暂停 / runtime 兜底。
 * 2. **调用前置失败类**：`unknown_tool` / `schema_invalid` /
 *    `validate_input` / `plan_guard_deny` —— 工具根本没执行，是 LLM 拼错调用，
 *    走另一条 catalog 路径（前端已有红色异常提示），不需要再 nudge。
 * 3. **宿主层 bug 类**：`runtime_misconfig` / `internal_error` /
 *    `host_unsupported` —— 这些是宿主装配错或 host 未实现工具，**重试不会
 *    变好**，nudge LLM "换思路"也于事无补；产品决议是让 Agent 直接放弃路径，
 *    不是 stall 干预。
 *
 * `tool_timeout` / `mode_restricted` 等**仍然**计入：前者反复 timeout 说明
 * 这条路太慢，LLM 应换思路；后者反复触发说明用户当前模式不允许，LLM 应
 * `switch_mode` 请求切换或文字总结收尾——都是 nudge 能帮上忙的场景。
 *
 * ### 与 iteration-budget 的边界
 *
 * - **正交计量**：iteration-budget 看比例（轮数 / token），tool-failure 看
 *   streak（连续失败次数）。一个长任务可能 iteration-budget 一直在 normal
 *   而 tool-failure 已 nudge；反之亦然。
 * - **同位置注入**：两者注入到 system prompt 的同一段（normalize 之后、
 *   构造 LLMRequest 之前），但用**独立的 SYSTEM_SECTION_NAMES** 区分。
 * - **阶段升级独立计数**：tool-loop-guard 闭包内的 failureStage 与
 *   iteration-budget 的档位互不干扰——streak reset 时前者归 undefined，
 *   后者继续单调递增。
 *
 * ### 设计不变量
 *
 * - **stateful 工厂**：与 iteration-budget 的纯函数 evaluate 不同，本 tracker
 *   持有 buffer 状态（与 EngineState 同生命周期，per-query 实例）。
 * - **defensive**：阈值非法值（NaN / 负数 / nudge ≤ notice）由
 *   `mergeTrackerConfig` 在 fabric 阶段就回落到默认。
 * - **non-throwing**：record / evaluate 永远不抛错——runtime 主循环不能因
 *   tracker bug 崩盘。
 * - **env override only at fabric**：env 变量在工厂创建时读一次，运行期不
 *   重读（与 iteration-budget host-knobs 同惯例 — env 是启动配置不是热更新）。
 */

import {
  HOST_UNSUPPORTED,
  INTERNAL_ERROR,
  INVALID_PARAM_FORMAT,
  RUNTIME_MISCONFIG,
  type ToolErrorKind,
} from '../errors/error-kinds.js';
import {
  applyTrackerBufferFloor,
  mergeTrackerThresholds,
  parseTrackerEnvBoolean,
  parseTrackerEnvNumber,
} from './tool-tracker-base.js';

// ─── 公共类型 ────────────────────────────────────────────────────────

export type ToolFailureStage = 'normal' | 'notice' | 'nudge' | 'terminate';

/**
 * 缓冲条目：失败时 `error_kind` 是 W2 枚举字面量；成功时为 `null`，作为
 * sentinel 让 streak 算法在反向扫描时立即终止（"末尾是成功 → streak=0"）。
 *
 * **不**直接 mutate buffer 来"打破 streak"——`recordSuccess` 通过 pop 末尾
 * 同 tool+kind 序列实现精准 reset，避免误清空其他 (tool, kind) 的有效 streak。
 */
export interface ToolFailureBufferEntry {
  readonly tool: string;
  readonly error_kind: string | null;
  readonly ts: number;
}

export interface ToolFailureBudgetThresholds {
  /** 触发 notice（用户中文提示）的最小 streak 长度。默认 3。 */
  readonly notice: number;
  /** 触发 nudge（中文 + 英文注入）的最小 streak 长度。默认 5；必须 > notice。 */
  readonly nudge: number;
  /**
   * 触发 terminate（runtime 硬熔断本轮）的最小**同 tool 失败计数**。默认 8；
   * 必须 > nudge。
   *
   * 与 notice / nudge 的关键差异（见 §terminate 判定）：terminate 不要求
   * "连续同 error_kind"，只数同 tool 在 buffer 内排除 excludeKinds 后的失败
   * **总数**。这是为了堵住"同一工具反复失败、但 error_kind 在两类之间抖动"
   * 的死循环盲区（典型：schema warn 记一类、execute 内层校验记另一类，交替
   * 出现让连续 streak 永远算不满）。
   *
   * notice / nudge 是"软提示帮模型自纠"（不可靠，弱模型不遵从）；terminate 是
   * "硬刹车防烧穿"（不依赖模型遵从，直接终止本轮）。
   */
  readonly terminate: number;
}

export interface ToolFailureBudgetTrigger {
  readonly tool: string;
  readonly error_kind: string;
  readonly streak: number;
}

export interface ToolFailureBudgetEvaluation {
  readonly stage: ToolFailureStage;
  readonly trigger: ToolFailureBudgetTrigger | null;
}

export interface ToolFailureTrackerConfig {
  readonly enabled: boolean;
  readonly thresholds: ToolFailureBudgetThresholds;
  readonly bufferSize: number;
  readonly excludeKinds: ReadonlyArray<string>;
}

export type ToolFailureTrackerConfigOverride =
  Omit<Partial<ToolFailureTrackerConfig>, 'thresholds'> & {
    readonly thresholds?: Partial<ToolFailureBudgetThresholds>;
  };

export interface ToolFailureTrackerOptions {
  /** 显式 config 覆盖默认 + env override；用于测试 / 高级宿主装配。 */
  readonly config?: ToolFailureTrackerConfigOverride;
  /** Env 注入；不传时读 `process.env`。测试可注入空对象 `{}` 屏蔽 env。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 时间源；测试可注入确定性时钟。默认 `Date.now`。 */
  readonly now?: () => number;
}

/**
 * Stall detector tracker 实例。
 *
 * 所有方法都是 **non-throwing**：record 操作永远不抛（即使 tool/kind 是空字符串
 * 之类异常输入），evaluate 永远返回合法 stage。tracker 单 bug 不能让主循环崩。
 */
export class ToolFailureTracker {
  private readonly buffer: ToolFailureBufferEntry[] = [];
  private readonly config: ToolFailureTrackerConfig;
  private readonly now: () => number;

  constructor(options?: ToolFailureTrackerOptions) {
    const env = options?.env ?? process.env;
    const envConfig = readEnvConfig(env);
    this.config = mergeTrackerConfig(
      DEFAULT_TOOL_FAILURE_TRACKER_CONFIG,
      envConfig,
      options?.config,
    );
    this.now = options?.now ?? Date.now;
  }

  /**
   * 工具失败时调用。`error_kind` 缺失（undefined / 空串）→ 不入 buffer，因为
   * 没有 kind 无从判断"同 kind streak"——保守起见，宁可漏报也不假阳性 nudge。
   */
  recordFailure(input: { tool: string; error_kind?: string }): void {
    recordToolFailure(input, {
      buffer: this.buffer,
      config: this.config,
      now: this.now,
    });
  }

  /**
   * 工具成功时调用。从 buffer 末尾向前移除连续匹配的失败 record；
   * **只 reset 同 tool + 同 kind 的 streak**，不全局清空：
   * - 传 `error_kind` → 移除末尾连续 (tool, kind) record
   * - 不传 `error_kind` → 移除末尾连续 tool=tool record（任意 kind）
   *
   * 这样 success(A) 不会误清空当前正在累积的 (B, X) streak。
   */
  recordSuccess(input: { tool: string; error_kind?: string }): void {
    recordToolSuccess(input, {
      buffer: this.buffer,
      config: this.config,
      now: this.now,
    });
  }

  /** 评估当前缓冲是否触达 notice / nudge 阈值。详见 §streak 算法。 */
  evaluate(): ToolFailureBudgetEvaluation {
    return evaluateToolFailureBudget(this.buffer, this.config);
  }

  /** 测试 / debug 用：当前 buffer 只读快照。 */
  snapshot(): ReadonlyArray<ToolFailureBufferEntry> {
    return this.buffer.slice();
  }

  /** 当前归一化后的配置（含 env override 结果），便于 telemetry / debug。 */
  getConfig(): ToolFailureTrackerConfig {
    return this.config;
  }
}

// ─── 默认值 ────────────────────────────────────────────────────────

/**
 * **默认 streak 阈值**（D5 决议：参考既有实现 maxConsecutive=3 起步）。
 *
 * notice=3 是给用户的"早期感知"——3 次同类错通常已经是异常信号，发 notice
 * 让用户知道 runtime 在关注；nudge=5 才注入到 LLM，避免短瞬间网络抖动 / 偶发
 * upstream 5xx 直接打扰 LLM 推理路径。两者差值 2 是"用户提前看到 → 给 LLM
 * 自己再纠正一次的机会 → 仍不行才 system 注入"。
 *
 * 1 周 dogfood 后会基于 telemetry 调整。
 */
export const DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS: ToolFailureBudgetThresholds = {
  notice: 3,
  nudge: 5,
  // terminate=8：nudge=5 软提示后，再给模型 3 次自我纠正的机会；仍连续撞同
  // 一工具就硬停本轮。8 是产品口径——单轮 query 同一工具失败 8 次已是确定的
  // 死循环信号，继续只会烧 token。1 周 dogfood 后基于 telemetry 调整。
  terminate: 8,
};

/**
 * **默认环形缓冲大小**：N=10。
 *
 * 必须 ≥ nudge 阈值才能记录足够的 streak；N=10 给 nudge=5 留 100% 余量，
 * 同时不至于占太多内存（每 entry < 100 B，10 entry < 1 KB）。
 * 用户改 nudge 阈值到 ≥ 10 时，`mergeTrackerConfig` 会同步把 buffer 撑大。
 */
export const DEFAULT_TOOL_FAILURE_BUFFER_SIZE = 10;

/**
 * **默认排除 kinds**：以下 error_kind 不计入 streak。详见模块顶部 §排除 kinds。
 *
 * 这里用 `as const` 让类型系统在 `error-kinds.ts` 重命名时立即报错——
 * 任何枚举漂移会被 ts 编译期捕获，避免静默失效。
 */
export const DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS: ReadonlyArray<ToolErrorKind | string> = [
  // 用户主动 / 系统暂停（runtime 顶层 catalog kind，**不在** ToolErrorKind 联合里）
  'aborted',
  'aborted_by_user',
  'budget_skipped',
  // 调用前置失败（runtime 顶层）
  'unknown_tool',
  'schema_invalid',
  'validate_input',
  'plan_guard_deny',
  // 宿主层 bug —— 重试不会变好（W2 ToolErrorKind 枚举内）
  RUNTIME_MISCONFIG,
  INTERNAL_ERROR,
  HOST_UNSUPPORTED,
  // W3-R1 H3 修复 sentinel：query.ts 主循环在 `extractToolErrorCode` 返回 undefined
  // 时入队此 kind，让 buffer 保留"发生过失败"事实但不累积成 streak。该值与任何具体
  // kind 不匹配，本就不会连续累积；加入 excludeKinds 是双重防御——即使将来出现连续
  // 5 次都是 unknown_error_kind 的情形（极端边界），也明确排除而不误触发 nudge。
  'unknown_error_kind',
];

export const DEFAULT_TOOL_FAILURE_TRACKER_CONFIG: ToolFailureTrackerConfig = {
  enabled: true,
  thresholds: DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS,
  bufferSize: DEFAULT_TOOL_FAILURE_BUFFER_SIZE,
  excludeKinds: DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS,
};

const ASK_FORM_TOOL_NAME = 'ask_form';
const ASK_FORM_INVALID_PARAM_TERMINATE_THRESHOLD = 3;

// ─── Env 解析 ───────────────────────────────────────────────────────

/**
 * Env 阈值上限：避免运维误把 `999999` 当合法阈值，buffer 撑到不可控大小。
 * 100 是产品口径——单轮 query 通常 < 30 步，nudge=100 等于禁用 stall。
 */
const TOOL_FAILURE_THRESHOLD_MAX = 100;

/**
 * 从 env 读 streak 配置。无效值（非数 / 越界）静默回落到默认——env 解析层
 * 不警告，与 iteration-budget host-knobs 同惯例（host 启动期已 warn 过）。
 */
type EnvConfigOut = {
  enabled?: boolean;
  thresholds?: { notice?: number; nudge?: number; terminate?: number };
};

function readEnvConfig(env: NodeJS.ProcessEnv): ToolFailureTrackerConfigOverride {
  const out: EnvConfigOut = {};

  const enabled = parseTrackerEnvBoolean(env.TABTIN_TOOL_FAILURE_TRACKER_ENABLED);
  if (enabled !== undefined) out.enabled = enabled;

  const notice = parseTrackerEnvNumber(env.TABTIN_TOOL_FAILURE_NOTICE_STREAK, {
    min: 1,
    max: TOOL_FAILURE_THRESHOLD_MAX,
  });
  const nudge = parseTrackerEnvNumber(env.TABTIN_TOOL_FAILURE_NUDGE_STREAK, {
    min: 1,
    max: TOOL_FAILURE_THRESHOLD_MAX,
  });
  const terminate = parseTrackerEnvNumber(env.TABTIN_TOOL_FAILURE_TERMINATE_STREAK, {
    min: 1,
    max: TOOL_FAILURE_THRESHOLD_MAX,
  });

  if (notice !== undefined || nudge !== undefined || terminate !== undefined) {
    const thresholds: { notice?: number; nudge?: number; terminate?: number } = {};
    if (notice !== undefined) thresholds.notice = notice;
    if (nudge !== undefined) thresholds.nudge = nudge;
    if (terminate !== undefined) thresholds.terminate = terminate;
    out.thresholds = thresholds;
  }

  return out;
}

/**
 * 三层合并：默认 ← env ← 显式 options.config。
 *
 * 不变量校验在最后兜底：
 * - notice / nudge 必须为正整数（NaN / 负数 / 0 → 整 thresholds 回落默认）
 * - notice < nudge（违反 → 整 thresholds 回落默认；不局部修复以免反直觉）
 * - bufferSize ≥ nudge（违反 → 自动撑大到 nudge，保证能记下完整 streak）
 */
function mergeTrackerConfig(
  base: ToolFailureTrackerConfig,
  envConfig: ToolFailureTrackerConfigOverride,
  explicit?: ToolFailureTrackerConfigOverride,
): ToolFailureTrackerConfig {
  const enabled =
    explicit?.enabled ?? envConfig.enabled ?? base.enabled;

  // notice / nudge 走共用 3 层合并（含不变量回落）；terminate 是 failure-tracker
  // 私有的第三档，base 函数不认识它——`mergeTrackerThresholds` 的 `{...base}`
  // 会把 base.terminate 透传过来，env / explicit 的 terminate 在下方单独合并。
  const mergedNoticeNudge = mergeTrackerThresholds(
    base.thresholds,
    envConfig.thresholds,
    explicit?.thresholds,
    TOOL_FAILURE_THRESHOLD_MAX,
  );

  // terminate 单独合并 + 不变量校验：必须为正整数、> nudge、≤ max；任何违反
  // 都回落到「base.terminate 与 (nudge+1) 取大」——保证 terminate 永远严格大于
  // nudge（即使用户把 nudge 调得比 base.terminate 还高），不破坏 nudge 的有效配置。
  const rawTerminate =
    explicit?.thresholds?.terminate ??
    envConfig.thresholds?.terminate ??
    base.thresholds.terminate;
  const finalTerminate = normalizeTerminateThreshold(
    rawTerminate,
    mergedNoticeNudge.nudge,
    base.thresholds.terminate,
  );

  const finalThresholds: ToolFailureBudgetThresholds = {
    ...mergedNoticeNudge,
    terminate: finalTerminate,
  };

  // buffer 要能装下完整的 terminate 计数窗口（terminate > nudge，用 terminate 作下限）。
  const finalBuffer = applyTrackerBufferFloor(
    explicit?.bufferSize,
    base.bufferSize,
    finalThresholds.terminate,
    10_000,
  );

  const finalExcludeKinds =
    explicit?.excludeKinds ?? envConfig.excludeKinds ?? base.excludeKinds;

  return {
    enabled,
    thresholds: finalThresholds,
    bufferSize: finalBuffer,
    excludeKinds: finalExcludeKinds,
  };
}

function normalizeTerminateThreshold(
  rawTerminate: number,
  nudgeThreshold: number,
  fallback: number,
): number {
  const terminateValid =
    Number.isInteger(rawTerminate) &&
    rawTerminate > nudgeThreshold &&
    rawTerminate <= TOOL_FAILURE_THRESHOLD_MAX;
  return terminateValid ? rawTerminate : Math.max(fallback, nudgeThreshold + 1);
}

// ─── 纯函数 API（buffer mutation + evaluate）──────────────────────────
//
// 纯函数 helper 继续导出，让"无需 stateful class"的消费者（telemetry 离线重放 /
// 跨进程序列化 buffer 后再评估等）能直接复用 explicit context 路径。

export interface RecordToolFailureInput {
  readonly tool: string;
  readonly error_kind?: string;
}

export interface RecordToolFailureContext {
  readonly buffer: ToolFailureBufferEntry[];
  readonly config: ToolFailureTrackerConfig;
  readonly now?: () => number;
}

/**
 * 把一次失败 record append 到 buffer，自动滚动旧 entry 出环形缓冲。
 *
 * 与工厂方法 `tracker.recordFailure` 行为一致——后者就是调用本函数。
 *
 * **mutate 语义**：直接 push 到 `ctx.buffer` 数组（与 stateful 工厂语义对齐，
 * 避免每次 record 都返回新数组的开销）。
 *
 * **non-throwing**：空 tool / 空 kind / 配置 disabled 都静默跳过——run loop
 * 不能因 tracker bug 崩盘。
 */
export function recordToolFailure(
  input: RecordToolFailureInput,
  ctx: RecordToolFailureContext,
): void {
  if (!ctx.config.enabled) return;
  if (typeof input.tool !== 'string' || input.tool.length === 0) return;
  if (typeof input.error_kind !== 'string' || input.error_kind.length === 0) {
    return;
  }
  const now = ctx.now ?? Date.now;
  ctx.buffer.push({
    tool: input.tool,
    error_kind: input.error_kind,
    ts: now(),
  });
  while (ctx.buffer.length > ctx.config.bufferSize) {
    ctx.buffer.shift();
  }
}

/**
 * 成功调用——pop buffer 末尾连续匹配 (tool[, kind]) 的失败 record。
 *
 * - 传 `error_kind` → 同 tool + 同 kind 才 pop
 * - 不传 `error_kind` → 同 tool 即 pop（任意 kind）
 *
 * 详细语义见 module-level §streak break。
 */
export function recordToolSuccess(
  input: RecordToolFailureInput,
  ctx: RecordToolFailureContext,
): void {
  if (!ctx.config.enabled) return;
  if (typeof input.tool !== 'string' || input.tool.length === 0) return;
  while (ctx.buffer.length > 0) {
    const tail = ctx.buffer[ctx.buffer.length - 1]!;
    if (tail.tool !== input.tool) break;
    if (
      input.error_kind !== undefined &&
      tail.error_kind !== input.error_kind
    ) {
      break;
    }
    ctx.buffer.pop();
  }
}

/**
 * `WeakMap<config, Set<excludeKinds>>`——把 `Set` 的构造分摊到工厂阶段，
 * 避免每次 `evaluate()` 都 `new Set(excludeKinds)`。
 *
 * 用 WeakMap 而非给 config 加内部字段：保持 `ToolFailureTrackerConfig`
 * 是 readonly 的纯数据契约，缓存层是实现细节，不外泄；config 被 GC 时
 * 缓存自动释放。
 */
const EXCLUDE_KINDS_SET_CACHE = new WeakMap<
  ToolFailureTrackerConfig,
  ReadonlySet<string>
>();

function getExcludeKindsSet(
  config: ToolFailureTrackerConfig,
): ReadonlySet<string> {
  let set = EXCLUDE_KINDS_SET_CACHE.get(config);
  if (!set) {
    set = new Set(config.excludeKinds);
    EXCLUDE_KINDS_SET_CACHE.set(config, set);
  }
  return set;
}

/**
 * 评估当前 buffer 是否触达 notice / nudge 阈值。
 *
 * 与 `iteration-budget.ts::evaluateIterationBudget` 同形态——纯函数，输入
 * `(buffer, config)` 输出 `{ stage, trigger }`，**不读不写**外部状态。
 *
 * 算法：从 buffer 末尾向前扫描，统计连续同 (tool, kind) 长度，按阈值映射 stage。
 *
 * **性能**：O(N) where N 是 buffer.length（默认 ≤ 10）。`excludeKinds`
 * 通过 `getExcludeKindsSet` 缓存（WeakMap by config 引用），避免每次评估
 * 重新构造 Set —— 工厂内单 config 实例下 Set 构造只发生一次。
 */
export function evaluateToolFailureBudget(
  buffer: ReadonlyArray<ToolFailureBufferEntry>,
  config: ToolFailureTrackerConfig,
): ToolFailureBudgetEvaluation {
  if (!config.enabled || buffer.length === 0) {
    return { stage: 'normal', trigger: null };
  }
  const tail = buffer[buffer.length - 1]!;
  if (tail.error_kind === null) {
    return { stage: 'normal', trigger: null };
  }
  const excludeSet = getExcludeKindsSet(config);
  if (excludeSet.has(tail.error_kind)) {
    return { stage: 'normal', trigger: null };
  }
  const isAskFormInvalidParamTail =
    tail.tool === ASK_FORM_TOOL_NAME && tail.error_kind === INVALID_PARAM_FORMAT;

  // terminate（硬熔断）优先判定，且**不要求连续同 kind**——只数同 tool 在
  // buffer 内排除 excludeKinds 后的失败总数。这样"同一工具反复失败、error_kind
  // 在两类间抖动"（schema warn ↔ execute 内层校验交替）也能累计触发硬停，堵住
  // notice / nudge 的连续 streak 永远算不满的盲区。
  const toolFailureCount = countToolFailures(buffer, tail.tool, excludeSet);
  const askFormInvalidParamFailureCount = isAskFormInvalidParamTail
    ? countAskFormInvalidParamFailures(buffer)
    : 0;
  if (
    isAskFormInvalidParamTail &&
    askFormInvalidParamFailureCount >= ASK_FORM_INVALID_PARAM_TERMINATE_THRESHOLD
  ) {
    return {
      stage: 'terminate',
      trigger: { tool: tail.tool, error_kind: tail.error_kind, streak: askFormInvalidParamFailureCount },
    };
  }
  if (toolFailureCount >= config.thresholds.terminate) {
    return {
      stage: 'terminate',
      trigger: { tool: tail.tool, error_kind: tail.error_kind, streak: toolFailureCount },
    };
  }

  let streak = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i]!;
    if (entry.tool === tail.tool && entry.error_kind === tail.error_kind) {
      streak++;
    } else {
      break;
    }
  }

  if (streak >= config.thresholds.nudge) {
    return {
      stage: 'nudge',
      trigger: { tool: tail.tool, error_kind: tail.error_kind, streak },
    };
  }
  if (streak >= config.thresholds.notice) {
    return {
      stage: 'notice',
      trigger: { tool: tail.tool, error_kind: tail.error_kind, streak },
    };
  }
  return { stage: 'normal', trigger: null };
}

function countToolFailures(
  buffer: ReadonlyArray<ToolFailureBufferEntry>,
  tool: string,
  excludeSet: ReadonlySet<string>,
): number {
  let count = 0;
  for (const entry of buffer) {
    if (entry.tool === tool && entry.error_kind !== null && !excludeSet.has(entry.error_kind)) {
      count++;
    }
  }
  return count;
}

function countAskFormInvalidParamFailures(
  buffer: ReadonlyArray<ToolFailureBufferEntry>,
): number {
  let count = 0;
  for (const entry of buffer) {
    if (entry.tool === ASK_FORM_TOOL_NAME && entry.error_kind === INVALID_PARAM_FORMAT) {
      count++;
    }
  }
  return count;
}

// ─── Stage 升级判定 ──────────────────────────────────────────────────

const STAGE_RANK: Record<ToolFailureStage, number> = {
  normal: 0,
  notice: 1,
  nudge: 2,
  terminate: 3,
};

/**
 * 判定本轮评估相对"上次已通知阶段"是否产生**升级**。
 *
 * 与 `iteration-budget.ts::isStageUpgrade` 形态一致——消费侧（query.ts）
 * 据此决定是否 yield SYSTEM_NOTICE 给用户：升级才 yield，否则 noisy。
 *
 * **特殊语义**：当 `current === 'normal'` 时返回 false——streak 被打破时，
 * 消费侧应**额外**把已通知 stage 重置为 undefined，让下次升级能再次触发
 * （否则 prev=nudge / current=nudge 永远不升级，错过新 streak 的 nudge）。
 */
export function isToolFailureStageUpgrade(
  previous: ToolFailureStage | undefined,
  current: ToolFailureStage,
): boolean {
  if (current === 'normal') return false;
  const prevRank = STAGE_RANK[previous ?? 'normal'];
  const currentRank = STAGE_RANK[current];
  return currentRank > prevRank;
}

// ─── 文案构造 ────────────────────────────────────────────────────────

/**
 * notice 阶段——给用户看的中文 SYSTEM_NOTICE.content（runtime fallback）。
 *
 * **设计取舍**：主语用工具名 +「已连续失败 N 次」，避免"Agent 反复失败"
 * 的问责姿态；与用户可见 i18n 口径对齐（「xxx 已连续失败 N 次。…」）。
 *
 * 真实渲染走前端 i18n（`chat:systemNotice.toolFailureNotice`），用
 * `chat:toolName.${tool}` 二次翻译成中文工具名 + 用
 * `nudge_threshold - streak` 算"再失败 N 次将主动介入"。
 *
 * 本函数返回值只在 i18n key 缺失（旧客户端 / dev 启动期）时作为 fallback
 * 兜底——把 raw `tool` / `error_kind` 暴露出来便于 jsonl 离线排查精确定位
 * （前端永远走 i18n 路径不会看到这条 fallback）。D1 决议下，runtime
 * fallback 的设计目的是"离线 logging / jsonl 三件套有可读文本"，不是"老
 * 客户端兼容"，所以 raw 字面量出现在这里是合理的。
 */
export function buildToolFailureNoticeContent(
  trigger: ToolFailureBudgetTrigger,
): string {
  return (
    `「${trigger.tool}」已连续失败 ${trigger.streak} 次（${trigger.error_kind}）。` +
    '再失败时系统会提醒 Agent 换种方式尝试。'
  );
}

/**
 * nudge 阶段——给用户看的中文 SYSTEM_NOTICE.content（runtime fallback）。
 *
 * 同上 —— 真实渲染走前端 i18n（`chat:systemNotice.toolFailureNudge`），
 * 此处只是 fallback 兜底。语气比 notice 更主动，告诉用户系统已提醒 Agent
 * 换种方式尝试；主语仍用工具名避免"问责"姿态。
 */
export function buildToolFailureNudgeContent(
  trigger: ToolFailureBudgetTrigger,
): string {
  return (
    `「${trigger.tool}」已连续失败 ${trigger.streak} 次（${trigger.error_kind}）。` +
    '系统已提醒 Agent 换种方式尝试。'
  );
}

/**
 * 引用 ask 工具时的统一短描述——**不能**生成已下线的 `ask_question` /
 * `request_approval`（后者随  下架）。
 *
 * 工具产品语义（与 `ask-tools.ts` 对齐）：
 *   - `ask_user`：让用户在 2-4 个选项中选一个（路径分歧 / 替代方案 / 确认决策）；
 *      自动注入 Other 选项支持自由文本兜底。兼容旧 ask_choice 场景。
 *   - `ask_form`：让用户填一组结构化字段（凭证 / ID / URL / 自定义参数）；
 *      支持 input/textarea/upload/toggle/color 等 11 种字段类型。
 *
 * 注入文案使用以下两种形态：
 *   - **指向单一工具**：error_kind 已经强暗示 LLM 要"求授权"或"求选择"时
 *     用此形态，减少 LLM 选错；
 *   - **二选一**：默认情况，列出两个让 LLM 按对话上下文挑。
 */
const ASK_TOOLS_GENERIC_LINE =
  '通过 `ask_user`（多选问题 / 确认决策）或 `ask_form`（结构化输入字段）' +
  '让用户参与；根据用户接下来需要做的决策，选择合适的那一个';

/**
 * nudge 阶段——注入到 LLM 的 system prompt 段（中文）。
 *
 * 决策 4 全中文化（与 iteration-budget grace injection 同惯例；原 D4 决议
 * "必须英文"已由 2026-05-20 决策 4 推翻，见宪法 §3.6 修订）。
 *
 * **按 error_kind 多路分支**（W1 D6 决议产品边界对齐 —— LLM 引导路径与错误
 * 真因绑定；统一模板在路径级 / 任务级拒绝场景会**主动误导**）：
 *
 * - `mode_restricted`：LLM 应**调 `switch_mode`** 请求切到 agent 模式（需用户批准），
 *   不建议"换工具"（同模式下其他写工具同样被拦），也不建议"summarise 收尾"
 *   （任务本身能继续完成，只缺授权）。
 * - `command_blocked_by_policy`（hardline 红线）：命令本身高危，**不可换姿势**
 *   完成同一目标——LLM 应让用户给替代目标或直接放弃，**不**建议 "different tool"。
 * - 鉴权 / 权限类（`auth_failed` / `permission_denied`）：身份失效或 Space
 *   权限不足——LLM 应让用户重新登录或授权，优先 `ask_user`。
 * - **路径级 OS 拒绝**（`os_access_error`）：macOS TCC / Linux EPERM / Windows
 *   ACL 在路径级拦截，**所有**访问同路径的工具都会被同样拦下——不能"换工具"，
 *   只能让用户走系统授权（macOS"允许 TabTin 访问该文件夹"）后重试原操作；
 *   或换不同路径（如降级到 ~/Downloads 等已授权目录）；或文字总结收尾。
 * - 资源缺失类（`resource_not_found` / `skill_not_found` / `skill_disabled` / `skill_not_installed` 等）：让用户在选项里
 *   选正确目标——优先 `ask_user`。
 * - **denylist 软边界**（`command_denied_by_validator`）：命令本身合规但触
 *   carry 软边界规则（`>` 重定向 / `python -c` / `$VAR` 等），W1 已经在
 *   `metadata.hint` 里给了具体的"换姿势"建议（如 `>` → `write_file` 工具，
 *   `python -c` → `write_file` + `python script.py` 两步）。LLM 应**先回看
 *   最近一次 tool_result 的 hint**再选择动作，而不是凭空"换工具"。
 * - 默认（network / upstream / timeout 等"换姿势可解"类）：建议 `ask_user`
 *   + "different tool" + "summarise" 三选一。
 *
 * **关键约束**：
 * 1. 选项**必须**引用真实存在的工具（当前为 `ask_user` / `ask_form` / `switch_mode`）。
 *    旧 `ask_choice` / `ask_question` / `request_approval`已下线，
 *    若 nudge 引用旧名 LLM 按引导调用就会再撞一堵墙——正是 W3 要消除的反模式。
 *    详见 W1-R2-B.1 / harness §7 #3 反思条目。
 * 2. **header 强制要求 LLM 回看 `metadata.hint`** —— W1+W2 投入了大量精力
 *    做 hint 体系（22 条 deny hint + 后端翻译层 + i18n），但 stall detector
 *    在最关键的"LLM 撞墙最严重的时候"如果不让它回看 hint，LLM 看到 nudge
 *    后只能凭空"换工具"浪费步数，hint 资产没参与决策——北极星指标"步数 ≤
 *    22"会不达标。所以无论分支怎么走，header 都要先提醒"看 hint"。
 *
 * 文案结构（参考既有实现 "Your previous tool call was rejected..." 风格）：
 * 1. 描述事实（连续 N 次失败 + 同 error_kind）
 * 2. 明确"continuing this approach is unlikely to succeed"
 * 3. 提醒回看 metadata.hint（最重要的复用 W2 资产）
 * 4. 按分支给 2-3 条可选动作
 *
 * 不硬编码具体工具 / 错误案例（如 PDF / parse_document）——模板插值 `{tool}`
 * `{error_kind}` `{N}`，让任何场景都能复用。
 */
export function buildToolFailureNudgeSystemInjection(
  trigger: ToolFailureBudgetTrigger,
): string {
  const header =
    `[系统 / 停滞检测] 你已连续 ${trigger.streak} 次调用 \`${trigger.tool}\`，` +
    `全部以相同的 error_kind 失败：\`${trigger.error_kind}\`。` +
    '继续这种做法不太可能成功。' +
    '重要：之前每条 tool_result 都包含 `metadata.hint` 字段，说明如何从这个具体错误中恢复——' +
    '在选择下面的动作之前，请先回看最近一条 hint。';

  if (trigger.error_kind === 'mode_restricted') {
    return (
      header +
      '当前 Agent 模式正在拦截这些调用（例如 plan / ask / study 模式不允许写操作）。可考虑：\n' +
      '(1) 调用 `switch_mode` 请求切换到 Agent 模式（需用户在卡片上批准）后再重试，\n' +
      '(2) 调用 `ask_user` 确认用户是想切换模式，还是选一个符合当前模式的其他动作，\n' +
      '(3) 总结目前的进展并结束本轮——让用户决定是否切换模式。'
    );
  }

  if (
    trigger.error_kind === 'auth_failed' ||
    trigger.error_kind === 'permission_denied'
  ) {
    return (
      header +
      '用户必须显式重新认证或授予访问权限——重试同样的调用不会有帮助。可考虑：\n' +
      '(1) 用 `ask_user` 或纯文本告知用户需要重新认证 / 授予缺失的权限，等用户完成后再重试，\n' +
      '(2) 如果动作可以换个方式表达，就试试别的工具或思路（例如用读代替写，' +
      '或换一个用户已有访问权限的资源），\n' +
      '(3) 总结目前的进展并结束本轮——带清晰交接的部分进展，' +
      '好过连续几十次认证失败。'
    );
  }

  if (trigger.error_kind === 'os_access_error') {
    return (
      header +
      '操作系统在路径级别拒绝了访问（macOS TCC / Linux EPERM / Windows ACL）——' +
      '对同一路径换用别的工具会撞上同样的拒绝，因为限制是按路径生效的，不是按工具。可考虑：\n' +
      '(1) 用 `ask_user` 或纯文本请用户授予操作系统级别的权限（例如 macOS ' +
      '的"文件和文件夹"/"完全磁盘访问权限"），用户确认完成后重试原操作，\n' +
      '(2) 改在用户已经授权的其他路径下操作（例如退回到 ' +
      '`~/Downloads`、workspace 根目录，或之前 tool_result 已能成功读写的某个文件夹），\n' +
      '(3) 总结目前的进展并结束本轮——带清晰交接（说明路径、你尝试的动作、' +
      '以及需要什么授权）的部分进展，好过连续几十次操作系统级别的拒绝。'
    );
  }

  if (
    trigger.error_kind === 'resource_not_found' ||
    trigger.error_kind === 'skill_not_found' ||
    trigger.error_kind === 'skill_disabled' ||
    trigger.error_kind === 'skill_not_installed' ||
    trigger.error_kind === 'tool_result_not_found'
  ) {
    return (
      header +
      '请求的资源不存在或已不可用——用同样的标识符重试会持续失败。可考虑：\n' +
      '(1) 调用 `ask_user`（多选）让用户从他们实际拥有的资源里选出正确的目标，\n' +
      '(2) 换一种查找策略（按名称而不是 id 搜索，或先列出可用项），\n' +
      '(3) 总结目前的进展并结束本轮——明确告诉用户哪个资源没找到、以及继续下去需要什么。'
    );
  }

  if (trigger.error_kind === 'command_blocked_by_policy') {
    return (
      header +
      '该命令被 hardline 安全策略拦截，无论以何种形式都不能再尝试。可考虑：\n' +
      '(1) 调用 `ask_user` 请用户给一个不需要这个危险动作的替代目标，\n' +
      '(2) 总结目前的进展并结束本轮——带清晰交接的部分进展，' +
      '好过连续几十次被拦截的尝试。'
    );
  }

  if (trigger.error_kind === 'command_denied_by_validator') {
    return (
      header +
      '该命令被软边界校验规则拒绝（例如 `>` 重定向 / 内联 `python -c` / `$VAR` 展开）。' +
      '之前每条 tool_result 都已在 `hint` 字段里指明规则并给出具体的替代姿势——' +
      '这些就是为在同一目标下成功而设计的动作。可考虑：\n' +
      '(1) 按最近一条 `metadata.hint` 切换调用姿势（例如把 ' +
      '`echo … > file` 换成 `write_file` 工具，或把 `python -c "…"` 拆成 `write_file` + ' +
      '`python script.py` 两步），\n' +
      `(2) 当目标本身不清楚时，${ASK_TOOLS_GENERIC_LINE}，\n` +
      '(3) 如果在被拒规则下无法重新表述目标，就总结目前的进展并结束本轮。'
    );
  }

  return (
    header +
    '可考虑：\n' +
    `(1) ${ASK_TOOLS_GENERIC_LINE}，\n` +
    '(2) 换一个工具或思路（不同的读取/解析方法、' +
    '不同的查找策略，或不同的数据源），\n' +
    '(3) 总结目前的进展并结束本轮——带清晰交接的部分进展，' +
    '好过连续几十次失败。'
  );
}

// ─── 内部辅助 ────────────────────────────────────────────────────────

/**
 * 测试 / debug 用：当前模块导出的状态机映射，便于单测断言 stage 顺序与
 * `isToolFailureStageUpgrade` 一致。**不**导出给生产消费者。
 */
export const _STAGE_RANK_FOR_TESTING: Readonly<Record<ToolFailureStage, number>> = STAGE_RANK;
