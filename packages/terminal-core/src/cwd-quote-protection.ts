/**
 * cwd-quote-protection —— 检测命令字符串里是否含**未加引号**的 workspace
 * 路径前缀（含空格的路径），用于给 LLM 提示"请用引号包裹路径"。
 *
 * **要解决的真实问题**（dogfood 实测痛点）：
 *   macOS workspace 默认在
 *     `~/Library/Application Support/TabTin/organizations/<wt>/spaces/<sp>`
 *   含空格。LLM 不熟 shell 引号规则时常常写
 *     `pdftoppm /tmp/x.pdf /Users/foo/Application Support/TabTin/...`
 *   bash 把含空格的路径拆成两个 argv，导致 `pdftoppm` 报 usage / 输出
 *   到错误位置。LLM 看到的 stderr 是"`Application` not a valid argument"
 *   这种工具自身的 usage 文案，完全不知道**真实原因是路径未加引号**。
 *
 * **设计取向**：
 *   - **不重写命令字符串**——LLM 直接控制权不能被 runtime 偷偷改写
 *     （会让 LLM 推理变成"我写的命令不一定真这么执行"，引入隐藏 bug
 *     比补救路径未引号更糟）
 *   - **只识别 + 提示**：返回结构化警告对象，由调用方选择放在
 *     `path_quoting_warnings` 字段里给 LLM 看，让 LLM 学会下次主动加引号
 *   - **粒度可控**：调用方传入要监控的路径列表（workspace / TABTIN_*
 *     env 等），detection 不内置硬编码 path 前缀
 *
 * **算法**：
 *   1. 路径不含空格 → 直接跳过（不会被 shell 拆词）
 *   2. 在命令字符串里搜索路径出现的所有位置
 *   3. 对每个出现位置，判断该位置是否在引号内（双引号 / 单引号都算保护）
 *   4. 不在任何引号内 → 命中，返回 hit
 *
 * **与 `buildTabtinVarPreamble` 的关系**：
 *   - `buildTabtinVarPreamble`（commandExecutor 内）解决的是 `$TABTIN_*`
 *     **变量展开**时被 word-splitting 的问题（让用户写 `"$TABTIN_WORKSPACE/foo"`
 *     时变量值含空格也安全）
 *   - 本模块解决的是 LLM 把**字面量路径**直接拼到命令里，没引用变量也
 *     没加引号的问题
 *   - 两者互补：preamble 保护变量展开路径；本模块保护字面量路径
 *
 * **已知盲区**：
 *   - tilde 路径（`~/Application Support/...`）：LLM 写 `cat ~/Foo Bar/x.md`
 *     时不命中——`indexOf` 只做字面量匹配，不做 tilde 展开。漏报场景，未
 *     来若 dogfood 高频出现可在此补识别。
 *   - 反斜杠转义空格（`/Users/foo/Foo\ Bar`）：合规 shell quoting 形式，
 *     被静默放过——这是**正确的漏报**（命令实际可执行，无需 nag）。
 */

import type { AgentShellKind } from './agent-process-runner';

export interface UnquotedWorkspacePathHit {
  /** 命中的路径前缀（含空格的字面量路径） */
  path: string;
  /** 在 command 字符串中的索引（首次出现位置） */
  index: number;
  /** 给 LLM 看的英文 hint（动作化、含具体例子） */
  hint: string;
}

/**
 * 按 shell 类别生成「路径未加引号」提示。
 *
 * 旧实现把 bash word-splitting 语义写死，对 Windows PowerShell / cmd 误导
 * （cmd 单引号非引号字符；PS 引号规则也不同）。这里按实际 shell 出文案。
 */
function buildQuotingHint(rawPath: string, shellKind: AgentShellKind | undefined): string {
  if (shellKind === 'powershell') {
    return (
      `Path \`${rawPath}\` contains spaces and was not wrapped in quotes in the command. ` +
      `PowerShell will treat it as multiple arguments. Wrap such paths in single quotes ` +
      `(literal string) — e.g. \`'${rawPath}/file.pdf'\` — or double quotes ` +
      `\`"${rawPath}/file.pdf"\`.`
    );
  }
  if (shellKind === 'cmd') {
    return (
      `Path \`${rawPath}\` contains spaces and was not wrapped in quotes in the command. ` +
      `cmd.exe will split it into multiple arguments. Wrap such paths in double quotes — ` +
      `e.g. \`"${rawPath}\\file.pdf"\`. Note: cmd.exe does not treat single quotes as quoting.`
    );
  }
  // POSIX (bash/zsh/sh/other/缺省)：保持原 word-splitting 语义文案。
  return (
    `Path \`${rawPath}\` contains spaces and was not wrapped in quotes ` +
    `in the command. Bash will split it into multiple argv tokens, which is ` +
    `usually NOT what you intended. Wrap such paths in single quotes — ` +
    `e.g. \`'${rawPath}/file.pdf'\` — or use \`"$TABTIN_WORKSPACE/file.pdf"\` ` +
    `(double-quoted variable expansion is also safe).`
  );
}

/**
 * 判断 `command` 中 `targetIndex` 起到 `targetIndex+targetLength` 范围的子串
 * 是否处于引号内部（单引号或双引号）。
 *
 * 算法：从字符串开头扫到 targetIndex，跟踪 inSingleQuote / inDoubleQuote
 * 状态切换（带反斜杠转义识别）。如果到达 targetIndex 时仍在某种引号内，
 * 视为受保护——不报警。
 *
 * **注意**：本函数不处理嵌套引号 / heredoc 等复杂情况——LLM 写的命令
 * 通常不会用 heredoc。我们宁可漏报（合规命令被静默放过）也不要误报
 * （让 LLM 困惑"我明明加了引号怎么还提示"）。
 */
function isInsideQuotes(command: string, targetIndex: number): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;
  while (i < targetIndex && i < command.length) {
    const ch = command[i];
    // 反斜杠转义在双引号内 / 无引号下生效；单引号内 \ 是字面量
    if (ch === '\\' && !inSingleQuote && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }
    i++;
  }
  return inSingleQuote || inDoubleQuote;
}

/**
 * 检测命令中未引号包裹的 workspace 路径前缀。
 *
 * @param command       完整命令字符串（与 LLM 写的原文一致，未做 shell 解析）
 * @param protectedPaths 需要保护的路径列表（典型：cwd / TABTIN_WORKSPACE 等）。
 *                       不含空格的路径会被自动跳过（无 word-split 风险）。
 * @returns 命中数组（按命令中出现顺序）。无命中时返回空数组。
 */
export function detectUnquotedWorkspacePath(
  command: string,
  protectedPaths: readonly (string | undefined)[] | undefined,
  shellKind?: AgentShellKind,
): UnquotedWorkspacePathHit[] {
  if (!command || !protectedPaths || protectedPaths.length === 0) return [];

  const hits: UnquotedWorkspacePathHit[] = [];
  const seenPaths = new Set<string>();

  for (const rawPath of protectedPaths) {
    if (!rawPath || typeof rawPath !== 'string') continue;
    if (!rawPath.includes(' ')) continue; // 不含空格 → 不会被 shell 拆词
    if (seenPaths.has(rawPath)) continue;
    seenPaths.add(rawPath);

    // 找 path 在 command 中所有出现位置
    let searchFrom = 0;
    while (searchFrom <= command.length - rawPath.length) {
      const idx = command.indexOf(rawPath, searchFrom);
      if (idx < 0) break;

      if (!isInsideQuotes(command, idx)) {
        // 仅识别 single-quote / double-quote 包裹；backtick / `$'...'` /
        // `$"..."` 当作普通字符处理（LLM 几乎不用 backtick 写文件路径，
        // 即使误命中也是真路径未引号问题）。
        hits.push({
          path: rawPath,
          index: idx,
          hint: buildQuotingHint(rawPath, shellKind),
        });
        // 同一路径出现多次只报一次（LLM 看到一次提示就够）
        break;
      }
      searchFrom = idx + 1;
    }
  }

  return hits;
}
