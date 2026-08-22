/**
 * Linear, bounded parser for `web_search.freshness`.
 *
 * Used by both the schema validator (`format: "web-search-freshness"`) and
 * execute-time hard rejection — no arbitrary RegExp, Gregorian calendar only,
 * no timezone / Date object involvement.
 */

/** Bocha / SearchService presets. */
export const WEB_SEARCH_FRESHNESS_VALUES = [
  'noLimit',
  'oneDay',
  'oneWeek',
  'oneMonth',
  'oneYear',
] as const;

export type WebSearchFreshnessPreset = (typeof WEB_SEARCH_FRESHNESS_VALUES)[number];

export const WEB_SEARCH_FRESHNESS_FORMS =
  `${WEB_SEARCH_FRESHNESS_VALUES.join(' / ')} / YYYY-MM-DD / YYYY-MM-DD..YYYY-MM-DD`;

/** Sole JSON Schema `format` keyword recognized by the tool input validator. */
export const WEB_SEARCH_FRESHNESS_FORMAT = 'web-search-freshness' as const;

export type WebSearchFreshnessParseResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a freshness string: preset, single calendar day, or inclusive
 * `YYYY-MM-DD..YYYY-MM-DD` range with start <= end.
 */
export function parseWebSearchFreshness(freshness: string): WebSearchFreshnessParseResult {
  if ((WEB_SEARCH_FRESHNESS_VALUES as readonly string[]).includes(freshness)) {
    return { ok: true };
  }

  const sep = freshness.indexOf('..');
  if (sep === -1) {
    return parseSingleDateForm(freshness);
  }

  // Exactly one `..` separator; reject empty sides / extra separators.
  if (freshness.indexOf('..', sep + 2) !== -1) {
    return { ok: false, reason: 'does not match a supported preset or date form' };
  }
  const start = freshness.slice(0, sep);
  const end = freshness.slice(sep + 2);
  if (!isDateShaped(start) || !isDateShaped(end)) {
    return { ok: false, reason: 'does not match a supported preset or date form' };
  }
  if (!isValidCalendarDate(start)) {
    return { ok: false, reason: `contains invalid calendar date ${start}` };
  }
  if (!isValidCalendarDate(end)) {
    return { ok: false, reason: `contains invalid calendar date ${end}` };
  }
  if (start > end) {
    return { ok: false, reason: 'date range start must not be after end' };
  }
  return { ok: true };
}

export function isValidWebSearchFreshness(freshness: string): boolean {
  return parseWebSearchFreshness(freshness).ok;
}

function parseSingleDateForm(value: string): WebSearchFreshnessParseResult {
  if (!isDateShaped(value)) {
    return { ok: false, reason: 'does not match a supported preset or date form' };
  }
  if (!isValidCalendarDate(value)) {
    return { ok: false, reason: `contains invalid calendar date ${value}` };
  }
  return { ok: true };
}

/** Fixed-width digit layout `YYYY-MM-DD` — O(1), no RegExp. */
function isDateShaped(value: string): boolean {
  if (value.length !== 10) return false;
  if (value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return false; // '-'
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return false; // '0'..'9'
  }
  return true;
}

/** Gregorian calendar validity for a date-shaped string. */
export function isValidCalendarDate(value: string): boolean {
  if (!isDateShaped(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1]!;
}
