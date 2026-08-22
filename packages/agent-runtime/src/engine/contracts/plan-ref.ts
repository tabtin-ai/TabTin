/**
 * PlanRef helpers（ Stage 5c）。
 *
 * 自 `@tabtin/agent-wire` plan-proposal 迁入；key 格式与 wire 对齐。
 */

import type { PlanRef } from './wire-payloads.js';

/** PlanRef → 稳定字符串 key（`file:<path>` / `document:<id>`）。 */
export function planRefKey(ref: PlanRef): string {
  return ref.kind === 'file' ? `file:${ref.path}` : `document:${ref.document_id}`;
}

export function planRefEquals(
  a: PlanRef | null | undefined,
  b: PlanRef | null | undefined,
): boolean {
  if (!a || !b) return false;
  return planRefKey(a) === planRefKey(b);
}

/** `planRefKey` 字符串 → PlanRef；无前缀视为 legacy document id。 */
export function parsePlanRefKey(key: string | null | undefined): PlanRef | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file:')) {
    const p = trimmed.slice('file:'.length);
    return p ? { kind: 'file', path: p } : null;
  }
  if (trimmed.startsWith('document:')) {
    const id = trimmed.slice('document:'.length);
    return id ? { kind: 'document', document_id: id } : null;
  }
  return { kind: 'document', document_id: trimmed };
}

export function resolvePlanRef(payload: {
  plan_ref?: PlanRef;
  plan_document_id?: string;
}): PlanRef | null {
  if (payload.plan_ref) return payload.plan_ref;
  if (payload.plan_document_id) {
    return { kind: 'document', document_id: payload.plan_document_id };
  }
  return null;
}

/** document → id；file → path（过渡期兼容字段）。 */
export function planRefToLegacyId(ref: PlanRef): string {
  return ref.kind === 'file' ? ref.path : ref.document_id;
}
