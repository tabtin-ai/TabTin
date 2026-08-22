/**
 * **W5 (2026-05-12) edit_file unified diff snippet 模块**
 *
 * edit 成功后给 Agent 一段带 ±4 行 context 的 diff snippet，让 Agent 一眼看到改完啥样。
 *
 * 这是 PRD 第一节"返 unified diff snippet"的明确取舍：unified diff 形态
 * 跟 git diff / IDE diff view 一致，Agent / 用户 LLM 训练数据见过亿万次该
 * 形态，认知零成本。
 *
 * **为什么需要**：旧实现 edit 成功只返 `{success, replacements, match_strategy,
 * old_lines, new_lines}` —— Agent 不知道改完文件整体长什么样。事故 c39cd8b2
 * 12 次 edit 反复改同一区域，每次 edit 后 Agent 都"猜"前一次改完是什么形态，
 * 经常跟前一次的 new_string 冲突 → 后续 edit 失败。返 unified diff snippet
 * 后 Agent 看一眼就知道"我现在改完是这样"，连续 edit 不再盖前次。
 *
 * **形态**：cat -n 行号前缀 + 改动行用 `+`/`-` 标注 + 上下文 `space`，跟
 * standard unified diff 一致 + 行号让 Agent 能直接对应到 read_file 输出。
 *
 * 例：
 *   12     def foo():
 *   13   -     return 1
 *   14   +     return 42
 *   15         pass
 *
 * **size 控制**：默认 ±4 行 context，单 hunk 行数硬上限 30 行（W5 收尾轮加），
 * 多 hunk 加"+N more hunks"marker（W5 收尾轮加）—— 三重保护让 snippet 总是
 * 在 maxResultSizeChars 4KB budget 内。
 */

import { structuredPatch, type StructuredPatchHunk } from 'diff';

// 单 hunk 格式化后允许的最大行数。超过则截断 + 显式 marker。
// 平均一行 ~60 chars，30 行 ≈ 1.8K 字节，跟 maxResultSizeChars=4000 留出
// 充足缓冲（其他 envelope 字段 ~500 chars + 30 行 snippet ~2K 仍远未触顶）。
const SNIPPET_MAX_LINES = 30;

/**
 * 给定原文件 + 改动后文件，生成 ±N 行 context 的 unified diff snippet。
 *
 * 实现细节：
 *   1. 用 `diff` 包的 `structuredPatch` 生成 hunk 信息（context=4 lines 默认）
 *   2. 取第一个 hunk 周边内容
 *   3. 走 `formatHunk` 渲染成行号前缀 + `+/-/ ` 标注的形态
 *   4. **W5 收尾轮 reviewer 修订**：若有多个 hunk，附"+N more hunks"提示让
 *      Agent 知道 snippet 不完整（防止 reviewer M2 的"误以为只改了一处"）；
 *      首 hunk 自身超 SNIPPET_MAX_LINES 行也截断 + marker，保护 envelope size。
 *
 * **退化**：原文件 === 新文件（理论不可能进入本函数，调用方应已经校验
 * `newContent === content` 是 noop edit 拒绝），返空字符串保护。
 */
export function getSnippetForPatch(
  originalContent: string,
  newContent: string,
  contextLines = 4,
): string {
  if (originalContent === newContent) return '';

  const hunks: StructuredPatchHunk[] = structuredPatch(
    'a',
    'b',
    originalContent,
    newContent,
    undefined,
    undefined,
    { context: contextLines },
  ).hunks;

  if (hunks.length === 0) return '';

  // 首 hunk 渲染（可能截断）
  let body = formatHunk(hunks[0]!);
  const lineCount = body.split('\n').length;
  if (lineCount > SNIPPET_MAX_LINES) {
    const lines = body.split('\n').slice(0, SNIPPET_MAX_LINES);
    body =
      lines.join('\n') +
      `\n... (snippet truncated to first ${SNIPPET_MAX_LINES} lines of ${lineCount}; check file directly for full context)`;
  }

  // 多 hunk 时附"还有 N 处"提示——让 Agent 别误以为 snippet 是完整改动视图。
  if (hunks.length > 1) {
    body += `\n... (+${hunks.length - 1} more hunks not shown; see \`replacements\` field for total change count)`;
  }

  return body;
}

/**
 * 渲染单个 hunk 为字符串。每行格式：
 *   `<行号>` + `\t` + `<标记>` + ` ` + `<内容>`
 *
 * 行号取自 hunk.oldStart / newStart（按 `+` / `-` / context 决定算哪边的行号）。
 * 标记三种：
 *   - ` `（空格）：context 行
 *   - `-`：删除行
 *   - `+`：添加行
 *
 * 这样 Agent 看到的 snippet 跟 git diff / IDE diff view 形态一致，认知零成本。
 */
function formatHunk(hunk: StructuredPatchHunk): string {
  let oldLineNum = hunk.oldStart;
  let newLineNum = hunk.newStart;
  const out: string[] = [];

  for (const rawLine of hunk.lines) {
    if (rawLine.startsWith('-')) {
      out.push(`${oldLineNum}\t- ${rawLine.slice(1)}`);
      oldLineNum++;
    } else if (rawLine.startsWith('+')) {
      out.push(`${newLineNum}\t+ ${rawLine.slice(1)}`);
      newLineNum++;
    } else if (rawLine.startsWith('\\')) {
      // diff 的 "\ No newline at end of file" meta 行，跳过不展示。
      continue;
    } else {
      // context 行（开头空格）
      out.push(`${newLineNum}\t  ${rawLine.slice(1)}`);
      oldLineNum++;
      newLineNum++;
    }
  }

  return out.join('\n');
}
