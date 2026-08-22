/**
 * Unicode 安全防护工具（前端统一实现）
 *
 * 防范通过不可见 Unicode 字符（零宽字符、方向控制符、Hangul Filler、Tag Characters、
 * Variation Selectors、Interlinear Annotation 等）制造的指令混淆攻击。
 *
 * 码位列表与后端 apps/services/common/unicode_security.py 保持同步。
 * 码点清单同步来源：support/app/specs/unicode-dangerous-codepoints.json
 */

// ── 危险不可见字符集 ────────────────────────────────────────────

function _range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let cp = start; cp <= end; cp++) result.push(cp);
  return result;
}

const _ZERO_WIDTH = [
  0x200B, // Zero Width Space
  0x200C, // Zero Width Non-Joiner
  0x200D, // Zero Width Joiner
  0xFEFF, // BOM / Zero Width No-Break Space
] as const;

const _BIDI_CONTROL = [
  0x200E, // Left-to-Right Mark
  0x200F, // Right-to-Left Mark
  0x202A, // Left-to-Right Embedding
  0x202B, // Right-to-Left Embedding
  0x202C, // Pop Directional Formatting
  0x202D, // Left-to-Right Override
  0x202E, // Right-to-Left Override
  0x2066, // Left-to-Right Isolate
  0x2067, // Right-to-Left Isolate
  0x2068, // First Strong Isolate
  0x2069, // Pop Directional Isolate
] as const;

const _HANGUL_FILLER = [
  0x3164, // Hangul Filler
  0xFFA0, // Halfwidth Hangul Filler
] as const;

const _OTHER_INVISIBLE = [
  0x00AD, // Soft Hyphen
  0x034F, // Combining Grapheme Joiner
  0x061C, // Arabic Letter Mark
  0x180E, // Mongolian Vowel Separator
  0x2060, // Word Joiner
  0x2061, // Function Application（不可见数学运算符）
  0x2062, // Invisible Times
  0x2063, // Invisible Separator
  0x2064, // Invisible Plus
  0x2800, // Braille Pattern Blank（视觉空白）
] as const;

const _INTERLINEAR_ANNOTATION = [
  0xFFF9, // Interlinear Annotation Anchor
  0xFFFA, // Interlinear Annotation Separator
  0xFFFB, // Interlinear Annotation Terminator
] as const;

// Tag Characters (U+E0001–U+E007F) — Pliny prompt injection 攻击向量
const _TAG_CHARACTERS = _range(0xE0001, 0xE007F);

// Variation Selectors (U+FE00–U+FE0F)
const _VARIATION_SELECTORS_BMP = _range(0xFE00, 0xFE0F);

// Variation Selectors Supplement (U+E0100–U+E01EF)
const _VARIATION_SELECTORS_SUPPLEMENT = _range(0xE0100, 0xE01EF);

/**
 * 所有危险不可见 Unicode 码位集合。
 * 与后端 DANGEROUS_INVISIBLE_CODEPOINTS 保持完全一致。
 */
export const DANGEROUS_INVISIBLE_CODEPOINTS: ReadonlySet<number> = new Set([
  ..._ZERO_WIDTH,
  ..._BIDI_CONTROL,
  ..._HANGUL_FILLER,
  ..._OTHER_INVISIBLE,
  ..._INTERLINEAR_ANNOTATION,
  ..._TAG_CHARACTERS,
  ..._VARIATION_SELECTORS_BMP,
  ..._VARIATION_SELECTORS_SUPPLEMENT,
]);

// 按类别分组，用于检测报告
const _CATEGORY_MAP: ReadonlyArray<{ name: string; codepoints: ReadonlySet<number> }> = [
  { name: 'zero_width', codepoints: new Set(_ZERO_WIDTH) },
  { name: 'bidi_control', codepoints: new Set(_BIDI_CONTROL) },
  { name: 'hangul_filler', codepoints: new Set(_HANGUL_FILLER) },
  { name: 'other_invisible', codepoints: new Set(_OTHER_INVISIBLE) },
  { name: 'interlinear_annotation', codepoints: new Set(_INTERLINEAR_ANNOTATION) },
  { name: 'tag_characters', codepoints: new Set(_TAG_CHARACTERS) },
  { name: 'variation_selectors', codepoints: new Set([..._VARIATION_SELECTORS_BMP, ..._VARIATION_SELECTORS_SUPPLEMENT]) },
];

function _getCategoryName(cp: number): string {
  for (const { name, codepoints } of _CATEGORY_MAP) {
    if (codepoints.has(cp)) return name;
  }
  return 'unknown';
}

// ── 高效正则构建 ────────────────────────────────────────────────

function _buildCharClassPattern(codepoints: ReadonlySet<number>): RegExp {
  const sorted = Array.from(codepoints).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  const esc = (cp: number): string =>
    cp > 0xFFFF ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[i + 1]!;
      i++;
    }
    if (end - start >= 2) {
      parts.push(`${esc(start)}-${esc(end)}`);
    } else if (end > start) {
      parts.push(esc(start) + esc(end));
    } else {
      parts.push(esc(start));
    }
    i++;
  }
  return new RegExp('[' + parts.join('') + ']', 'gu');
}

const DANGEROUS_INVISIBLE_RE = _buildCharClassPattern(DANGEROUS_INVISIBLE_CODEPOINTS);

// ── 核心 API ────────────────────────────────────────────────────

/**
 * 移除字符串中的 Unicode 不可见/危险字符。
 * 码位列表与后端 unicode_security.py 保持同步。
 */
export function stripDangerousUnicode(input: string): string {
  if (!input) return input;
  return input.replace(DANGEROUS_INVISIBLE_RE, '');
}

export interface UnicodeDetectionResult {
  hasDangerous: boolean;
  /** 检测到的字符信息：[U+码位, 位置, 类别名] */
  found: Array<{ codepoint: string; position: number; category: string }>;
  /** 命中的类别集合 */
  categories: string[];
}

/**
 * 检测字符串是否包含 Unicode 不可见/危险字符。
 * 返回检测到的字符信息（用于日志/告警）。
 */
export function detectDangerousUnicode(input: string): UnicodeDetectionResult {
  const result: UnicodeDetectionResult = { hasDangerous: false, found: [], categories: [] };
  if (!input) return result;

  const categoriesHit = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const cp = input.codePointAt(i)!;
    if (DANGEROUS_INVISIBLE_CODEPOINTS.has(cp)) {
      const category = _getCategoryName(cp);
      categoriesHit.add(category);
      result.found.push({
        codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        position: i,
        category,
      });
    }
    // 跳过代理对的第二个码元
    if (cp > 0xFFFF) i++;
  }

  result.hasDangerous = result.found.length > 0;
  result.categories = Array.from(categoriesHit).sort();
  return result;
}

/**
 * 检测文本中是否包含危险的不可见 Unicode 字符（快速版本）。
 * 不会误报合法的 CJK 文字、Emoji 或普通空白符。
 */
export function containsDangerousUnicode(text: string): boolean {
  if (!text) return false;
  DANGEROUS_INVISIBLE_RE.lastIndex = 0;
  return DANGEROUS_INVISIBLE_RE.test(text);
}

/**
 * NFC 规范化 + 不可见字符清除，用于规则匹配前的预处理。
 */
export function normalizeForMatching(text: string): string {
  if (!text) return text;
  return stripDangerousUnicode(text.normalize('NFC'));
}

// ── 兼容别名（供 commandValidator.ts 无缝迁移） ─────────────────

export const stripInvisibleUnicode = stripDangerousUnicode;
export const containsInvisibleUnicode = containsDangerousUnicode;
