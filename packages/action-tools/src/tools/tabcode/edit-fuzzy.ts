/**
 * **W5 (2026-05-12) edit_file 4 级精准 fuzzy 匹配模块**
 *
 * 基于生产环境高频对话沉淀的精准 fuzzy 匹配实现。事故 c39cd8b2 复盘发现 TabTin 旧实现仅 2 级（exact
 * + line_trimmed），缺 curly quote / tab-space 规范化——LLM API round-trip 时
 * curly quote 被替换、read_file 输出 tab 渲染成空格让 Agent 抄空格写回，
 * 这两类失误每天都在发生，每次都触发"重读重写"循环浪费 5-10 秒。
 *
 * 4 级链路（顺序敏感，前面命中后立即返回）：
 *   1. 精确匹配（exact `indexOf`）——最快路径
 *   2. 引号规范化（curly quotes → straight quotes）后比对
 *   3. 制表符/空格规范化（tab ↔ 4 spaces）后比对，命中需反向映射回原文
 *   4. 引号 + 制表符/空格组合规范化后比对 + 反向映射
 *
 * **不做 9 级激进 fuzzy**：BlockAnchor / WhitespaceNormalized /
 * IndentationFlexible / ContextAware 属于「首末锚定中间不校验 / 全
 * 部空白合并」风格，TabTin Wave 1 dogfood 验证过会假阳性命中（calculator
 * regression 即此案）——LLM 凭幻觉写中间内容，首末两行恰好是真代码 → 静默
 * 改写到错误位置 → 文件被破坏。
 *
 * **本模块仅做精准 fuzzy**：每一级都是"语义无损 normalize 后整体 indexOf"，
 * 不允许"相似度阈值"判定。命中后返**原文件中真实的子串**，让上层 substitute
 * 时不破坏文件原本的字符规范。
 */

// ─── Curly quote 常量 ───────────────────────────────────────────────────
//
// LLM API（特别是 Anthropic / OpenAI）在 sanitize 时会把 ASCII 直引号
// `'` `"` 转成 Unicode curly quote 让 Markdown 渲染好看；Agent 写回时
// 又是 ASCII 直引号——双向不一致让 indexOf 永远 miss。
//
// 反向同样：用户 IDE 自动 smart quote（macOS 默认开）让源文件含 curly，
// Agent 抄到 cat -n 输出后是 curly，但 LLM 模型 prompt 处理时又被 sanitize
// 成直引号——再次 miss。
//
// 因此匹配阶段两边都做 curly → straight 规范化。

const LEFT_SINGLE_CURLY_QUOTE = '\u2018';
const RIGHT_SINGLE_CURLY_QUOTE = '\u2019';
const LEFT_DOUBLE_CURLY_QUOTE = '\u201C';
const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D';

/**
 * 把字符串里的 Unicode curly quotes 替换成 ASCII straight quotes。
 *
 * 中英文文档 / Markdown / 代码注释里的引号 round-trip 工具——单纯字符串
 * replaceAll 4 次，零分配开销，sub-microsecond 复杂度。
 */
export function normalizeQuotes(str: string): string {
  // 用 split-join 替代 replaceAll —— 兼容 ES2020 target（action-tools 当前
  // tsconfig）。语义跟 replaceAll 完全等价（split 拆分点不包含 separator 本身，
  // join 用新分隔符拼接），但不需要 ES2021。
  return str
    .split(LEFT_SINGLE_CURLY_QUOTE)
    .join("'")
    .split(RIGHT_SINGLE_CURLY_QUOTE)
    .join("'")
    .split(LEFT_DOUBLE_CURLY_QUOTE)
    .join('"')
    .split(RIGHT_DOUBLE_CURLY_QUOTE)
    .join('"');
}

/**
 * 把 tab 展开成 4 个 ASCII 空格。
 *
 * 用于规范化匹配——TabTin read_file 输出走 cat -n 行号 + tab 前缀 + 文件原
 * 内容；LLM 在 context 看到的是 cat -n 渲染后的纯文本，tab 可能被各种渲染
 * 层（HTML / 富文本编辑器 / Markdown）展开成空格让 LLM 看见的是空格。Agent
 * 抄一段写回 old_string 给空格版本，但磁盘文件里仍是 tab——exact indexOf
 * 必失败。
 *
 * 4 spaces 的取值：与常见代码编辑器 tab stop 一致。tab stop = 4
 * 是大多数代码编辑器默认（Python PEP 8 / Prettier / Go gofmt 都是），偶有
 * 项目 tab stop = 2（部分 JavaScript / Ruby）跟 8（C 经典）会未必精确，但
 * 4 spaces normalization 的目标只是"让两边长度对齐 indexOf 能命中"，不影响
 * 反向映射后返的原文件子串——所以 tab stop 偏差不破坏正确性。
 */
function normalizeWhitespace(str: string): string {
  return str.replace(/\t/g, '    ');
}

/**
 * 把 normalized 形态的命中位置反向映射回原文件 substring。
 *
 * **为什么需要**：normalize（tab → 4 spaces）后 normalized 形态的位置 ≠ 原
 * 文件位置。比如原文件 `\tfoo` 长度 4 但 normalized 是 `    foo` 长度 7。
 * normalized indexOf 命中位置 0 不能直接用 `originalContent.substring(0, 7)`
 * —— 后者会跨过原文件不止 1 个 tab。
 *
 * **算法**：双指针同步走 normPos / origPos，遇到 tab 在 normalized 形态展开
 * 4 char 但原文件只占 1 char，根据 normalized 命中边界精确锁定原文件位置。
 *
 * **边界处理**：
 * - normalizedStart 落在 tab 内（普通空白扩展中间）→ 把 tab 整个算给 origStart
 * - normalizedEnd 落在 tab 内 → 把 tab 整个算给 origEnd（含进去）
 * - 找不到边界（不应该发生，前置 indexOf 已经保证 normalized 命中）→ 用
 *   `fileContent.length / normalizedFile.length` 比例兜底
 *
 * 返回原文件 [origStart, origEnd) 的真实子串。
 */
function mapNormalizedMatchBackToFile(
  fileContent: string,
  normalizedFile: string,
  normalizedStart: number,
  normalizedLength: number,
): string {
  let normPos = 0;
  let origPos = 0;
  let origStart = -1;
  let origEnd = -1;
  const normalizedEnd = normalizedStart + normalizedLength;

  while (origPos < fileContent.length && normPos <= normalizedEnd) {
    if (normPos === normalizedStart) {
      origStart = origPos;
    }
    if (normPos === normalizedEnd) {
      origEnd = origPos;
      break;
    }

    const origChar = fileContent[origPos]!;
    if (origChar === '\t') {
      // tab expands to 4 spaces in normalized version
      const nextNormPos = normPos + 4;
      // 边界落在 tab 中间：把整个 tab 归属于对应端点
      if (
        normPos < normalizedStart &&
        nextNormPos > normalizedStart &&
        origStart === -1
      ) {
        origStart = origPos;
      }
      if (
        normPos < normalizedEnd &&
        nextNormPos > normalizedEnd &&
        origEnd === -1
      ) {
        origEnd = origPos + 1;
      }
      normPos = nextNormPos;
      origPos++;
    } else {
      normPos++;
      origPos++;
    }
  }

  // 兜底：normalized 命中末尾恰好是文件末尾（普通字符）—— 上面循环退出条件
  // 是 origPos < fileContent.length，正常 case 走不到这里，但要保护"恰好末尾"
  // 边界。
  if (origStart === -1) origStart = 0;
  if (origEnd === -1) {
    if (normPos === normalizedEnd) {
      // 恰好走完整个 fileContent
      origEnd = fileContent.length;
    } else {
      // 极端兜底：按比例估算
      const ratio = fileContent.length / normalizedFile.length;
      origEnd = Math.round(origStart + normalizedLength * ratio);
    }
  }

  return fileContent.substring(origStart, origEnd);
}

/**
 * 4 级 fuzzy 匹配主入口。
 *
 * 给定 `fileContent`（原文件内容）和 `searchString`（LLM 给的 old_string），
 * 返回**原文件中真实存在的对应子串**——上层 substitute 时直接用这个返回值
 * 做 indexOf + replace，保留文件原本的 curly quote / tab 等字符规范，避免
 * Agent 写回的 ASCII 版本污染源码风格。
 *
 * 返 null 表示 4 级全部 miss——上层应继续走 line_trimmed 或返
 * OLD_STRING_NOT_FOUND。
 *
 * **顺序敏感**：从最严格（exact）走到最宽松（quotes + whitespace 组合），
 * 命中后立即返回。这保证了"能严格匹配的就严格匹配，回退一级算一级容错"。
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // Level 1: exact match
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Level 2: curly → straight quote normalization
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  // 短路优化：normalize 后两边都没变 → 没有 quote 差异，直接跳到 Level 3
  if (normalizedSearch !== searchString || normalizedFile !== fileContent) {
    const searchIndex = normalizedFile.indexOf(normalizedSearch);
    if (searchIndex !== -1) {
      // normalize 是 1:1 字符替换（不改变长度），直接用 normalized 位置取
      // 原文件子串即可——返原文件含 curly quote 的真实片段。
      return fileContent.substring(searchIndex, searchIndex + searchString.length);
    }
  }

  // Level 3: tab → 4 spaces normalization
  const wsNormalizedFile = normalizeWhitespace(fileContent);
  const wsNormalizedSearch = normalizeWhitespace(searchString);

  if (
    wsNormalizedFile !== fileContent ||
    wsNormalizedSearch !== searchString
  ) {
    const wsSearchIndex = wsNormalizedFile.indexOf(wsNormalizedSearch);
    if (wsSearchIndex !== -1) {
      return mapNormalizedMatchBackToFile(
        fileContent,
        wsNormalizedFile,
        wsSearchIndex,
        wsNormalizedSearch.length,
      );
    }
  }

  // Level 4: combined quotes + whitespace normalization
  const combinedFile = normalizeWhitespace(normalizedFile);
  const combinedSearch = normalizeWhitespace(normalizedSearch);

  if (combinedFile !== fileContent || combinedSearch !== searchString) {
    const combinedIndex = combinedFile.indexOf(combinedSearch);
    if (combinedIndex !== -1) {
      return mapNormalizedMatchBackToFile(
        fileContent,
        combinedFile,
        combinedIndex,
        combinedSearch.length,
      );
    }
  }

  return null;
}

/**
 * 调试 / 测试用——暴露 normalize helpers 让单测验证每一级行为。生产代码
 * 不应直接用。
 */
export const __internal = {
  normalizeQuotes,
  normalizeWhitespace,
  mapNormalizedMatchBackToFile,
  LEFT_SINGLE_CURLY_QUOTE,
  RIGHT_SINGLE_CURLY_QUOTE,
  LEFT_DOUBLE_CURLY_QUOTE,
  RIGHT_DOUBLE_CURLY_QUOTE,
};
