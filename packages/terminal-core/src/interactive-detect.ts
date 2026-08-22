/**
 * 交互式命令检测模块
 *
 * 在 PTY 策略降级（spawn+sandbox）前检测命令是否需要交互式输入（stdin/tty）。
 * 如果需要交互，返回检测结果供上层发起 HITL 确认，而非静默挂起。
 *
 * 注意：这是启发式检测，不是完备的 shell 解析。目标是覆盖常见场景，
 * 减少 spawn 路径下的静默挂起。不保证对所有边界命令行做出正确判断。
 */

const INTERACTIVE_EDITORS = new Set([
  'vim', 'vi', 'nvim', 'nano', 'emacs', 'pico', 'ed',
]);

const INTERACTIVE_PAGERS = new Set([
  'less', 'more', 'most',
]);

const INTERACTIVE_REMOTE = new Set([
  'ssh', 'telnet', 'ftp', 'sftp',
]);

const INTERACTIVE_PRIVILEGE = new Set([
  'sudo', 'su', 'doas',
]);

const INTERACTIVE_MONITORS = new Set([
  'top', 'htop', 'watch',
]);

/**
 * REPL 类命令：无参数（或仅 -i 标志）时视为交互；有脚本参数/表达式时为非交互。
 */
const REPL_COMMANDS = new Set([
  'python', 'python3', 'node', 'irb', 'ghci', 'lua', 'erl', 'iex',
]);

/**
 * 明确标示非交互的 REPL 选项。
 * 出现这些 flag 说明命令在执行代码/模块/表达式，不是开 REPL。
 */
const REPL_NON_INTERACTIVE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['python', new Set(['-c', '-m', '-V', '--version', '--help', '-h'])],
  ['python3', new Set(['-c', '-m', '-V', '--version', '--help', '-h'])],
  ['node', new Set(['-e', '--eval', '-p', '--print', '--check', '-v', '--version', '-h', '--help'])],
  ['irb', new Set(['-e', '-v', '--version', '-h', '--help'])],
  ['lua', new Set(['-e', '-v', '--help'])],
]);

/**
 * DB 客户端的非交互标志：带这些选项时是在执行查询/脚本，非交互。
 */
const DB_NON_INTERACTIVE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['mysql', new Set(['-e', '--execute', '-B', '--batch'])],
  ['psql', new Set(['-c', '--command', '-f', '--file'])],
  ['sqlite3', new Set(['-cmd'])],
  ['mongo', new Set(['--eval'])],
  ['mongosh', new Set(['--eval', '-f', '--file'])],
  ['redis-cli', new Set(['--eval', '--pipe', '--scan'])],
]);

const INTERACTIVE_DB_CLIENTS = new Set([
  'mysql', 'psql', 'mongo', 'mongosh', 'redis-cli', 'sqlite3',
]);

/**
 * 多词前缀匹配的交互式命令。
 * 支持 skipFlags 来排除非交互用法（如 npm init --yes）。
 */
const MULTI_WORD_INTERACTIVE: ReadonlyArray<{
  prefix: string;
  reason: string;
  skipFlags?: ReadonlySet<string>;
}> = [
  { prefix: 'npm init', reason: 'npm init 需要交互式输入来配置项目', skipFlags: new Set(['-y', '--yes']) },
  { prefix: 'yarn init', reason: 'yarn init 需要交互式输入来配置项目', skipFlags: new Set(['-y', '--yes', '-2']) },
  { prefix: 'pnpm init', reason: 'pnpm init 需要交互式输入来配置项目' },
  { prefix: 'docker run -it', reason: 'docker run -it 会启动交互式容器' },
  { prefix: 'docker exec -it', reason: 'docker exec -it 会连接到容器的交互式 shell' },
];

/**
 * sudo 的非交互标志。
 */
const SUDO_NON_INTERACTIVE_FLAGS = new Set(['-n', '--non-interactive']);

const REASONS: Record<string, string> = {
  editor: '是交互式编辑器，需要 TTY',
  pager: '是交互式分页器，需要 TTY',
  remote: '是远程连接工具，需要交互式终端',
  privilege: '需要交互式密码输入',
  monitor: '是交互式系统监控工具',
  db: '是交互式数据库客户端',
  repl: '是交互式 REPL，需要 stdin',
};

export interface InteractiveDetectionResult {
  isInteractive: boolean;
  reason?: string;
  matchedCommand?: string;
}

const NOT_INTERACTIVE: InteractiveDetectionResult = { isInteractive: false };

function extractBaseName(cmd: string): string {
  const slashIdx = cmd.lastIndexOf('/');
  return slashIdx >= 0 ? cmd.slice(slashIdx + 1) : cmd;
}

function hasPipeInput(fullCommand: string): boolean {
  const pipeIdx = fullCommand.lastIndexOf('|');
  if (pipeIdx < 0) return false;
  if (pipeIdx > 0 && fullCommand[pipeIdx - 1] === '|') return false;
  const afterPipe = fullCommand.slice(pipeIdx + 1).trim();
  return afterPipe.length > 0;
}

/**
 * 判断 REPL 命令是否处于交互模式。
 *
 * 交互：`python`、`python -i`、`node`（无参数）
 * 非交互：`python script.py`、`python -c "code"`、`node -e "code"`、`node app.js`、
 *          `python --version`、`node -r hook app.js`
 */
function isReplInteractive(baseName: string, args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.length === 1 && args[0] === '-i') return true;

  const nonInteractiveFlags = REPL_NON_INTERACTIVE_FLAGS.get(baseName);
  if (nonInteractiveFlags) {
    for (const arg of args) {
      if (nonInteractiveFlags.has(arg)) return false;
    }
  }

  for (const arg of args) {
    if (!arg.startsWith('-')) return false;
  }

  if (args.some(a => a === '-i')) return true;

  return args.length === 0;
}

/**
 * DB 客户端中需要跟值的短标志（如 -u user、-h host）。
 * 这些标志的下一个 token 是值而非位置参数。
 */
const DB_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['mysql', new Set(['-u', '-h', '-P', '-S', '-D', '--user', '--host', '--port', '--socket', '--database', '-p', '--password'])],
  ['psql', new Set(['-U', '-h', '-p', '-d', '--username', '--host', '--port', '--dbname'])],
  ['mongo', new Set(['--host', '--port', '-u', '--username', '-p', '--password'])],
  ['mongosh', new Set(['--host', '--port', '-u', '--username', '-p', '--password'])],
  ['redis-cli', new Set(['-h', '-p', '-a', '-n', '--user'])],
  ['sqlite3', new Set(['-separator', '-newline'])],
]);

/**
 * 判断 DB 客户端是否处于非交互模式。
 */
function isDbNonInteractive(baseName: string, args: string[]): boolean {
  const flags = DB_NON_INTERACTIVE_FLAGS.get(baseName);
  if (!flags) return false;
  for (const arg of args) {
    if (flags.has(arg)) return true;
  }

  const valueFlags = DB_VALUE_FLAGS.get(baseName);
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (valueFlags?.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return true;
  }
  return false;
}

/**
 * 简单分割命令行为 tokens（尊重引号）。
 * 不做完整的 shell 解析，够用于检测即可。
 */
function splitTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && (ch === ' ' || ch === '\t')) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);

  return tokens;
}

function makeResult(matchedCommand: string, reason: string): InteractiveDetectionResult {
  return { isInteractive: true, reason: `${matchedCommand} ${reason}`, matchedCommand };
}

/**
 * 检测单条命令是否为交互式。
 */
function detectSingle(command: string): InteractiveDetectionResult {
  const trimmed = command.trim();
  if (!trimmed) return NOT_INTERACTIVE;

  const lowerTrimmed = trimmed.toLowerCase();
  for (const mw of MULTI_WORD_INTERACTIVE) {
    if (lowerTrimmed === mw.prefix || lowerTrimmed.startsWith(mw.prefix + ' ')) {
      if (mw.skipFlags) {
        const restTokens = splitTokens(trimmed.slice(mw.prefix.length).trim());
        for (const t of restTokens) {
          if (mw.skipFlags.has(t.toLowerCase())) return NOT_INTERACTIVE;
        }
      }
      return { isInteractive: true, reason: mw.reason, matchedCommand: mw.prefix };
    }
  }

  const tokens = splitTokens(trimmed);
  if (tokens.length === 0) return NOT_INTERACTIVE;

  const rawCmd = tokens[0];
  const baseName = extractBaseName(rawCmd);
  const args = tokens.slice(1);

  if (INTERACTIVE_EDITORS.has(baseName)) return makeResult(baseName, REASONS.editor);
  if (INTERACTIVE_PAGERS.has(baseName)) return makeResult(baseName, REASONS.pager);
  if (INTERACTIVE_REMOTE.has(baseName)) return makeResult(baseName, REASONS.remote);
  if (INTERACTIVE_MONITORS.has(baseName)) return makeResult(baseName, REASONS.monitor);

  if (INTERACTIVE_DB_CLIENTS.has(baseName)) {
    if (isDbNonInteractive(baseName, args)) return NOT_INTERACTIVE;
    return makeResult(baseName, REASONS.db);
  }

  if (INTERACTIVE_PRIVILEGE.has(baseName)) {
    if (args.length === 0) {
      return makeResult(baseName, REASONS.privilege);
    }
    for (const flag of SUDO_NON_INTERACTIVE_FLAGS) {
      if (args.includes(flag)) return NOT_INTERACTIVE;
    }
    const subCmdStart = args.findIndex(a => !a.startsWith('-'));
    if (subCmdStart >= 0) {
      const subCommand = args.slice(subCmdStart).join(' ');
      const subResult = detectSingle(subCommand);
      if (subResult.isInteractive) {
        return {
          isInteractive: true,
          reason: `${baseName} 后的命令 ${subResult.matchedCommand} ${subResult.reason?.replace(`${subResult.matchedCommand} `, '') ?? '需要交互'}`,
          matchedCommand: `${baseName} ${subResult.matchedCommand}`,
        };
      }
    }
    return makeResult(baseName, REASONS.privilege);
  }

  if (REPL_COMMANDS.has(baseName)) {
    if (isReplInteractive(baseName, args)) {
      return makeResult(baseName, REASONS.repl);
    }
    return NOT_INTERACTIVE;
  }

  return NOT_INTERACTIVE;
}

/**
 * 检测命令是否需要交互式输入。
 *
 * 处理管道（`echo hello | python` → 非交互）、sudo 递归、
 * 路径前缀（`/usr/bin/vim` → 交互）、复合命令（&&、;、||）等场景。
 */
export function detectInteractiveCommand(command: string): InteractiveDetectionResult {
  const trimmed = command.trim();
  if (!trimmed) return NOT_INTERACTIVE;

  if (hasPipeInput(trimmed)) {
    const afterPipe = trimmed.slice(trimmed.lastIndexOf('|') + 1).trim();
    const tokens = splitTokens(afterPipe);
    if (tokens.length > 0) {
      const baseName = extractBaseName(tokens[0]);
      if (REPL_COMMANDS.has(baseName)) {
        return NOT_INTERACTIVE;
      }
    }
  }

  const segments = trimmed.split(/\s*&&\s*|\s*;\s*|\s*\|\|\s*/);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;

    const actualCmd = hasPipeInput(s) ? s.slice(s.lastIndexOf('|') + 1).trim() : s;
    const result = detectSingle(actualCmd);
    if (result.isInteractive) return result;
  }

  return NOT_INTERACTIVE;
}
