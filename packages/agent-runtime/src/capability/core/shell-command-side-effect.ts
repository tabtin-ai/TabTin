/**
 * shell 命令写副作用判定 —— Tool.isWriteOp / isConcurrencySafe 用。
 *
 * AH-005：agent-runtime 不得 import @tabtin/*；与
 * packages/security-policy/src/shell-command-side-effect.ts 保持同语义拷贝。
 * 改一侧时务必同步另一侧。
 *
 * 原则：
 *   - 未知 → 当写（fail-closed），避免漏拦
 *   - 管道 / `&&` / `;` 任一节不是只读头 → 当写
 *   - stdout 重定向 `>` / `>>`（不含 `2>` / `&>`）→ 当写
 */

/** 与 denylist redirect-write 同语义（stdout 写盘）。 */
const REDIRECT_WRITE_RE = /(?<![2&>])>+\s*[^\s>|&]/;

/**
 * 已知无用户资产写副作用的命令头（小写 basename）。
 * `cd` 只改一次性子进程 cwd，不落用户文件，算只读。
 */
const READONLY_COMMAND_HEADS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'echo',
  'printf',
  'pwd',
  'which',
  'type',
  'file',
  'stat',
  'wc',
  'tree',
  'du',
  'df',
  'env',
  'printenv',
  'hostname',
  'uname',
  'whoami',
  'date',
  'id',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'jq',
  'cut',
  'sort',
  'uniq',
  'tr',
  'column',
  'nl',
  'od',
  'hexdump',
  'strings',
  'md5',
  'md5sum',
  'sha256sum',
  'shasum',
  'cd',
  'true',
  'false',
  'test',
  '[',
  // PowerShell read-only cmdlets / aliases（Windows Agent shell 直接执行）。
  'get-content',
  'get-childitem',
  'get-item',
  'get-location',
  'get-command',
  'get-process',
  'get-service',
  'select-string',
  'test-path',
  'resolve-path',
  'compare-object',
  'measure-object',
  'format-list',
  'format-table',
  'gc',
  'gci',
  'gi',
  'gl',
  'sls',
  'dir',
]);

const CHAIN_SPLIT_RE = /(?:&&|\|\||;|\n|\|)/;

/**
 * 命令是否具有写 / 破坏性副作用。
 * 空命令、解析不出只读头 → true（按写处理）。
 */
export function isShellCommandWriteOp(command: string): boolean {
  if (typeof command !== 'string') return true;
  const trimmed = command.trim();
  if (trimmed.length === 0) return true;

  if (REDIRECT_WRITE_RE.test(trimmed)) return true;

  const segments = trimmed.split(CHAIN_SPLIT_RE);
  for (const segment of segments) {
    const head = extractCommandHead(segment);
    if (head === null) continue; // 空节（如结尾 |）跳过
    if (!READONLY_COMMAND_HEADS.has(head)) return true;
  }
  return false;
}

/**
 * 取节内命令头：跳过 `VAR=val` 赋值前缀与 `sudo`/`command`/`env` 包装。
 */
function extractCommandHead(segment: string): string | null {
  let rest = segment.trim();
  if (!rest) return null;

  // 去掉前导 env 赋值：FOO=bar BAZ=1 grep ...
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    rest = rest.slice(sp + 1).trim();
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let i = 0;
  while (i < tokens.length) {
    const t = stripPathAndExe(tokens[i]!);
    if (t === 'sudo' || t === 'command' || t === 'env' || t === 'nice' || t === 'nohup') {
      i += 1;
      // sudo/env 的 -flag 跳过
      while (i < tokens.length && tokens[i]!.startsWith('-')) i += 1;
      continue;
    }
    return t;
  }
  return null;
}

function stripPathAndExe(token: string): string {
  let t = token;
  // 去路径：/usr/bin/grep → grep
  const slash = t.lastIndexOf('/');
  if (slash >= 0) t = t.slice(slash + 1);
  // Windows：grep.exe
  if (t.toLowerCase().endsWith('.exe')) t = t.slice(0, -4);
  return t.toLowerCase();
}
