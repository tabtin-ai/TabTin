/**
 * Streaming assistant-text repetition detector .
 *
 * Tool-loop guards (`tool-failure-tracker` / `tool-repetition-tracker`) only
 * fire after tool results. Weak models (e.g. Kimi k2.6 on scheduled tasks)
 * can instead enter a **single-stream text degeneration**: keep emitting
 * closing meta-phrases like「最终。输出。结束。发送。」without `tool_use`.
 * Stall timeout never trips while bytes keep arriving; iteration budget is
 * too coarse. This detector is the mid-stream hard brake for that blind spot.
 *
 * Pure / non-throwing. Callers decide whether to abort the upstream LLM stream
 * and emit a silent hard-stop DONE (same philosophy as  tool terminate).
 *
 * : only fires on units that contain Unicode letters (incl. CJK).
 * Symbol-only periods (`|---`, long `-` runs, ASCII rules) are structural
 * syntax, not linguistic degeneration, and must not hard-stop the stream.
 *
 * Repetition means an exact identical text period repeats continuously at the
 * tail. Similar structure with different content (branch lists, file trees,
 * tables) must not stop the stream.
 */

export type TextRepetitionReason = 'phrase_period';

export interface TextRepetitionHit {
  readonly triggered: true;
  readonly reason: TextRepetitionReason;
  /** Short sample of the repeating unit (for telemetry). */
  readonly evidence: string;
  readonly windowChars: number;
}

/** Minimum assistant text length before we consider degeneracy. */
export const TEXT_REPETITION_MIN_CHARS = 120;

/** Only re-evaluate after this many new chars (cheap incremental sampling). */
export const TEXT_REPETITION_CHECK_STRIDE = 40;

/** Look at the trailing window only — early unique prose stays free. */
const WINDOW_CHARS = 800;

/** Exact period must repeat at least this many times at the tail. */
const MIN_PERIOD_REPEATS = 8;

function normalizeForPeriod(text: string): string {
  // Collapse whitespace so 「最终。 输出。」and「最终。输出。」share a period.
  return text.replace(/\s+/g, '');
}

function detectPhrasePeriod(normalized: string): TextRepetitionHit | null {
  if (normalized.length < TEXT_REPETITION_MIN_CHARS) return null;
  const window = normalized.length > WINDOW_CHARS
    ? normalized.slice(-WINDOW_CHARS)
    : normalized;

  // Exact continuous periodicity at the tail: unit of length p repeating
  // ≥ MIN_PERIOD_REPEATS with no drift.
  for (let p = 2; p <= 32; p++) {
    if (window.length < p * MIN_PERIOD_REPEATS) continue;
    const unit = window.slice(-p);
    if (!/\S/.test(unit)) continue;
    // Linguistic degeneracy only — ignore pure punctuation/structure cycles.
    if (!/\p{L}/u.test(unit)) continue;
    let matches = 0;
    let pos = window.length - p;
    while (pos >= 0 && window.slice(pos, pos + p) === unit) {
      matches += 1;
      pos -= p;
    }
    if (matches >= MIN_PERIOD_REPEATS) {
      return {
        triggered: true,
        reason: 'phrase_period',
        evidence: unit.slice(0, 32),
        windowChars: window.length,
      };
    }
  }
  return null;
}

/**
 * Detect degenerate streaming text. Returns null when healthy / too short.
 *
 * Only **phrase_period**: trailing exact period of length 2–32 repeats ≥8×
 * continuously, and the unit contains ≥1 Unicode letter (catches「最终。输出。
 * 结束。发送。」cycling after whitespace normalize; skips symbol-only
 * table/rule periods; does not trip on similar-but-not-identical patterns).
 */
export function detectStreamingTextRepetition(text: string): TextRepetitionHit | null {
  if (text.length < TEXT_REPETITION_MIN_CHARS) return null;

  const rawWindow = text.length > WINDOW_CHARS ? text.slice(-WINDOW_CHARS) : text;
  return detectPhrasePeriod(normalizeForPeriod(rawWindow));
}

/** True when enough new chars arrived to justify another detect call. */
export function shouldCheckTextRepetition(
  textLength: number,
  lastCheckedLength: number,
): boolean {
  if (textLength < TEXT_REPETITION_MIN_CHARS) return false;
  return textLength - lastCheckedLength >= TEXT_REPETITION_CHECK_STRIDE;
}
