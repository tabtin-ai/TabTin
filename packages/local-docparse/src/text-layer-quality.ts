/**
 * text-layer-quality — 文本层质量评估（对齐 Django `_is_text_layer_reliable`）
 *
 * 拆到独立模块的原因：
 *   1. 纯函数，便于宿主与脚本不带 logger 直接复用
 *   2. 单测无任何外部依赖
 *
 * Django 生产端对应实现：`apps/tabtin_django/apps/services/docparse/parsers/pdf_parser.py` L986-1029
 */

// 乱码控制字符正则（与 Django `_GARBLED_CHAR_RE` 完全一致）。
// 变量名前缀 `GARBLED_TEXT_LAYER_` 与 W1 全局 ErrorCode `garbled_text_layer`
// 命名对齐（避开过期短名 `garbled` —— 不留 alias）。
const GARBLED_TEXT_LAYER_CHAR_RE = /[\x00-\x08\x0e-\x1f\ufffd\ufffe\uffff]/g

/**
 * "有意义字符"检测 —— 对齐 Django `str.isalnum()` 的 Unicode 语义：
 *   - `\p{L}` 匹配所有 Unicode Letter（拉丁/西里尔/希腊/阿拉伯/希伯来/CJK/假名/
 *     谚文/泰文/梵文/亚美尼亚/格鲁吉亚/藏文...所有脚本）
 *   - `\p{N}` 匹配所有 Unicode Number
 *   - 再加常见半角标点（与 Django 原版一致的白名单）
 *
 * H1-D-MAIN Review 发现：v1.0 只收录 ASCII+CJK+假名+谚文，导致纯俄/阿/泰/希腊
 * PDF 被误判为乱码切云端。用 `\p{L}\p{N}` 修复对齐。
 */
const MEANINGFUL_CHAR_RE = /[\p{L}\p{N}.,;:!?'"()\-/\\@#$%&*+=[\]{}|<>~`^_]/u
const LONG_UNBROKEN_TEXT_RE = /[\p{L}\p{N}]{80,}/gu

function normalizeLineForDuplicateDetection(line: string): string {
  return line
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function computeDuplicateLineRatio(text: string): number {
  const lines = text
    .split(/\r?\n/)
    .map(normalizeLineForDuplicateDetection)
    .filter((line) => line.length >= 20)
  if (lines.length < 2) return 0

  const seen = new Set<string>()
  let duplicateChars = 0
  let totalChars = 0
  for (const line of lines) {
    totalChars += line.length
    if (seen.has(line)) duplicateChars += line.length
    else seen.add(line)
  }
  return totalChars > 0 ? duplicateChars / totalChars : 0
}

/**
 * 计算文本层质量得分（0-1）。
 *
 * 三个维度（对齐 Django `_is_text_layer_reliable`）：
 *   1. 有意义字符占比 ≥ 30%（严格二值：达到 → 1，未达到 → 0）
 *   2. 乱码控制字符 < 10%（严格二值）
 *   3. 单字符重复 < 40%（严格二值，排除 OCR 残影）
 *
 * 三项全部通过返回 1.0；任一项不通过返回 0。
 * 得分 < `qualityMinScore`（默认 0.3）视为乱码文本层，应切云端 VLM。
 *
 * 注：v1.0 用 `meaningfulRatio / 0.3` 线性映射（让阈值 0.3 实际等价于
 * meaningfulRatio > 0.09），H1-D-MAIN Review 指出比 Django 宽松 3.3 倍，
 * v1.1 改为严格二值，与 Django 生产端语义精确对齐。
 */
export function computeTextLayerQuality(text: string): number {
  if (!text || text.trim().length < 20) return 0

  const cleaned = text.replace(/[\s\t\n\r]/g, '')
  const total = cleaned.length
  if (total === 0) return 0

  // 维度 1：有意义字符占比
  let meaningful = 0
  const freq = new Map<string, number>()
  for (const c of cleaned) {
    if (MEANINGFUL_CHAR_RE.test(c)) meaningful += 1
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }
  const meaningfulRatio = meaningful / total
  if (meaningfulRatio < 0.3) return 0

  // 维度 2：乱码控制字符占比
  const noiseCharMatches = cleaned.match(GARBLED_TEXT_LAYER_CHAR_RE)
  const noiseRatio = (noiseCharMatches?.length ?? 0) / total
  if (noiseRatio > 0.1) return 0

  // 维度 3：单字符过度重复
  if (total > 30) {
    let topCount = 0
    for (const [c, n] of freq) {
      if (n > topCount && !/\s/.test(c)) {
        topCount = n
      }
    }
    const topCharRatio = topCount / total
    if (topCharRatio > 0.4) return 0
  }

  // 重复 OCR 文本层：少量重复页眉可接受；整页双层文本会超过三分之一。
  if (computeDuplicateLineRatio(text) > 0.35) return 0

  // 异常长的无分隔字母数字串。按全文占比判断，避免单个 URL/hash 误伤正常文档。
  const longRuns = text.match(LONG_UNBROKEN_TEXT_RE) ?? []
  const longRunChars = longRuns.reduce((sum, run) => sum + run.length, 0)
  if (longRunChars / total > 0.25) return 0

  return 1.0
}
