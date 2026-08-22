/**
 * **W5 (2026-05-12) edit_file CRLF detect/preserve 模块**
 *
 * Windows CRLF 探测/保留/还原实现（跨平台编辑实测过的兼容方案）。
 *
 * **为什么需要**：Windows 用户编辑的文件大多是 CRLF，跨平台协作时（macOS Agent
 * 改 Windows 文件）会撞两类问题：
 *
 *   1. **匹配失败**：LLM 给的 `oldString` 可能是 LF（Agent 训练数据里 LF 占
 *      绝大多数），而文件磁盘是 CRLF —— exact `indexOf` 必失败，fuzzy 4 级
 *      也兜不住（curly/whitespace normalize 不处理行尾差异）。
 *   2. **写入污染**：edit 成功后写盘时如果用 `newString` 原始 LF 写回 CRLF
 *      文件，后续 git diff 会报"全文件改了"——文件实际只动了几行但行尾被
 *      整体打散。
 *
 * **修法**：
 *
 *   1. 读完文件后用 `detectLineEnding(originalContent)` 探测原 ending
 *   2. 匹配前对 `oldString` / `newString` / `originalContent` 都做
 *      `normalizeLineEndings`（统一 \n） —— fuzzy 4 级在 \n 形态上跑
 *   3. 写入前用 `convertToLineEnding(updatedContent, originalEnding)` 还原
 *
 * **与激进 9 级匹配的差异**：部分实现用含假阳性 BlockAnchor 的多级链路；我们只用已落地的 4 级精准 fuzzy。CRLF 处理本身跟匹配链路解耦，独立模块复用。
 */

/**
 * 检测字符串里第一个出现的 line ending 类型。
 *
 * **优先 CRLF**：检查 `\r\n` 是否存在；若有就返 CRLF，否则 LF。优先 CRLF——一旦有任何 CRLF（即使是 mixed 文件）就保留 CRLF
 * 协议，避免文件被部分降级。
 *
 * **空字符串**：返 LF（默认行业惯例，新文件创建时不会用 CRLF）。
 *
 * 注意：这跟 git 的 `core.autocrlf` 协议哲学一致——文件里只要有任何 CRLF 信号，
 * 整个文件按 CRLF 看待，写回时也用 CRLF。
 */
export function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 统一所有 line ending 为 LF。用于匹配阶段——CRLF 和 LF 内容如果只是行尾不同
 * 应该被视作相同（exact / fuzzy 都在 LF 形态上跑）。
 *
 * **不处理 lone CR**（Mac OS Classic 风格 `\r`）：现代代码库基本不会出现，
 * 强行处理反而引入边界 case。如果确实撞到，会走 line_trimmed 兜底（trim 后
 * 比对，CR 不在 trim 集里所以不会被吃掉，但实际罕见）。
 */
export function normalizeLineEndings(text: string): string {
  // split-join 替代 replaceAll（ES2020 target 兼容）。
  return text.split('\r\n').join('\n');
}

/**
 * 把 LF 形态的文本转回指定的 line ending。用于写入阶段——保持文件原本的协议。
 *
 * **幂等保护**：如果 `text` 内已经含 CRLF（极罕见，但 LLM 偶尔传混合），
 * 先 normalize 一遍再 convert，避免变成 `\r\r\n`。
 */
export function convertToLineEnding(text: string, ending: '\n' | '\r\n'): string {
  if (ending === '\n') return text;
  // 先归一为 LF 再换成 CRLF，防止 mixed 内容造成 \r\r\n。
  // split-join 替代 replaceAll（ES2020 target 兼容）。
  return text.split('\r\n').join('\n').split('\n').join('\r\n');
}

// ─── UTF-8 BOM detect / strip / restore ────────────────────────────────
//
// **W5 收尾轮 reviewer 修复 (2026-05-12)**：read_file 路径用
// `normalizeReadText` 已经剥 BOM 给 LLM 看到的是干净文本；但 edit_file 路径
// 用 `fsPromises.readFile(resolved, 'utf8')` 原样读盘 → 含 BOM 的 UTF-8 文件
// 首字符是 `\uFEFF`，LLM 抄 read 输出写 old_string 时不含 BOM → exact /
// fuzzy 都无法命中，几乎必失败。
//
// 修法跟 CRLF preserve 同款：read 后 detect BOM、strip 后用于匹配，写盘前
// 还原。文件原本没有 BOM 就不补 BOM（保持原样）。

const UTF8_BOM = '\uFEFF';

/**
 * 检测字符串首字符是否是 UTF-8 BOM。返 true 表示原文件有 BOM 标记，应该
 * 在写回时还原。
 */
export function hasBOM(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff;
}

/**
 * 剥离首字符 BOM（如果存在）。无 BOM 时原样返。
 */
export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 写回时如果原文件有 BOM 则补回。无 BOM 不变。
 */
export function restoreBOM(text: string, hadBOM: boolean): string {
  if (!hadBOM) return text;
  // 防御性：如果 text 已经有 BOM（不应该），不重复加。
  return text.charCodeAt(0) === 0xfeff ? text : UTF8_BOM + text;
}
