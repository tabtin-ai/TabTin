/**
 * Wave 6 — Tool repetition tracker (sibling of `tool-failure-tracker`).
 *
 * 当 LLM 在 30 秒窗口内对同一个工具用**完全相同**的 input 反复成功 emit 时，
 * runtime 主动给下一轮 LLM context 注入一段简短英文 system reminder，让它
 * 知道"用户/系统已经收到你刚才的调用结果，不要再用同 input 重发"。同时给
 * 真实用户发一条中文 SYSTEM_NOTICE 让他们感知 runtime 在帮兜底。
 *
 * ### 业务背景
 *
 * calculator dogfood：Kimi 2.5 调 `ask_choice(question="...minimal?")`，用户
 * 选了 minimal，回灌后 thinking 里明确"用户已选 minimal"——但下一轮 tool_use
 * 仍然生成同款 `ask_choice(question="...minimal?")`，连续 4 次。
 *
 * 这不是失败 streak（每次调用都是 `success`），所以 `tool-failure-tracker`
 * 的"末尾连续 error_kind"算法**永远不会触发**（line 495：`if (tail.error_kind === null) return normal`）。
 * Lane A 已把 `Don't retry the identical action blindly` / `One question per response` /
 * `After user answers don't re-ask` 三条加进 `execution.md`，但 prompt-only
 * 防御对非 Anthropic 模型遵从度不可靠。Wave 6 在 runtime 加机械防护，与
 * Lane A 的 prompt 兜底叠加形成**两层防御**。
 *
 * ### 设计参考
 *
 * - **历史**：没有 runtime-level 同 (tool, input) 成功复读检测。靠
 *   `prompts.ts:231` "Don't retry the identical action blindly" + Anthropic
 *   模型对自家 prompt 的高遵从度兜底。`denialTracking.ts` 只追踪 permission
 *   **拒绝** streak（不是工具成功复读）。
 * - **TabTin tool-failure-tracker**：本 tracker 的 SSoT 来源。状态机、stage
 *   升级判定、英文 system injection 风格、env override 命名、per-query 实例、
 *   non-throwing 惯例、三层合并默认/env/explicit + 不变量回落默认——全部沿用。
 *
 * ### 与 tool-failure-tracker 的边界（sibling 共存，不替换）
 *
 * | 维度 | tool-failure-tracker | tool-repetition-tracker |
 * |---|---|---|
 * | 触发信号 | 失败 streak（连续同 tool+kind 失败） | 成功复读（窗口内同 tool+inputDigest 计数） |
 * | buffer entry | `{ tool, error_kind, ts }` | `{ tool, inputDigest, ts }` |
 * | 算法 | 末尾连续同 (tool, kind) 长度 | 窗口内同 (tool, digest) 总计数（不要求连续） |
 * | streak 打破 | recordSuccess pop 末尾 / 不同 tool / 不同 kind | 自然过期（窗口外 ts 被 prune） / 末尾换 (tool, digest) |
 * | 跨轮信号（tool-loop-guard 闭包） | failureStage / pendingStallNudge | repetitionStage / pendingRepetitionNudge |
 * | env 命名 | `TABTIN_TOOL_FAILURE_*` | `TABTIN_TOOL_REPETITION_*` |
 *
 * **不动 tool-failure-tracker 内部**——两者并行计量，互不干扰。同一轮工具
 * 失败可以同时让 tool-failure 升 stage、tool-repetition 不升；反之亦然。
 *
 * ### 状态机
 *
 * `normal → notice → nudge` 单调递增（在同一窗口生命周期内）。窗口失效
 * （末尾换 (tool, digest) / 老 entry 全部过期）后回 normal，state stage
 * 重置为 undefined，让下次升级能重新触发。tracker 是 **per-query** 实例
 * （tool-loop-guard 每个 run `new ToolRepetitionTracker()` fresh），与
 * `tool-failure-tracker` 同生命周期。
 *
 * - **normal**：未达阈值，runtime 不做事。
 * - **notice**：达 `notice` 阈值（默认 2）——给用户发一条中文 SYSTEM_NOTICE，
 *   告诉用户"工具 X 在 30s 内被同输入调用 N 次"；**不**注入 LLM context
 *   （nudge 阶段才注入，避免单次过敏感的复读 false-positive 打扰 LLM）。
 * - **nudge**：达 `nudge` 阈值（默认 3）——除发 SYSTEM_NOTICE，**注入**
 *   一段英文 system reminder 到下一轮 LLM context，明确告诉 LLM "Do NOT
 *   re-issue the same tool with the same input"。
 * - **terminate**：达 `terminate` 阈值（默认 6）——runtime **静默硬停
 *   本轮**（query.ts 消费侧 yield DONE + break，**不**向用户 emit 文案提示），
 *   不再调用 LLM。notice / nudge 是"软提示帮模型停手"（弱模型可能不遵从），
 *   terminate 是"硬刹车防 token 烧穿"，不依赖模型遵从度。
 *
 * ### 阈值数字依据
 *
 * tool-failure-tracker 用 3/5（"失败 1-2 次合理，3 次才是异常信号"）；
 * 本 tracker 用 **2/3**：
 *   - 第 1 次成功调用：合法（normal）。
 *   - 第 2 次同 input 成功：异常信号（notice）—— 用户/系统已经收到你的
 *     第一次结果，第二次重发说明 LLM 没看回灌或 attention 失焦。
 *   - 第 3 次同 input 成功：必须打断（nudge）—— LLM 已经确实在闷头复读，
 *     不主动注入 system reminder 它不会停。
 *
 * 实证依据：calculator dogfood 4 次复读；2/3 阈值让 runtime 在第 3 次时
 * 介入是**最早可介入时机**——第 1 次合法不能动，第 2 次给用户感知（notice），
 * 第 3 次必须 inject reminder（nudge）。3/5 阈值会让第 5 次才介入，calculator
 * 一共才 4 次就够烦了——晚一步等于失效。
 *
 * ### 窗口策略
 *
 * 30 秒滑动窗口（按 `ts` 过期）。每次 `recordSuccess` 后 in-place prune
 * 过期 entry；evaluate 用**窗口内同 (tool, digest) 总计数**（**不要求连续**）。
 *
 * **为什么不要求连续**：
 *   - 同 (tool, digest) 复读的反模式不依赖"中间是否被打断"。LLM 调一次
 *     `ask_choice(input)` 拿到 user response 后，30s 内再调同 input
 *     就是 ignore 了 user response，中间夹一次 `read_file` 不改变这个事实。
 *   - per-query tracker：用户新消息 = 新 query = 新 tracker → 窗口自然清空，
 *     "用户显式 reframe"场景不会被误判。
 *
 * **已知 limitation（漏报场景，不是误伤）**：
 *   - **ask 类工具用户慢思考超过 windowMs**：用户对 ask_choice 第一次思考
 *     ≥ 30s 才回答，第二次 ask_choice 触发时第一次的 ts 已经落出窗口 →
 *     count=1 → 不触发。calculator dogfood 里用户每次都秒答（4 次密集），
 *     这个边界没踩到；真出现"用户慢思考 + LLM 复读"场景属于漏报，不是
 *     误伤，可接受（runtime 不能比"30s 窗口"更激进，否则会把"用户深思后
 *     合理重试"误判为复读）。
 *   - **跨 query 复读**：用户新消息 = 新 query = 新 tracker，跨 query 的
 *     同 input 复读不会累积。这是有意设计——跨 query 已经经过用户中介，
 *     视为合法 reframe。
 *
 * ### inputDigest 算法
 *
 * `SHA256(JSON.stringify(input))` 的前 16 字节（hex 32 字符）。
 *   - **UNDEFINED safe**：input 为 undefined / null → 用空字符串 hash（同
 *     digest，意为"无 input 工具的连续复读"也算复读）。
 *   - **NaN safe**：JSON.stringify 自动把 NaN / Infinity 转为 `null`，digest
 *     稳定。
 *   - **Object key order safe（best-effort）**：JS object 不保证 key 顺序
 *     稳定，但同一 LLM 同一轮通常按相同顺序生成相同 input —— 不严格按 key
 *     字典序排序是为了避免在内层做 deep traverse；实际复读场景里 LLM 重发
 *     的 input 字面 99% 完全相同（包括 key 顺序）。如果未来 dogfood 发现
 *     "key 顺序乱跳"导致 false-negative，再把 SortedJsonStringify 加进来。
 *   - **大 input**：用前 16 字节而不是完整 32 字节，是因为复读检测精度对
 *     128 bit 已经远超合理范围（同 query 内碰撞几乎不可能），同时减少 buffer
 *     占用。
 *
 * ### env override
 *
 * 沿用 `TABTIN_TOOL_FAILURE_*` 命名约定 → `TABTIN_TOOL_REPETITION_*`：
 *   - `TABTIN_TOOL_REPETITION_TRACKER_ENABLED`：true/false 总开关
 *   - `TABTIN_TOOL_REPETITION_NOTICE_COUNT`：notice 阈值（默认 2）
 *   - `TABTIN_TOOL_REPETITION_NUDGE_COUNT`：nudge 阈值（默认 3）
 *   - `TABTIN_TOOL_REPETITION_WINDOW_MS`：窗口毫秒（默认 30000）
 *
 * 解析规则与 tool-failure-tracker 完全对齐：非法值（NaN / 越界 / notice ≥
 * nudge）整 thresholds 回落默认（不局部修复以免反直觉）。
 *
 * ### 设计不变量
 *
 * - **stateful 工厂**：与 iteration-budget 的纯函数 evaluate 不同，本 tracker
 *   持有 buffer 状态（与 EngineState 同生命周期，per-query 实例）。
 * - **defensive**：阈值非法值由 `mergeTrackerConfig` 在 fabric 阶段就回落到
 *   默认，evaluate 永远返回合法 stage。
 * - **non-throwing**：record / evaluate 永远不抛错——runtime 主循环不能因
 *   tracker bug 崩盘。
 * - **env override only at fabric**：env 变量在工厂创建时读一次，运行期不
 *   重读（与 tool-failure-tracker / iteration-budget host-knobs 同惯例 ——
 *   env 是启动配置不是热更新）。
 */

import { createHash } from 'node:crypto';
import {
  applyTrackerBufferFloor,
  mergeTrackerThresholds,
  parseTrackerEnvBoolean,
  parseTrackerEnvNumber,
} from './tool-tracker-base.js';

// ─── 公共类型 ────────────────────────────────────────────────────────

export type ToolRepetitionStage = 'normal' | 'notice' | 'nudge' | 'terminate';

/**
 * 缓冲条目：每条都是一次成功调用的指纹。`inputDigest` 缺失（input 完全
 * 拿不到）时回落到空串 sentinel，让"无 input 工具反复成功调用"也能触发
 * 复读检测。
 */
export interface ToolRepetitionBufferEntry {
  readonly tool: string;
  readonly inputDigest: string;
  readonly ts: number;
}

export interface ToolRepetitionThresholds {
  /** 触发 notice（用户中文提示）的最小窗口内同 (tool, digest) 计数。默认 2。 */
  readonly notice: number;
  /** 触发 nudge（中文 + 英文注入）的最小计数。默认 3；必须 > notice。 */
  readonly nudge: number;
  /**
   * 触发 terminate（runtime 硬熔断本轮）的最小窗口内同 (tool, digest) 计数。
   * 默认 6；必须 > nudge。
   *
   * notice / nudge 是"软提示帮模型停手"（弱模型可能不遵从、继续用相同输入复读
   * 烧 token）；terminate 是"硬刹车防烧穿"——窗口内同一工具+相同输入成功复读到
   * 阈值就硬停本轮，不依赖模型遵从度。覆盖"工具真成功 / dedup 命中后模型仍
   * byte-identical 重发"的 token 烧穿场景（ 同源问题的对称防护）。
   */
  readonly terminate: number;
}

export interface ToolRepetitionTrigger {
  readonly tool: string;
  readonly inputDigest: string;
  readonly count: number;
  /** 触发时使用的窗口毫秒数（用于文案构造）。 */
  readonly windowMs: number;
}

export interface ToolRepetitionEvaluation {
  readonly stage: ToolRepetitionStage;
  readonly trigger: ToolRepetitionTrigger | null;
}

export interface ToolRepetitionTrackerConfig {
  readonly enabled: boolean;
  readonly thresholds: ToolRepetitionThresholds;
  /** 滑动窗口毫秒数。默认 30_000（30s）。 */
  readonly windowMs: number;
  /**
   * buffer 上限。窗口内极端高频调用（比如某 bug 让工具 1ms 调一次）才会
   * 撑到这个值；正常使用远远碰不到。默认 256。
   */
  readonly maxBufferSize: number;
}

export interface ToolRepetitionTrackerOptions {
  readonly config?: Partial<ToolRepetitionTrackerConfig> & {
    readonly thresholds?: Partial<ToolRepetitionThresholds>;
  };
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

/**
 * Tracker 实例。所有方法都是 **non-throwing**——record 操作永远不抛
 * （即使 tool 是空字符串、input 是循环引用），evaluate 永远返回合法 stage。
 * tracker 单 bug 不能让主循环崩。
 */
export class ToolRepetitionTracker {
  private readonly buffer: ToolRepetitionBufferEntry[] = [];
  private readonly config: ToolRepetitionTrackerConfig;
  private readonly now: () => number;

  constructor(options?: ToolRepetitionTrackerOptions) {
    const env = options?.env ?? process.env;
    const envConfig = readEnvConfig(env);
    this.config = mergeTrackerConfig(
      DEFAULT_TOOL_REPETITION_TRACKER_CONFIG,
      envConfig,
      options?.config,
    );
    this.now = options?.now ?? Date.now;
  }

  /**
   * 工具成功时调用。`tool` 空 / 不可序列化 input 都静默忽略——LLM 主循环
   * 不该被 tracker 异常打断。
   */
  recordSuccess(input: { tool: string; input?: unknown }): void {
    recordToolRepetitionSuccess(input, {
      buffer: this.buffer,
      config: this.config,
      now: this.now,
    });
  }

  /** 评估当前缓冲是否触达 notice / nudge 阈值。 */
  evaluate(): ToolRepetitionEvaluation {
    return evaluateToolRepetition(this.buffer, this.config, this.now());
  }

  /** 测试 / debug 用：当前 buffer 只读快照。 */
  snapshot(): ReadonlyArray<ToolRepetitionBufferEntry> {
    return this.buffer.slice();
  }

  /** 当前归一化后的配置（含 env override 结果），便于 telemetry / debug。 */
  getConfig(): ToolRepetitionTrackerConfig {
    return this.config;
  }
}

// ─── 默认值 ────────────────────────────────────────────────────────

/**
 * **默认阈值（D6 决议）**：notice=2 / nudge=3。
 *
 * 比 `tool-failure-tracker` 的 3/5 更敏感，因为：
 *   - 失败重试 1-2 次是 LLM 在尝试修复（合理动作）；3 次才是异常。
 *   - 成功复读是 LLM 已拿到答案还重发（**纯反模式**）；2 次就该 notice，
 *     3 次就必须 nudge——再晚 calculator dogfood 就失效了（共 4 次复读）。
 *
 * 1 周 dogfood 后会基于 telemetry 调整。
 */
export const DEFAULT_TOOL_REPETITION_THRESHOLDS: ToolRepetitionThresholds = {
  notice: 2,
  nudge: 3,
  // terminate=6：nudge=3 软提示后，再给模型 3 次停手机会；窗口内同一工具+相同
  // 输入仍复读到 6 次就硬停本轮。30s 窗口内同输入 6 次成功复读是确定的死循环
  // 信号。1 周 dogfood 后基于 telemetry 调整。
  terminate: 6,
};

/** 默认窗口：30 秒（与 PRD §Wave 6 北极星条款一致）。 */
export const DEFAULT_TOOL_REPETITION_WINDOW_MS = 30_000;

/**
 * 默认 buffer 上限：256。
 *
 * 30s 窗口正常使用远到不了——LLM 单 query 通常 < 30 步。256 是防御极端
 * 情形（比如某 bug 让工具 ms 级重入）的内存兜底，每 entry < 100 B，
 * 256 entry < 26 KB，可接受。用户改 nudge 阈值到 ≥ 256 时配置层会撑大。
 */
export const DEFAULT_TOOL_REPETITION_MAX_BUFFER = 256;

export const DEFAULT_TOOL_REPETITION_TRACKER_CONFIG: ToolRepetitionTrackerConfig = {
  enabled: true,
  thresholds: DEFAULT_TOOL_REPETITION_THRESHOLDS,
  windowMs: DEFAULT_TOOL_REPETITION_WINDOW_MS,
  maxBufferSize: DEFAULT_TOOL_REPETITION_MAX_BUFFER,
};

// ─── Env 解析 ───────────────────────────────────────────────────────

/**
 * Env 阈值上限：避免运维误把 `999999` 当合法阈值。100 是产品口径——单
 * 30s 窗口正常 < 30 次工具调用，nudge=100 等于禁用复读检测。
 */
const TOOL_REPETITION_THRESHOLD_MAX = 100;

/** Window 上限：1 小时。超过 1 小时的"复读检测"语义已偏离 calculator 场景。 */
const TOOL_REPETITION_WINDOW_MAX_MS = 60 * 60 * 1000;

/** Window 下限：1 秒。低于 1s 容易在合法连续调用上误报。 */
const TOOL_REPETITION_WINDOW_MIN_MS = 1_000;

/**
 * 从 env 读复读检测配置。无效值（非数 / 越界）静默回落到默认——env 解析层
 * 不警告，与 tool-failure-tracker / iteration-budget host-knobs 同惯例。
 */
type EnvConfigOut = {
  enabled?: boolean;
  thresholds?: { notice?: number; nudge?: number; terminate?: number };
  windowMs?: number;
};

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<ToolRepetitionTrackerConfig> & {
  thresholds?: Partial<ToolRepetitionThresholds>;
} {
  const out: EnvConfigOut = {};

  const enabled = parseTrackerEnvBoolean(env.TABTIN_TOOL_REPETITION_TRACKER_ENABLED);
  if (enabled !== undefined) out.enabled = enabled;

  const notice = parseTrackerEnvNumber(env.TABTIN_TOOL_REPETITION_NOTICE_COUNT, {
    min: 1,
    max: TOOL_REPETITION_THRESHOLD_MAX,
  });
  const nudge = parseTrackerEnvNumber(env.TABTIN_TOOL_REPETITION_NUDGE_COUNT, {
    min: 1,
    max: TOOL_REPETITION_THRESHOLD_MAX,
  });
  const terminate = parseTrackerEnvNumber(env.TABTIN_TOOL_REPETITION_TERMINATE_COUNT, {
    min: 1,
    max: TOOL_REPETITION_THRESHOLD_MAX,
  });
  if (notice !== undefined || nudge !== undefined || terminate !== undefined) {
    const thresholds: { notice?: number; nudge?: number; terminate?: number } = {};
    if (notice !== undefined) thresholds.notice = notice;
    if (nudge !== undefined) thresholds.nudge = nudge;
    if (terminate !== undefined) thresholds.terminate = terminate;
    out.thresholds = thresholds;
  }

  const windowMs = parseTrackerEnvNumber(env.TABTIN_TOOL_REPETITION_WINDOW_MS, {
    min: TOOL_REPETITION_WINDOW_MIN_MS,
    max: TOOL_REPETITION_WINDOW_MAX_MS,
  });
  if (windowMs !== undefined) out.windowMs = windowMs;

  return out as Partial<ToolRepetitionTrackerConfig> & {
    thresholds?: Partial<ToolRepetitionThresholds>;
  };
}

/**
 * 三层合并：默认 ← env ← 显式 options.config。
 *
 * 不变量校验：
 * - notice / nudge 必须为正整数（NaN / 负数 / 0 → 整 thresholds 回落默认）
 * - notice < nudge（违反 → 整 thresholds 回落默认）
 * - windowMs 在 [1s, 1h] 范围（违反 → 回落默认）
 * - maxBufferSize ≥ nudge（违反 → 自动撑大到 nudge）
 */
function mergeTrackerConfig(
  base: ToolRepetitionTrackerConfig,
  envConfig: Partial<ToolRepetitionTrackerConfig> & {
    thresholds?: Partial<ToolRepetitionThresholds>;
  },
  explicit?: Partial<ToolRepetitionTrackerConfig> & {
    thresholds?: Partial<ToolRepetitionThresholds>;
  },
): ToolRepetitionTrackerConfig {
  const enabled = explicit?.enabled ?? envConfig.enabled ?? base.enabled;

  // notice / nudge 走共用 3 层合并；terminate 是本 tracker 私有的第三档，base
  // 函数不认识它（`{...base}` 透传 base.terminate），env / explicit 的 terminate
  // 在下方单独合并 + 校验（与 tool-failure-tracker 同模式）。
  const mergedNoticeNudge = mergeTrackerThresholds(
    base.thresholds,
    envConfig.thresholds,
    explicit?.thresholds,
    TOOL_REPETITION_THRESHOLD_MAX,
  );

  const rawTerminate =
    explicit?.thresholds?.terminate ??
    envConfig.thresholds?.terminate ??
    base.thresholds.terminate;
  const finalTerminate = normalizeRepetitionTerminateThreshold(
    rawTerminate,
    mergedNoticeNudge.nudge,
    base.thresholds.terminate,
  );

  const finalThresholds: ToolRepetitionThresholds = {
    ...mergedNoticeNudge,
    terminate: finalTerminate,
  };

  // windowMs 是 repetition tracker 专属（failure tracker 没有时间窗概念），不抽 base。
  const finalWindow = normalizeRepetitionWindow(
    explicit?.windowMs ?? envConfig.windowMs ?? base.windowMs,
    base.windowMs,
  );

  // buffer 要能装下完整的 terminate 计数窗口（terminate > nudge，用 terminate 作下限）。
  const finalBuffer = applyTrackerBufferFloor(
    explicit?.maxBufferSize,
    base.maxBufferSize,
    finalThresholds.terminate,
    100_000,
  );

  return {
    enabled,
    thresholds: finalThresholds,
    windowMs: finalWindow,
    maxBufferSize: finalBuffer,
  };
}

function normalizeRepetitionTerminateThreshold(
  rawTerminate: number,
  nudgeThreshold: number,
  fallback: number,
): number {
  const terminateValid =
    Number.isInteger(rawTerminate) &&
    rawTerminate > nudgeThreshold &&
    rawTerminate <= TOOL_REPETITION_THRESHOLD_MAX;
  return terminateValid ? rawTerminate : Math.max(fallback, nudgeThreshold + 1);
}

function normalizeRepetitionWindow(rawWindow: number, fallback: number): number {
  const validWindow =
    Number.isFinite(rawWindow) &&
    rawWindow >= TOOL_REPETITION_WINDOW_MIN_MS &&
    rawWindow <= TOOL_REPETITION_WINDOW_MAX_MS;
  return validWindow ? Math.floor(rawWindow) : fallback;
}

// ─── inputDigest 计算 ───────────────────────────────────────────────

/**
 * 计算 input 的稳定指纹。
 *
 * - undefined / null / 不可序列化（循环引用 / BigInt 等）→ 空串 sentinel。
 *   这意味着"无 input 工具的反复调用"会被识别为复读（`refresh_session()`
 *   被反复调用是真实反模式，应触发）；不可序列化 input 极罕见且不该让
 *   tracker 抛错。
 * - 正常 input → SHA256(JSON.stringify(input)).slice(0, 32)（hex 32 字符
 *   = 16 字节，128 bit）。
 *
 * **non-throwing**：JSON.stringify 抛错（循环引用 / BigInt）时 catch 后
 * 回落到空串 sentinel；空串 sentinel 不抑制复读检测——这是有意识选择，
 * 让 tracker 在异常 input 场景仍能保护用户。
 */
function computeInputDigest(input: unknown): string {
  if (input === undefined || input === null) return '';
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return '';
  }
  if (typeof serialized !== 'string') return '';
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

/**
 * 测试 / 高级消费者用：暴露 digest 算法本身。生产路径走 `recordSuccess` /
 * `recordToolRepetitionSuccess` 自动调用，正常消费者不需要直接调。
 */
export function buildToolRepetitionInputDigest(input: unknown): string {
  return computeInputDigest(input);
}

// ─── 纯函数 API ──────────────────────────────────────────────────────

export interface RecordToolRepetitionInput {
  readonly tool: string;
  readonly input?: unknown;
}

export interface RecordToolRepetitionContext {
  readonly buffer: ToolRepetitionBufferEntry[];
  readonly config: ToolRepetitionTrackerConfig;
  readonly now: () => number;
}

/**
 * Append 一次成功调用，自动按 windowMs prune 过期 entry，并按 maxBufferSize
 * 兜底滚动旧 entry。
 *
 * **mutate 语义**：直接 push 到 `ctx.buffer` 数组。
 *
 * **non-throwing**：空 tool / 不可序列化 input / 配置 disabled 都静默跳过。
 */
export function recordToolRepetitionSuccess(
  input: RecordToolRepetitionInput,
  ctx: RecordToolRepetitionContext,
): void {
  if (!ctx.config.enabled) return;
  if (typeof input.tool !== 'string' || input.tool.length === 0) return;

  const now = ctx.now();
  const digest = computeInputDigest(input.input);
  ctx.buffer.push({ tool: input.tool, inputDigest: digest, ts: now });

  pruneExpiredEntries(ctx.buffer, now, ctx.config.windowMs);
  while (ctx.buffer.length > ctx.config.maxBufferSize) {
    ctx.buffer.shift();
  }
}

/**
 * Prune in-place：移除 ts < (now - windowMs) 的所有 entry。
 *
 * 用 splice 而不是 filter 是为了与 `recordToolFailure` 的 mutate buffer
 * 语义对齐（外部消费者可能持有 buffer 引用）。
 */
function pruneExpiredEntries(
  buffer: ToolRepetitionBufferEntry[],
  now: number,
  windowMs: number,
): void {
  const cutoff = now - windowMs;
  let dropCount = 0;
  while (dropCount < buffer.length && buffer[dropCount]!.ts < cutoff) {
    dropCount++;
  }
  if (dropCount > 0) buffer.splice(0, dropCount);
}

/**
 * 评估当前 buffer 是否触达 notice / nudge 阈值。
 *
 * 算法：
 *   1. prune 过期 entry
 *   2. 若 buffer 空 → normal
 *   3. 取末尾 entry 的 (tool, digest)，统计 buffer 内同 (tool, digest) 总数
 *   4. count ≥ nudge → nudge；count ≥ notice → notice；else normal
 *
 * **为什么取末尾 entry**：evaluate 在每次 record 后立即调用，相当于评估
 * "刚刚的这次调用是不是触发复读阈值"。如果末尾换了 (tool, digest) →
 * count=1 → normal，自然打破 streak。
 *
 * **性能**：O(N) where N ≤ maxBufferSize（默认 256，30s 窗口正常 << 30）。
 *
 * **non-throwing**：永远返回合法 stage。
 */
export function evaluateToolRepetition(
  buffer: ToolRepetitionBufferEntry[],
  config: ToolRepetitionTrackerConfig,
  now: number,
): ToolRepetitionEvaluation {
  if (!config.enabled) {
    return { stage: 'normal', trigger: null };
  }
  pruneExpiredEntries(buffer, now, config.windowMs);
  if (buffer.length === 0) {
    return { stage: 'normal', trigger: null };
  }

  const tail = buffer[buffer.length - 1]!;
  let count = 0;
  for (const entry of buffer) {
    if (entry.tool === tail.tool && entry.inputDigest === tail.inputDigest) {
      count++;
    }
  }

  if (count >= config.thresholds.terminate) {
    return {
      stage: 'terminate',
      trigger: {
        tool: tail.tool,
        inputDigest: tail.inputDigest,
        count,
        windowMs: config.windowMs,
      },
    };
  }
  if (count >= config.thresholds.nudge) {
    return {
      stage: 'nudge',
      trigger: {
        tool: tail.tool,
        inputDigest: tail.inputDigest,
        count,
        windowMs: config.windowMs,
      },
    };
  }
  if (count >= config.thresholds.notice) {
    return {
      stage: 'notice',
      trigger: {
        tool: tail.tool,
        inputDigest: tail.inputDigest,
        count,
        windowMs: config.windowMs,
      },
    };
  }
  return { stage: 'normal', trigger: null };
}

// ─── Stage 升级判定 ──────────────────────────────────────────────────

const STAGE_RANK: Record<ToolRepetitionStage, number> = {
  normal: 0,
  notice: 1,
  nudge: 2,
  terminate: 3,
};

/**
 * 判定本轮评估相对"上次已通知阶段"是否产生**升级**。
 *
 * 与 `tool-failure-tracker.isToolFailureStageUpgrade` 形态完全一致——消费侧
 * （query.ts）据此决定是否 yield SYSTEM_NOTICE 给用户：升级才 yield，否则
 * noisy。
 *
 * **特殊语义**：当 `current === 'normal'` 时返回 false——窗口失效时，消费侧
 * 应**额外**把已通知 stage 重置为 undefined，让下次升级能再次触发（否则
 * prev=nudge / current=nudge 永远不升级，错过新窗口的 nudge）。
 */
export function isToolRepetitionStageUpgrade(
  previous: ToolRepetitionStage | undefined,
  current: ToolRepetitionStage,
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
 * **设计取舍**：与 tool-failure-tracker 的 fallback 同模式，主语用工具
 * 名而非 Agent，避免"问责"姿态；产品主语用 TabTin。
 *
 * 真实渲染走前端 i18n（`chat:systemNotice.toolRepetitionNotice`）；本函数
 * 返回值只在 i18n key 缺失（旧客户端 / dev 启动期）时作为 fallback。raw
 * `tool` / `count` / `windowMs` 出现在文案里是为了 jsonl 离线排查精确定位。
 *
 * **格式细节**：用「」全角括号包工具名（chat 流不渲染 markdown，反引号会
 * 显示成字面字符）；末尾加 escape 句让用户在自己主动重做场景里能放心忽略。
 */
export function buildToolRepetitionNoticeContent(
  trigger: ToolRepetitionTrigger,
): string {
  const seconds = Math.round(trigger.windowMs / 1000);
  return (
    `工具「${trigger.tool}」在 ${seconds} 秒内被相同输入调用了 ${trigger.count} 次。` +
    'TabTin 正在关注，再重复几次会主动提示 Agent 别再重发。' +
    '（如果是你刚才让 Agent 重做的，可以忽略这条提示）'
  );
}

/**
 * nudge 阶段——给用户看的中文 SYSTEM_NOTICE.content（runtime fallback）。
 *
 * 同上 —— 真实渲染走前端 i18n（`chat:systemNotice.toolRepetitionNudge`）。
 * 语气比 notice 更主动，告诉用户 runtime 已介入；末尾给"用户接管把手"——
 * 真实用户视角 review 共识：runtime 介入但 LLM 仍闷头复读时，用户需要明确
 * 知道自己可以怎么接管，而不是干等 runtime 反复发同款 nudge。
 */
export function buildToolRepetitionNudgeContent(
  trigger: ToolRepetitionTrigger,
): string {
  const seconds = Math.round(trigger.windowMs / 1000);
  return (
    `工具「${trigger.tool}」在 ${seconds} 秒内被相同输入调用了 ${trigger.count} 次。` +
    'TabTin 已主动提示 Agent 别再用相同输入重发，请稍候——' +
    '如果几轮后还在重复，你可以直接给一句新指令（比如「用我刚才的回答继续」或「换个方式问」）。'
  );
}

/**
 * nudge 阶段——注入到 LLM 的 system prompt 段（中文）。
 *
 * 决策 4 全中文化（与 tool-failure-tracker / iteration-budget grace 同惯例；
 * 原"必须英文"已由 2026-05-20 决策 4 推翻，见宪法 §3.6 修订）。
 *
 * 文案结构（参考既有实现 "Your previous tool call was rejected..." 风格）：
 * 1. 描述事实（窗口内相同 input 的次数）
 * 2. 明确"用户/系统已经收到你之前的调用结果"
 * 3. 给出明确的下一步指令——不要重发同 input；如果已得到答案就基于
 *    答案继续；如果你以为没拿到答案，应该看回灌而不是重发；如果你
 *    确实需要不同信息，换一个 input。
 *
 * **不引用具体 tool / kind**——模板插值 `{tool}` `{count}` `{seconds}`，
 * 让任何场景都能复用。**不**引用 ask 工具列表（与 tool-failure 不同）：
 * 因为复读不一定是 ask 工具问题，可能是任何工具的 input 复读。
 *
 * **关键约束**（沿用 tool-failure-tracker 的 W3-R1-P1-1 修复经验）：
 * 不引用已下线工具名（`ask_question` 已下线）；不硬编码具体场景。
 */
export function buildToolRepetitionNudgeSystemInjection(
  trigger: ToolRepetitionTrigger,
): string {
  const seconds = Math.round(trigger.windowMs / 1000);
  return (
    `[系统 / 重复检测] 你在最近 ${seconds} 秒内用**完全相同的输入**调用了 \`${trigger.tool}\` ` +
    `${trigger.count} 次。用户/系统已经收到你之前调用的结果，` +
    '答案（如果有）也已经在你的对话历史里了。' +
    '不要用相同输入重发同一个工具。请改为选择以下之一：\n' +
    `(1) 回看对话中 \`${trigger.tool}\` 最近一条 tool_result——` +
    '你需要的信息已经在那里了；\n' +
    '(2) 如果你确实需要不同的信息，用**不同的输入**调用工具' +
    '（换个说法提问、改路径、调参数）；\n' +
    '(3) 如果之前的结果已经给了你所需的内容，就继续任务的下一步，' +
    '而不是重新查询；\n' +
    '(4) 如果你卡住了或不确定，用纯文本总结目前的进展并结束本轮——' +
    '带清晰交接的部分进展，好过几十次完全相同的重发。'
  );
}

// ─── 内部辅助 ────────────────────────────────────────────────────────

/**
 * 测试 / debug 用：当前模块导出的状态机映射，便于单测断言 stage 顺序与
 * `isToolRepetitionStageUpgrade` 一致。**不**导出给生产消费者。
 */
export const _STAGE_RANK_FOR_TESTING: Readonly<Record<ToolRepetitionStage, number>> = STAGE_RANK;
