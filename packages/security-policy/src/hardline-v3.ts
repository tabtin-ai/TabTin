/**
 * hardline-v3.ts — 授权策略 v3 §7 硬红线
 *
 * 三类规则（用户不可配置，代码常量）：
 *   1. 绝对命令红线（ABSOLUTE_COMMAND_DENYLIST）—— 任何情况直接 deny，yolo 也挡
 *   2. 绝对路径红线（ABSOLUTE_PATH_DENYLIST）—— 写系统目录直接 deny
 *   3. 敏感路径四态（SENSITIVE_PATH_LIST）—— 工作区外/内 × 读/写 = 4 态
 *
 * SSoT：同目录下的 `hardline-v3-rules.json`（被 TS + Python 镜像共同消费）。
 * Python 端通过 `scripts/codegen-hardline.py` 生成 `generated_hardline.py`，
 * 同步性由 hash 校验保证。
 *
 * 不依赖 AST / classifier：纯 regex 扫描。
 */

import rulesData from './hardline-v3-rules.json';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface HardlineHit {
  /** 是否命中 */
  hit: boolean;
  /** 命中的规则 name（未命中时 undefined） */
  pattern?: string;
  /** 人话描述（未命中时 undefined） */
  description?: string;
  /**
   * 规则严重级别：
   * - `catastrophic`：灾难级，三档均 deny（rm -rf /、fork bomb 等）
   * - `risk`：风险级，always_ask deny；auto ask；full_access 放行
   */
  tier?: 'catastrophic' | 'risk';
}

/** 灾难级命令红线规则名（SSoT 子集，与 hardline-v3-rules.json name 对齐） */
export const CATASTROPHIC_COMMAND_RULE_NAMES: ReadonlySet<string> = new Set([
  'rm -rf root or home',
  'rm -rf system root',
  'fork bomb',
  'dd to raw device',
  'mkfs format',
  'format disk windows',
  'redirect to raw disk',
]);

function hardlineTierForCommand(name: string): 'catastrophic' | 'risk' {
  return CATASTROPHIC_COMMAND_RULE_NAMES.has(name) ? 'catastrophic' : 'risk';
}

/** 路径红线一律视为 risk 级（无灾难级路径子集）。 */
function hardlineTierForPath(_name: string): 'catastrophic' | 'risk' {
  return 'risk';
}

/**
 * 敏感路径四态判决结果。
 *
 * action 含义：
 *   - 'deny': 直接拒绝（写敏感 + 工作区外）
 *   - 'ask': 必须敲门（写敏感 + 工作区内 / 读敏感 + 工作区外）
 *   - 'allow': 不挡（读敏感 + 工作区内）
 */
export interface SensitivePathDecision {
  hit: boolean;
  /** 命中后的处置；hit=false 时为 'allow' */
  action: 'deny' | 'ask' | 'allow';
  /** 命中的 category（如 'ssh' / 'env' / 'aws'）；未命中时 undefined */
  category?: string;
  /** 人话描述 */
  description?: string;
  /** 命中的规则 name */
  pattern?: string;
}

// ─────────────────────────────────────────────────────────────
// JSON schema 校验 + 编译
// ─────────────────────────────────────────────────────────────

interface RawCommandRule {
  name: string;
  pattern: string;
  flags: string;
  description: string;
}

interface RawPathRule extends RawCommandRule {}

interface RawSensitiveRule {
  name: string;
  pattern: string;
  flags: string;
  category: string;
  description: string;
}

interface RawRulesV3 {
  schema_version: number;
  absolute_command_denylist: RawCommandRule[];
  absolute_path_denylist: RawPathRule[];
  sensitive_path_list: RawSensitiveRule[];
  // W7/B2 codegen 接入：本 TS 模块不消费这两个字段（path_safety + terminal-core
  // 各自走 codegen 派生），但仍要求 SSoT 在 TS 端 fail-fast 时确认它们存在 +
  // 形态正确——一旦有人误删 JSON 结构，hardline-v3 顶部 assertRulesShape
  // 就能在 TS 端最早期捕获。
  path_scan_rules: RawSensitiveRule[];
  path_basename_patterns: RawSensitiveRule[];
}

/** 测试可JSON shape 校验（运行期 fail-fast） */
export function __assertRulesShape(raw: unknown): asserts raw is RawRulesV3 {
  return assertRulesShape(raw);
}

function assertRulesShape(raw: unknown): asserts raw is RawRulesV3 {
  if (!raw || typeof raw !== 'object') {
    throw new Error('[hardline-v3] hardline-v3-rules.json 解析结果不是 object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schema_version !== 'number') {
    throw new Error('[hardline-v3] 缺 schema_version');
  }
  for (const section of [
    'absolute_command_denylist',
    'absolute_path_denylist',
    'sensitive_path_list',
    // W7/B2：本 TS 模块不消费这两个字段，但 schema 验证在 SSoT 防御链路
    // 第一关 fail-fast（早于 codegen --check），所以也要校验形态。
    'path_scan_rules',
    'path_basename_patterns',
  ] as const) {
    const arr = obj[section];
    if (!Array.isArray(arr)) {
      throw new Error(`[hardline-v3] ${section} 不是 array`);
    }
    arr.forEach((r, i) => {
      if (!r || typeof r !== 'object') {
        throw new Error(`[hardline-v3] ${section} #${i} 不是 object`);
      }
      const rr = r as Record<string, unknown>;
      for (const k of ['name', 'pattern', 'flags', 'description']) {
        if (typeof rr[k] !== 'string') {
          throw new Error(`[hardline-v3] ${section} #${i} 字段 ${k} 不是 string`);
        }
      }
      // sensitive_path_list / path_scan_rules / path_basename_patterns 都强制 category
      if (
        (section === 'sensitive_path_list' ||
          section === 'path_scan_rules' ||
          section === 'path_basename_patterns') &&
        typeof rr.category !== 'string'
      ) {
        throw new Error(`[hardline-v3] ${section} #${i} 缺 category`);
      }
    });
  }
}

assertRulesShape(rulesData);
const RULES: RawRulesV3 = rulesData;

export const HARDLINE_V3_SCHEMA_VERSION: number = RULES.schema_version;

/** 测试可单条 flag 校验 */
export function __compileFlag(flags: string, label = '<test>'): string {
  return compileFlag(flags, label);
}

function compileFlag(flags: string, label: string): string {
  // 仅允许 'i'（与 Python `re.IGNORECASE` 等价）；其他 flag 跨端语义不一致
  for (const f of flags) {
    if (f !== 'i') {
      throw new Error(`[hardline-v3] ${label} 不支持的 flag '${f}'，只允许 'i'`);
    }
  }
  return flags.includes('i') ? 'i' : '';
}

/** 测试可编译 command rule（行为同 internal） */
export function __compileCommandRule(r: { name: string; pattern: string; flags: string; description: string }): readonly [RegExp, string, string] {
  return compileCommandRule(r);
}

/** 测试可编译 sensitive rule */
export function __compileSensitiveRule(r: { name: string; pattern: string; flags: string; category: string; description: string }): CompiledSensitive {
  return compileSensitiveRule(r);
}

function compileCommandRule(r: RawCommandRule): readonly [RegExp, string, string] {
  const flag = compileFlag(r.flags, `command rule '${r.name}'`);
  try {
    return [new RegExp(r.pattern, flag), r.name, r.description] as const;
  } catch (err) {
    throw new Error(
      `[hardline-v3] command rule '${r.name}' regex 编译失败: ${(err as Error).message}`,
    );
  }
}

function compilePathRule(r: RawPathRule): readonly [RegExp, string, string] {
  return compileCommandRule(r);
}

interface CompiledSensitive {
  regex: RegExp;
  name: string;
  category: string;
  description: string;
}

function compileSensitiveRule(r: RawSensitiveRule): CompiledSensitive {
  const flag = compileFlag(r.flags, `sensitive rule '${r.name}'`);
  try {
    return {
      regex: new RegExp(r.pattern, flag),
      name: r.name,
      category: r.category,
      description: r.description,
    };
  } catch (err) {
    throw new Error(
      `[hardline-v3] sensitive rule '${r.name}' regex 编译失败: ${(err as Error).message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Runtime 常量
// ─────────────────────────────────────────────────────────────

/** 绝对命令红线：[regex, name, description][] */
export const ABSOLUTE_COMMAND_DENYLIST: ReadonlyArray<
  readonly [RegExp, string, string]
> = RULES.absolute_command_denylist.map(compileCommandRule);

/** 绝对路径红线：[regex, name, description][] */
export const ABSOLUTE_PATH_DENYLIST: ReadonlyArray<
  readonly [RegExp, string, string]
> = RULES.absolute_path_denylist.map(compilePathRule);

/** 敏感路径清单：含 category */
export const SENSITIVE_PATH_LIST: ReadonlyArray<CompiledSensitive> =
  RULES.sensitive_path_list.map(compileSensitiveRule);

// ─────────────────────────────────────────────────────────────
// 检查函数
// ─────────────────────────────────────────────────────────────

/**
 * 检查 shell 命令字符串是否命中绝对命令红线。
 *
 * @param command 完整命令字符串（包含 wrappers，如 'sudo rm -rf /'）
 * @returns HardlineHit；hit=true 时 pattern / description 必有值
 */
export function checkHardlineCommand(command: string): HardlineHit {
  if (typeof command !== 'string' || command.length === 0) {
    return { hit: false };
  }
  for (const [re, name, desc] of ABSOLUTE_COMMAND_DENYLIST) {
    if (re.test(command)) {
      return {
        hit: true,
        pattern: name,
        description: desc,
        tier: hardlineTierForCommand(name),
      };
    }
  }
  return { hit: false };
}

/**
 * 检查路径是否命中绝对路径红线（系统目录写）。
 *
 * @param path 已规范化的路径（POSIX 斜杠 + NFC，由调用方保证）
 * @param kind 工具类别；'shell' 时 path 通常是 cwd，'file' 时是 file_path
 * @returns HardlineHit
 *
 * 行为：
 *   - 'file' 类只对**写**操作做绝对路径红线检查（读 /etc 是合理的）
 *   - 'shell' 类的 cwd 不挡（cwd 是 /etc 也可能是合理 grep）
 *   - 实际"写"语义判断在调用方（judge）；本函数只负责 pattern 匹配
 *
 * 注意：本函数**只查 pattern**，不区分读写。`judge` 负责按 `isWriteOp` 决定是否调用本函数。
 */
export function checkHardlinePath(path: string, _kind: 'file' | 'shell'): HardlineHit {
  if (typeof path !== 'string' || path.length === 0) {
    return { hit: false };
  }
  const comparablePath = normalizeHardlinePathSyntax(path);
  for (const [re, name, desc] of ABSOLUTE_PATH_DENYLIST) {
    if (re.test(comparablePath)) {
      return {
        hit: true,
        pattern: name,
        description: desc,
        tier: hardlineTierForPath(name),
      };
    }
  }
  return { hit: false };
}

/**
 * 敏感路径四态判决。
 *
 * 矩阵（v3 §3.3 表）：
 *   | 操作 | 工作区外 | 工作区内 |
 *   |-----|---------|---------|
 *   | 写  | deny    | ask     |
 *   | 读  | ask     | allow   |
 *
 * @param path 已规范化的路径
 * @param kind 工具类别（仅区分文件类 vs shell 类用作语义；行为由 isWrite 主导）
 * @param inWorkspace 路径是否落在工作区内（由调用方提前算好）
 * @param isWrite 是否写操作
 * @returns SensitivePathDecision
 */
export function checkSensitivePath(
  path: string,
  _kind: 'file' | 'shell',
  inWorkspace: boolean,
  isWrite: boolean,
): SensitivePathDecision {
  if (typeof path !== 'string' || path.length === 0) {
    return { hit: false, action: 'allow' };
  }

  for (const rule of SENSITIVE_PATH_LIST) {
    if (rule.regex.test(path)) {
      let action: 'deny' | 'ask' | 'allow';
      if (isWrite) {
        action = inWorkspace ? 'ask' : 'deny';
      } else {
        action = inWorkspace ? 'allow' : 'ask';
      }
      return {
        hit: true,
        action,
        category: rule.category,
        pattern: rule.name,
        description: rule.description,
      };
    }
  }

  return { hit: false, action: 'allow' };
}

// ─────────────────────────────────────────────────────────────
// shell 命令参数路径提取（F.1）
// ─────────────────────────────────────────────────────────────

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;
const WINDOWS_DEVICE_PATH_RE = /^(?:\\\\\?\\|\/\/\?\/)[A-Za-z]:[\\/]/;
const WINDOWS_ROOT_SYSTEM_PATH_RE =
  /^[\\/](?:Windows|Program Files(?: \(x86\))?)(?:[\\/]|$)/i;
const WINDOWS_SYSTEM_ENV_PATH_RE =
  /^(?:%(?:windir|systemroot|systemdrive|programfiles(?:\(x86\))?|programw6432)%|\$env:(?:windir|systemroot|systemdrive|programfiles|programw6432)|\$\{env:(?:windir|systemroot|systemdrive|programfiles(?:\(x86\))?|programw6432)\})(?:[\\/]|$)/i;
const SHELL_TOKEN_RE = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;|&<>"'`]+)/g;
const WRAPPER_PREFIX_RE = /^[([{,]+/;
const WRAPPER_SUFFIX_RE = /[)\]},]+$/;
const POWERSHELL_PROVIDER_PREFIX_RE =
  /^(?:(?:Microsoft\.PowerShell\.Core|Microsoft\.PowerShell\.Management)[\\/])?FileSystem::/i;
const WINDOWS_FILE_DELETE_COMMAND_RE =
  /(?:^|[\s;&|])(?:(?:Microsoft\.PowerShell\.(?:Core|Management)[\\/])?remove-item|del|erase|rd|rmdir)(?=$|[\s;&|])/i;
const POWERSHELL_RI_ALIAS_RE = /(?:^|[\s;&|])ri(?=$|[\s;&|])/i;
const WINDOWS_PATH_HINT_RE =
  /(?:[A-Za-z]:[\\/]|\\\\|\\(?:Windows|Program Files)(?:\\|$)|%(?:windir|systemroot|systemdrive)%|\$env:|\$\{env:)/i;
const OPAQUE_POWERSHELL_COMMAND_RE = [
  /(?:^|[;&|]\s*)(?:cmd(?:\.exe)?\s+\/[ck]\s+)?(?:[A-Za-z]:[^\s;&|]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?=$|\s)/i,
  /(?:^|[;&|]\s*)(?:invoke-expression|iex)(?=$|\s)/i,
  /(?:^|[;&|]\s*)(?:cmd(?:\.exe)?\s+\/[ck]\s+)?(?:[A-Za-z]:[^\s;&|]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:c|command)\b[^\r\n]*\b(?:invoke-expression|iex)\b/i,
] as const;

function normalizeOpaquePowerShellSpelling(command: string): string {
  return command
    .replace(
      /(["'])(?:[A-Za-z]:)?[^"'\r\n]*[\\/](powershell|pwsh)(?:\.exe)?\1/gi,
      '$2.exe',
    )
    .replace(/[`^"'“”‘’]/g, '');
}

/**
 * 不触盘的路径词法归一，只用于 hardline pattern 匹配。
 *
 * `normalize()` 按当前宿主平台 realpath；在 macOS/Linux 单测进程里处理
 * `C:\Windows` 会把它当相对路径。hardline 必须先保留命令本身携带的
 * Windows 语义，因此这里与 realpath 分层：
 *   - 统一斜杠；
 *   - 去 Win32 device 前缀（\\?\C:\...）；
 *   - 管理员共享（\\host\C$\Windows）映射回盘符路径；
 *   - 常见系统环境变量映射到既有 Windows path rule。
 */
function normalizeHardlinePathSyntax(path: string): string {
  let comparable = path.trim().replace(/\\/g, '/');
  comparable = comparable.replace(POWERSHELL_PROVIDER_PREFIX_RE, '');
  comparable = comparable.replace(/^\/\/\?\/UNC\//i, '//');
  comparable = comparable.replace(/^\/\/\?\//, '');

  const adminShare = comparable.match(/^\/\/[^/]+\/([A-Za-z])\$(\/.*)?$/);
  if (adminShare) {
    comparable = `${adminShare[1]!.toUpperCase()}:${adminShare[2] ?? '/'}`;
  }
  const adminRoot = comparable.match(/^\/\/[^/]+\/ADMIN\$(\/.*)?$/i);
  if (adminRoot) {
    comparable = `C:/Windows${adminRoot[1] ?? '/'}`;
  }

  comparable = comparable
    .replace(
      /^(?:%(?:windir|systemroot)%|\$env:(?:windir|systemroot)|\$\{env:(?:windir|systemroot)\})(?=\/|$)/i,
      'C:/Windows',
    )
    .replace(
      /^(?:%systemdrive%|\$env:systemdrive|\$\{env:systemdrive\})(?=\/|$)/i,
      'C:',
    )
    .replace(
      /^(?:%programfiles%|\$env:programfiles|\$\{env:programfiles\}|%programw6432%|\$env:programw6432|\$\{env:programw6432\})(?=\/|$)/i,
      'C:/Program Files',
    )
    .replace(
      /^(?:%programfiles\(x86\)%|\$\{env:programfiles\(x86\)\})(?=\/|$)/i,
      'C:/Program Files (x86)',
    );

  if (/^\/Windows(?:\/|$)/i.test(comparable)) {
    comparable = `C:${comparable}`;
  } else if (/^\/Program Files(?: \(x86\))?(?:\/|$)/i.test(comparable)) {
    comparable = `C:${comparable}`;
  }

  comparable = comparable.replace(/^([A-Za-z]):\/Win\*(?=\/|$)/i, '$1:/Windows');

  return comparable;
}

/** shell 参数是否是跨平台绝对路径（含 Windows 系统环境变量根）。 */
export function isAbsoluteShellPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  const trimmed = path.trim();
  return (
    trimmed.startsWith('/')
    || trimmed.startsWith('~/')
    || WINDOWS_DRIVE_PATH_RE.test(trimmed)
    || WINDOWS_UNC_PATH_RE.test(trimmed)
    || WINDOWS_DEVICE_PATH_RE.test(trimmed)
    || WINDOWS_ROOT_SYSTEM_PATH_RE.test(trimmed)
    || WINDOWS_SYSTEM_ENV_PATH_RE.test(trimmed)
    || POWERSHELL_PROVIDER_PREFIX_RE.test(trimmed)
  );
}

/** Windows PowerShell / cmd 文件删除命令（只用于提升审批，不直接阻止）。 */
export function isWindowsFileDeleteCommand(command: string): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  const comparable = command.replace(/[`^"'“”‘’]/g, '');
  return (
    WINDOWS_FILE_DELETE_COMMAND_RE.test(comparable)
    || (POWERSHELL_RI_ALIAS_RE.test(comparable) && WINDOWS_PATH_HINT_RE.test(comparable))
  );
}

/**
 * 无法向用户透明展示真实载荷的 PowerShell 调用。
 *
 * Agent 可以把同一操作改写成明文命令，因此编码载荷与动态求值被视为
 * 不可绕过的透明性红线。
 */
export function checkOpaquePowerShellCommand(command: string): HardlineHit {
  if (typeof command !== 'string' || command.length === 0) return { hit: false };
  const comparable = normalizeOpaquePowerShellSpelling(command);
  if (!OPAQUE_POWERSHELL_COMMAND_RE.some((pattern) => pattern.test(comparable))) {
    return { hit: false };
  }
  return {
    hit: true,
    // 复用既有跨端 i18n slug；两者都属于运行时展开任意命令。
    pattern: 'eval expansion',
    description: '不透明 PowerShell 命令（编码载荷或动态求值）',
    tier: 'catastrophic',
  };
}

/**
 * Windows 删除目标是否包含轻量解析器无法可靠归属的动态表达式。
 * 静态相对路径（例如 `.\build.tmp`）不命中。
 */
export function hasOpaqueWindowsDeleteTarget(command: string): boolean {
  if (!isWindowsFileDeleteCommand(command)) return false;
  const comparable = command.replace(/[`^"'“”‘’]/g, '');
  const withoutKnownSystemEnv = comparable.replace(
    /(?:%(?:windir|systemroot|systemdrive|programfiles(?:\(x86\))?|programw6432)%|\$env:(?:windir|systemroot|systemdrive|programfiles|programw6432)|\$\{env:(?:windir|systemroot|systemdrive|programfiles(?:\(x86\))?|programw6432)\})/gi,
    '',
  );
  return (
    /\$\(|\$(?:\{)?[A-Za-z_]/.test(withoutKnownSystemEnv)
    || /%[A-Za-z_][A-Za-z0-9_]*%/.test(withoutKnownSystemEnv)
    || /[*?]/.test(withoutKnownSystemEnv)
    || /-(?:literalpath|path)\s+\(/i.test(withoutKnownSystemEnv)
  );
}

function shellPathCandidateVariants(rawToken: string): string[] {
  const token = rawToken.trim();
  if (!token) return [];

  const variants = [token];
  const equalsIndex = token.indexOf('=');
  if (equalsIndex >= 0 && equalsIndex < token.length - 1) {
    variants.push(token.slice(equalsIndex + 1));
  }

  return variants.flatMap((value) => {
    let candidate = value
      .replace(WRAPPER_PREFIX_RE, '')
      .replace(WRAPPER_SUFFIX_RE, '')
      .trim();
    // 兼容 shell 中 `"'...'"` / `'"..."'` 这类嵌套引号。tokenizer 已去掉
    // 最外层一种引号，这里继续剥成对内层引号，让安全扫描看到真实路径。
    while (
      candidate.length >= 2
      && (
        (candidate.startsWith('"') && candidate.endsWith('"'))
        || (candidate.startsWith("'") && candidate.endsWith("'"))
      )
    ) {
      candidate = candidate.slice(1, -1).trim();
    }
    const withoutProvider = candidate.replace(POWERSHELL_PROVIDER_PREFIX_RE, '');
    return withoutProvider === candidate
      ? [candidate]
      : [candidate, withoutProvider];
  });
}

/**
 * 从 token 中挑出跨平台绝对路径。quoted token 已由 SHELL_TOKEN_RE 去掉引号，
 * 因此含空格路径（`"C:\Program Files\..."`）仍作为一个整体进入这里。
 */
function extractPathFromToken(rawToken: string): string | null {
  for (const candidate of shellPathCandidateVariants(rawToken)) {
    if (isAbsoluteShellPath(candidate)) return candidate;
  }
  return null;
}

/**
 * 从 shell 命令字符串中提取跨平台绝对路径。
 *
 * 支持：
 *   - POSIX `/...`、`~/...`
 *   - Windows 盘符 `C:\...` / `C:/...`
 *   - UNC `\\server\share\...`
 *   - Win32 device path `\\?\C:\...`
 *   - `%WINDIR%` / `$env:SystemRoot` / ProgramFiles 系统变量
 *   - 单/双引号与 `-Path=...` / `-LiteralPath=...`
 *
 * 这里只做轻量 tokenization，不承担完整 Bash / PowerShell AST 解析。
 * 未识别到候选时返回空数组；上层仍按 cwd + 命令 hardline 继续判决。
 *
 * **已知限制**（fail-open，spec PD-1 接受不做 Bash AST）：
 *   - 动态字符串拼接、脚本块与运行时变量重写不在本轮覆盖；
 *   - 复杂转义引号仍可能只提取到前缀。
 *
 * @param command shell 命令字符串
 * @param homeDir 用于展开 `~`；未提供时 `~` 路径保持原样
 */
export function extractPathsFromCommand(command: string, homeDir?: string): string[] {
  if (typeof command !== 'string' || command.length === 0) return [];
  const paths: string[] = [];
  const seen = new Set<string>();

  SHELL_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SHELL_TOKEN_RE.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? '';
    let path = extractPathFromToken(token);
    if (!path) continue;
    if (path.startsWith('~/') && homeDir) {
      path = homeDir.replace(/[/\\]+$/, '') + path.slice(1);
    }
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

// ─────────────────────────────────────────────────────────────
// 元信息（可观测 / 测试覆盖度校验）
// ─────────────────────────────────────────────────────────────

/**
 * 列出所有硬红线规则名（按三类分组）。
 * Python 镜像必须返回相同列表（hash 校验）。
 */
export function listHardlineV3Names(): {
  absolute_command: string[];
  absolute_path: string[];
  sensitive_path: string[];
} {
  return {
    absolute_command: ABSOLUTE_COMMAND_DENYLIST.map(([, name]) => name),
    absolute_path: ABSOLUTE_PATH_DENYLIST.map(([, name]) => name),
    sensitive_path: SENSITIVE_PATH_LIST.map((r) => r.name),
  };
}
