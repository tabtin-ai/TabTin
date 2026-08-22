/**
 * Risk level vocabulary alignment .
 *
 * Two vocabularies coexist in TabTin:
 * - **Registration / product**: `safe` / `review` / `strict`
 *   (Django BaseTool.risk_level, action-tools manifest, tool cards)
 * - **Wire / HITL**: `low` / `medium` / `high`
 *   (approval_requested events, PermissionRequest, LocalPermissionHandler)
 *
 * Semantic mapping (from Django `BaseTool.risk_level` docstring):
 * - safe  ≈ low    — read-only / low impact
 * - review ≈ medium — write ops worth a user glance
 * - strict ≈ high  — high-risk, always needs explicit approval
 *
 * `request_approval` ask tool uses `safe` / `review` / `high` (not `strict`);
 * `high` maps to wire `high` the same as `strict`.
 *
 * Wire output always normalizes to `low` / `medium` / `high` for backward
 * compatibility with existing clients and persisted approval snapshots.
 */

import { z } from 'zod';

/** Product / tool registration vocabulary. */
export type ToolRegistrationRiskLevel = 'safe' | 'review' | 'strict';

/** HITL wire vocabulary (subset of contracts `RiskLevel`, excludes `critical`). */
export type ApprovalWireRiskLevel = 'low' | 'medium' | 'high';

const TO_WIRE: Record<string, ApprovalWireRiskLevel> = {
  safe: 'low',
  review: 'medium',
  strict: 'high',
  high: 'high',
  critical: 'high',
  low: 'low',
  medium: 'medium',
};

const TO_REGISTRATION: Record<string, ToolRegistrationRiskLevel> = {
  safe: 'safe',
  review: 'review',
  strict: 'strict',
  low: 'safe',
  medium: 'review',
  high: 'strict',
};

const WIRE_OUTPUT = ['low', 'medium', 'high'] as const;

function normalizeKey(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize any known risk level string to wire `low` / `medium` / `high`.
 * Unknown values fall back to `fallback` (default `medium`).
 */
export function normalizeToWireRiskLevel(
  input: unknown,
  fallback: ApprovalWireRiskLevel = 'medium',
): ApprovalWireRiskLevel {
  const key = normalizeKey(input);
  if (!key) return fallback;
  return TO_WIRE[key] ?? fallback;
}

/**
 * Normalize any known risk level string to registration `safe` / `review` / `strict`.
 * Unknown values return `null`.
 */
export function normalizeToRegistrationRiskLevel(
  input: unknown,
): ToolRegistrationRiskLevel | null {
  const key = normalizeKey(input);
  if (!key) return null;
  return TO_REGISTRATION[key] ?? null;
}

export interface ToolRiskSource {
  /** Product registration vocab (`Tool.riskLevel` / `RegisteredTool.risk_level`). */
  riskLevel?: string;
  /** Legacy fallback when registration level is absent. */
  isReadOnly?: boolean;
  /** Per-invocation write classifier; preferred over static isReadOnly when set. */
  isWriteOp?: (input: unknown) => boolean;
}

/**
 * Resolve wire risk for HITL from a runtime `Tool`:
 * 1. Prefer explicit `riskLevel` (safe/review/strict) when present
 * 2. Fallback to `isReadOnly ? low : medium` (legacy heuristic)
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
 * Per tool-call wire risk: honors `isWriteOp(input)` when registration riskLevel
 * is absent so shell grep is low and shell rm stays medium.
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

/**
 * Zod schema for `ApprovalActionRequest.risk_level`.
 * Accepts registration + wire + ask-tool vocab on input; output is always wire format.
 */
export const ApprovalWireRiskLevelSchema = z.preprocess(
  (val) => normalizeToWireRiskLevel(val, 'medium'),
  z.enum(WIRE_OUTPUT),
);
