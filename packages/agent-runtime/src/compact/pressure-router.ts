/**
 * Pressure Router —— 按模型 context 比例的压力分档路由。
 *
 * 按约定实现 多层压缩分档（`src/services/compact/autoCompact.ts:32-91`
 * + `src/query.ts:405-507`）的**按压力比例决定走哪档**思路。
 *
 * ## W1（压缩路径简化）后的简化
 *
 * 删除了三块自创策略后，路由档位精简为：
 *   - `none` —— 无压缩
 *   - `microcompact` —— time-based MC 触发区（白名单工具旧 result 占位）
 *   - `llmSummary` —— LLM 总结（auto-condense → auto-compact）
 *   - `emergency` —— hard trim + blocking guard
 *
 * 旧版本里的 `sessionMemory` 档位（与 W1 删除的两块自创模块"session memory
 * 改写" + "按层次裁剪"配套）已删——两个自创策略都在 W1 一并干掉。
 * `microCompactStart` 阈值原本与那块裁剪逻辑共享触发区，现在专用于 time-based MC。
 *
 * ## 设计原则
 *
 * 1. **比例不写死在代码里**：`PressureThresholds` 接口封装三个阈值，
 *    `DEFAULT_PRESSURE_THRESHOLDS` 是保守默认（兼容历史行为）。
 *
 * 2. **可从 `EngineConfig.pressureThresholds` 覆盖**：不同模型 context window
 *    可能需要不同阈值（claude sonnet 200k / claude opus 1M / gpt-4o 128k 的
 *    "危险区"比例并不相同）。宿主可按模型能力表动态注入。
 *
 * 3. **与 `ContextBudget` 向后兼容**：现有 `ContextBudget.compactThreshold=0.85`
 *    继续作为"auto-condense / auto-compact 触发点"使用，`llmSummaryStart` 默认
 *    即对齐 `compactThreshold`——旧测试不改配置即可继续通过。
 *
 * ## 档位梯度（按约定实现 语义）
 *
 * | 档位 | 区间 | 跑什么 |
 * |------|------|--------|
 * | `none` | `[0, microCompactStart)` | 无压缩（全传） |
 * | `microcompact` | `[microCompactStart, llmSummaryStart)` | time-based MC（白名单工具旧 result 占位） |
 * | `llmSummary` | `[llmSummaryStart, emergencyStart)` | 上一档 + auto-condense / auto-compact（LLM summary） |
 * | `emergency` | `[emergencyStart, 1]` | 上一档 + hard trim + blocking guard |
 *
 * 关键不变量：**更高档位一定包含更低档位的所有动作**（"累积触发"语义）。
 */

import type {
  ContextBudget,
} from '../engine/contracts/context-capability.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * 按压力比例分档的阈值结构。
 *
 * 排序约束：`microCompactStart <= llmSummaryStart < emergencyStart`（micro 档
 * 允许与 llmSummary 档重合——重合时 micro 区间为空，语义上"跳过该档"）。
 * 违反约束时 `resolvePressureThresholds` 回落到
 * `DEFAULT_PRESSURE_THRESHOLDS`（不抛错，打 console.warn）。
 *
 * 每个字段取值范围 `[0, 1]`；超出区间同样回落默认。
 */
export interface PressureThresholds {
  /** time-based microcompact 起点（低成本，零 LLM 调用） */
  microCompactStart: number;
  /** LLM summary 起点（auto-condense → auto-compact） */
  llmSummaryStart: number;
  /** emergency hard trim + blocking guard 起点 */
  emergencyStart: number;
}

/** 压力档位枚举（low → high） */
export type PressureStage =
  | 'none'
  | 'microcompact'
  | 'llmSummary'
  | 'emergency';

// ─── Defaults ────────────────────────────────────────────────────────

/**
 * **DEFAULT**：保守默认。
 *
 * - `microCompactStart=0.75`：time-based MC 起点。
 * - `llmSummaryStart=0.85`：对齐 `DEFAULT_CONTEXT_BUDGET.compactThreshold`。
 * - `emergencyStart=0.95`：对齐 `DEFAULT_CONTEXT_BUDGET.emergencyThreshold`。
 */
export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = {
  microCompactStart: 0.75,
  llmSummaryStart: 0.85,
  emergencyStart: 0.95,
};

/**
 * **RECOMMENDED**：方案推荐的"严格从低到高"阈值 —— 75/90/95。
 *
 * 切换到这套默认需要宿主显式覆盖 `EngineConfig.pressureThresholds`。
 *
 * 和 DEFAULT 相比的差异：
 *   - `llmSummaryStart=0.90` 比 0.85 更保守：LLM summary 是真的 API 调用 +
 *     昂贵，让 time-based MC 多吃一档再上 LLM。
 */
export const RECOMMENDED_PRESSURE_THRESHOLDS: PressureThresholds = {
  microCompactStart: 0.75,
  llmSummaryStart: 0.90,
  emergencyStart: 0.95,
};

function isValidPressureThresholds(thresholds: PressureThresholds): boolean {
  const inRange = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
  const allInRange =
    inRange(thresholds.microCompactStart) &&
    inRange(thresholds.llmSummaryStart) &&
    inRange(thresholds.emergencyStart);
  const orderOk =
    thresholds.microCompactStart <= thresholds.llmSummaryStart &&
    thresholds.llmSummaryStart < thresholds.emergencyStart;

  return allInRange && orderOk;
}

// ─── Resolve ─────────────────────────────────────────────────────────

/**
 * 从 `ContextBudget` + `EngineConfig.pressureThresholds` 组合算出最终阈值。
 *
 * 逻辑：
 *   1. 起点 = `DEFAULT_PRESSURE_THRESHOLDS`（向后兼容）
 *   2. 如宿主传了 `budget.compactThreshold` / `emergencyThreshold`，让
 *      `llmSummaryStart` / `emergencyStart` 自动对齐（PRD 里 contextBudget 是
 *      "产品级阈值配置"，pressureThresholds 是"分档路由细节"——产品级设置应
 *      生效于路由层）。`compactThreshold` 压得比默认 `microCompactStart` 还低
 *      时（常见于测试用极小阈值强制触发压缩），`microCompactStart` 自动跟随
 *      钳到同值——micro 区间收空表示"跳过该档"，而不是整体报非法。
 *   3. 若宿主显式传了 `pressureThresholds.xxx`，覆盖第 2 步结果。
 *   4. 校验 `micro <= llmSummary < emergency` + [0, 1] 范围；失败则整体回落
 *      DEFAULT 并 console.warn。
 */
export function resolvePressureThresholds(
  budget: ContextBudget | undefined,
  override: Partial<PressureThresholds> | undefined,
): PressureThresholds {
  const baseLlmSummaryStart =
    budget?.compactThreshold ?? DEFAULT_PRESSURE_THRESHOLDS.llmSummaryStart;
  const base: PressureThresholds = {
    // compactThreshold 低于默认 micro 起点时，micro 起点跟随钳到同值
    //（micro 区间收空 = 跳过该档），避免"产品级阈值调低"被误判为非法配置。
    microCompactStart: Math.min(
      DEFAULT_PRESSURE_THRESHOLDS.microCompactStart,
      baseLlmSummaryStart,
    ),
    llmSummaryStart: baseLlmSummaryStart,
    emergencyStart: budget?.emergencyThreshold ?? DEFAULT_PRESSURE_THRESHOLDS.emergencyStart,
  };

  const merged: PressureThresholds = {
    microCompactStart: override?.microCompactStart ?? base.microCompactStart,
    llmSummaryStart: override?.llmSummaryStart ?? base.llmSummaryStart,
    emergencyStart: override?.emergencyStart ?? base.emergencyStart,
  };

  if (!isValidPressureThresholds(merged)) {
    // 侵入式 warn 而非 throw：让配置错误降级为可观察事件而非崩溃
    // eslint-disable-next-line no-console
    console.warn(
      '[pressure-router] Invalid PressureThresholds (must be 0-1 and microCompactStart <= llmSummaryStart < emergencyStart); falling back to DEFAULT. Got:',
      merged,
    );
    return { ...DEFAULT_PRESSURE_THRESHOLDS };
  }

  return merged;
}

// ─── Stage decision ──────────────────────────────────────────────────

/**
 * 按 pressure + thresholds 算出当前档位。
 *
 * 语义：**取最高命中档位**。例如 pressure=0.92 ∈ [0.85, 0.95) → `llmSummary`；
 * pressure=0.97 ∈ [0.95, 1] → `emergency`。
 */
export function computePressureStage(
  pressure: number,
  thresholds: PressureThresholds,
): PressureStage {
  if (!Number.isFinite(pressure) || pressure < 0) return 'none';
  if (pressure >= thresholds.emergencyStart) return 'emergency';
  if (pressure >= thresholds.llmSummaryStart) return 'llmSummary';
  if (pressure >= thresholds.microCompactStart) return 'microcompact';
  return 'none';
}

// ─── Stage-specific should-run helpers ───────────────────────────────

/**
 * 是否应跑 time-based microcompact？microcompact 档位及以上。
 *
 * 实际触发还需要 `timeBasedMicroCompact.enabled=true`（`EngineConfig` 层
 * 决定开不开）+ `lastAssistantTimestamp` 有值 + gap 过阈值——这三件事
 * `maybeTimeBasedMicrocompact` 内部判定，本 helper 只回答"在当前压力下，是否
 * 应当**尝试**跑 time-based MC"。
 */
export function shouldRunTimeBasedMicrocompact(
  pressure: number,
  thresholds: PressureThresholds,
): boolean {
  const stage = computePressureStage(pressure, thresholds);
  return stage !== 'none';
}

/** 是否应跑 LLM summary 流水（auto-condense + auto-compact）？llmSummary 档位及以上。 */
export function shouldRunLlmSummary(
  pressure: number,
  thresholds: PressureThresholds,
): boolean {
  const stage = computePressureStage(pressure, thresholds);
  return stage === 'llmSummary' || stage === 'emergency';
}
