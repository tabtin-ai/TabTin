/**
 * Tool tracker shared utilities — small DRY helpers reused by
 * `tool-failure-tracker` and `tool-repetition-tracker` (siblings: one
 * tracks failure streaks, the other same-input success repetition).
 *
 * Extracted (literal / pattern duplication — single source for invariants):
 *   - `parseTrackerEnvBoolean`  — env on/off alias parsing
 *   - `parseTrackerEnvNumber`   — env numeric range parsing (custom min/max)
 *   - `mergeTrackerThresholds`  — 3-layer notice/nudge merge with wholesale
 *      fallback on invariant violation (a half-honoured config is worse mental
 *      model UX than an honest wholesale fallback — both trackers agree).
 *   - `applyTrackerBufferFloor` — buffer ≥ nudge floor + range validation
 *
 * Kept inline per tracker (extraction would net-grow LoC or hurt readability):
 *   - `STAGE_RANK` literal + `isStageUpgrade` (~10 lines each; drift risk low —
 *     literals are 0/1/2, visible in any PR review)
 *   - `record` / `evaluate` algorithms (failure: tail-streak; repetition: window count)
 *   - `createXxxTracker` factories (per-instance buffer types differ)
 *   - notice / nudge content + system injection (failure has 7 error_kind branches,
 *     repetition has one — sharing forces parameterised strings, less readable)
 *
 * **DRY value > LoC saving**: `applyTrackerBufferFloor` and `mergeTrackerThresholds`
 * net-grow LoC (~14-18 lines extra) but consolidate the *invariant validation* to
 * one place — the criterion for keeping is "would a future maintainer change this
 * invariant in only one place vs forget to change it in both?". When the answer is
 * the latter, extraction wins despite negative LoC math (e.g. fixing a bug in the
 * "notice >= nudge fallback" rule should require touching exactly one function).
 *
 * Internal — not re-exported from `engine/index.ts`.
 */

// ─── Env 解析 ─────────────────────────────────────────────────────────

/** Parse env boolean (`on/true/1/enabled/yes` ↔ `off/false/0/disabled/no`). Non-throwing. */
export function parseTrackerEnvBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return undefined;
  if (['on', 'true', '1', 'enabled', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'disabled', 'no'].includes(v)) return false;
  return undefined;
}

/**
 * Parse env numeric value, `Math.floor` + inclusive `[min, max]` range.
 * NaN / non-finite / out-of-range → undefined; `'2.9'` → `2`. Non-throwing.
 */
export function parseTrackerEnvNumber(
  raw: string | undefined,
  opts: { readonly min: number; readonly max: number },
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  if (n < opts.min || n > opts.max) return undefined;
  return Math.floor(n);
}

// ─── Thresholds 合并 ─────────────────────────────────────────────────

export interface TrackerNoticeNudgeThresholds {
  readonly notice: number;
  readonly nudge: number;
}

/**
 * 3-layer merge `default ← env ← explicit` with wholesale invariant fallback.
 *
 * Invariants: positive integer notice / nudge, notice < nudge, nudge ≤ max;
 * any violation → entire thresholds fall back to `base` (deliberate — a
 * half-honoured config is worse mental model UX than an honest fallback).
 * Non-throwing.
 *
 * **Generic preservation**: when valid we spread `base` first then override
 * with `merged` so any extra readonly fields on `T` (beyond `notice`/`nudge`)
 * survive — currently the two trackers' thresholds shapes happen to be exact
 * `TrackerNoticeNudgeThresholds`, but if a future tracker adds e.g. a `decay`
 * field to `T`, this implementation already honours it.
 */
export function mergeTrackerThresholds<T extends TrackerNoticeNudgeThresholds>(
  base: T,
  envThresholds: Partial<TrackerNoticeNudgeThresholds> | undefined,
  explicitThresholds: Partial<TrackerNoticeNudgeThresholds> | undefined,
  max: number,
): T {
  const merged: TrackerNoticeNudgeThresholds = {
    notice:
      explicitThresholds?.notice ??
      envThresholds?.notice ??
      base.notice,
    nudge:
      explicitThresholds?.nudge ??
      envThresholds?.nudge ??
      base.nudge,
  };

  const valid =
    Number.isInteger(merged.notice) &&
    Number.isInteger(merged.nudge) &&
    merged.notice >= 1 &&
    merged.nudge > merged.notice &&
    merged.nudge <= max;

  return (valid ? { ...base, ...merged } : { ...base }) as T;
}

/**
 * Buffer size floor: validate explicit (range / integer / positive — fall back
 * to `baseBuffer` on violation), then `Math.max` against `nudgeFloor` so the
 * buffer always holds a complete streak / count.
 */
export function applyTrackerBufferFloor(
  explicitBuffer: number | undefined,
  baseBuffer: number,
  nudgeFloor: number,
  max: number,
): number {
  const rawBuffer = explicitBuffer !== undefined ? explicitBuffer : baseBuffer;
  const safeBuffer =
    Number.isInteger(rawBuffer) && rawBuffer >= 1 && rawBuffer <= max
      ? rawBuffer
      : baseBuffer;
  return Math.max(safeBuffer, nudgeFloor);
}
