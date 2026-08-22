/**
 * Wire risk-level helpers（ Stage 5c）。
 *
 * 自 `@tabtin/agent-wire` risk-level 迁入；映射表与字面量保持对齐。
 */

import type { ApprovalWireRiskLevel } from './wire-payloads.js';

const TO_WIRE: Record<string, ApprovalWireRiskLevel> = {
  safe: 'low',
  review: 'medium',
  strict: 'high',
  high: 'high',
  critical: 'high',
  low: 'low',
  medium: 'medium',
};

function normalizeKey(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** 任意已知 risk 字符串 → wire `low` / `medium` / `high`。 */
export function normalizeToWireRiskLevel(
  input: unknown,
  fallback: ApprovalWireRiskLevel = 'medium',
): ApprovalWireRiskLevel {
  const key = normalizeKey(input);
  if (!key) return fallback;
  return TO_WIRE[key] ?? fallback;
}

export interface ToolRiskSource {
  riskLevel?: string;
  isReadOnly?: boolean;
  /** 按本次 input 判写；存在时优先于静态 isReadOnly（shell grep vs rm）。 */
  isWriteOp?: (input: unknown) => boolean;
}

/**
 * 从 runtime Tool 推断 HITL wire risk：
 * 1. 显式 `riskLevel`（safe/review/strict/…）
 * 2. 否则 `isReadOnly ? low : medium`
 *
 * 无显式 riskLevel 时请优先用 `inferWireRiskLevelForToolCall`，以便
 * `isWriteOp(input)` 按 invocation 区分只读 shell。
 */
export function inferWireRiskLevelFromTool(
  tool: ToolRiskSource,
): ApprovalWireRiskLevel {
  if (tool.riskLevel !== undefined && tool.riskLevel !== '') {
    const key = normalizeKey(tool.riskLevel);
    if (key && TO_WIRE[key]) {
      return TO_WIRE[key];
    }
  }
  return tool.isReadOnly ? 'low' : 'medium';
}

/**
 * 按本次 tool call 推断 wire risk（HITL 审批卡用）。
 * 无显式 riskLevel 时：`isWriteOp(input)` → medium / low；再回退静态 isReadOnly。
 */
export function inferWireRiskLevelForToolCall(
  tool: ToolRiskSource,
  input: unknown,
): ApprovalWireRiskLevel {
  if (tool.riskLevel !== undefined && tool.riskLevel !== '') {
    const key = normalizeKey(tool.riskLevel);
    if (key && TO_WIRE[key]) {
      return TO_WIRE[key];
    }
  }
  if (typeof tool.isWriteOp === 'function') {
    try {
      return tool.isWriteOp(input) ? 'medium' : 'low';
    } catch {
      return 'medium';
    }
  }
  return tool.isReadOnly ? 'low' : 'medium';
}
