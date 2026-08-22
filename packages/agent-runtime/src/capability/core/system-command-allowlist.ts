/**
 * 受限模式系统命令 input 级白名单（J3a / Wave 8）。
 *
 * **背景**：本模块实现受限模式下的 readonly + flag allowlist：
 * 第一批覆盖 6 个高频系统命令：`git` / `tree` / `find` / `sed` / `xargs` / `ps`。
 * 覆盖 plan / ask / study 受限模式 LLM 真实工作场景中 ~80% 的 readonly 系统命令。
 *
 * **安全不变量（本模块维护）**：
 *   - `FlagArgType` / `ExternalCommandConfig`
 *   - GIT 共享 flag groups（6 组）
 *   - `GIT_READ_ONLY_COMMANDS`（25 个 git 子命令）
 *   - xargs / sed / ps / tree config + SAFE_TARGET_FOR_XARGS
 *   - find 单 regex denylist
 *   - validateFlags 主算法
 *   - containsUnquotedExpansion（`$`/glob 防御）
 *
 * **不变量纪律**：
 *   - safeFlags 表的每一项必须带同一 flag 名 + 同样 arg type，禁止擅自放宽
 *   - 不允许把未评审过的 flag 擅自放进 safeFlags
 *   - 不允许引入 fail-open 方向的 fallback；所有产品差异必须是 fail-close（reject 更多 / approve 更少）
 *
 * **本批未覆盖部分（记入 R3a 后续轮次）**：
 *   - 完整 sed 表达式深度分析
 *     → 本批用"sed expression 开头白名单 + pipe 命令粗筛"代替，fail-close 折中
 *   - 复合命令拆分（多 subcommand 联合校验）
 *     → 本批仅支持单命令（含 cd <path> && X 单层前缀，由 caller 在 restricted-shell-allowlist.ts 处理）
 *   - GH / DOCKER / RIPGREP / PYRIGHT / FD / FDFIND / file / sort / man / base64 / date /
 *     SAFE_TARGET_COMMANDS_FOR_XARGS 中除 6 命令外的 target 自身 safeFlags
 *     → 第二批 / 第三批
 *
 * **执行位置**：
 *   - 在 `restricted-shell-allowlist.ts` 的 `createTabtinReadonlyChecker` 内调用，
 *     当 tabtin parser 失败（命令非 tabtin）时尝试 system command 通道；命中即放行，
 *     否则回到原 `not_tabtin` reject 路径。
 *   - shell.ts execute 主路径**不动**——checker 决策链统一收敛在 RestrictedShellAllowlistChecker。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Flag argument type 枚举。
 *
 * - `none`   → flag 不带参数（`--quiet`, `-n`）
 * - `number` → 整数参数（`--max-count=10`）
 * - `string` → 任意字符串（`--author=alice`）
 * - `char`   → 单字符（如 xargs `-d` 分隔符）
 * - `{}`     → 字面 "{}"（仅 xargs `-I {}` 占位符）
 * - `EOF`    → 字面 "EOF"（仅 xargs `-E EOF` 终止符）
 */
export type FlagArgType =
  | 'none'
  | 'number'
  | 'string'
  | 'char'
  | '{}'
  | 'EOF'

export interface ExternalCommandConfig {
  safeFlags: Record<string, FlagArgType>
  /** 返回 true 表示危险（拒绝），false 表示安全。 */
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  /** 默认 true（POSIX `--` 终止 flag 解析）。 */
  respectsDoubleDash?: boolean
}

// ---------------------------------------------------------------------------
// GIT shared flag groups
// ---------------------------------------------------------------------------

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
}

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
}

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
}

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
}

const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
}

const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
}

const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
}

const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
}

function isGitListModeFlag(token: string): boolean {
  if (token === '--list' || token === '-l') return true

  return (
    token[0] === '-' &&
    token[1] !== '-' &&
    token.length > 2 &&
    !token.includes('=') &&
    token.slice(1).includes('l')
  )
}

function getFlagName(token: string): string {
  return token.split('=')[0] || ''
}

function getNextFlagIndex(
  token: string,
  index: number,
  flagsWithArgs: ReadonlySet<string>,
): number {
  if (token.includes('=')) return index + 1
  if (flagsWithArgs.has(token)) return index + 2
  return index + 1
}

// ---------------------------------------------------------------------------
// GIT_READ_ONLY_COMMANDS
// 全部 25 个子命令搬过来；callbacks 字面 copy；safeFlags 一字不差。
// ---------------------------------------------------------------------------

const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      '--dirstat': 'none',
      '--summary': 'none',
      '--patch-with-stat': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--no-renames': 'none',
      '--no-ext-diff': 'none',
      '--check': 'none',
      '--ws-error-highlight': 'string',
      '--full-index': 'none',
      '--binary': 'none',
      '--abbrev': 'number',
      '--break-rewrites': 'none',
      '--find-renames': 'none',
      '--find-copies': 'none',
      '--find-copies-harder': 'none',
      '--irreversible-delete': 'none',
      '--diff-algorithm': 'string',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none',
      '--ignore-all-space': 'none',
      '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number',
      '--function-context': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
      '--no-index': 'none',
      '--relative': 'string',
      '--diff-filter': 'string',
      '-p': 'none',
      '-u': 'none',
      '-s': 'none',
      '-M': 'none',
      '-C': 'none',
      '-B': 'none',
      '-D': 'none',
      '-l': 'none',
      // SECURITY: -S/-G/-O take REQUIRED string args (pickaxe / orderfile)
      '-S': 'string',
      '-G': 'string',
      '-O': 'string',
      '-R': 'none',
    },
  },
  'git log': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      '--abbrev-commit': 'none',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--simplify-merges': 'none',
      '--ancestry-path': 'none',
      '--source': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--walk-reflogs': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--follow': 'none',
      '--no-walk': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--boundary': 'none',
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--diff-filter': 'string',
      '-S': 'string',
      '-G': 'string',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
    },
  },
  'git show': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '--abbrev-commit': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--first-parent': 'none',
      '--raw': 'none',
      '--diff-filter': 'string',
      '-m': 'none',
      '--quiet': 'none',
    },
  },
  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      '-s': 'none',
      '--summary': 'none',
      '-n': 'none',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '-c': 'none',
      '--committer': 'none',
      '--group': 'string',
      '--format': 'string',
      '--no-merges': 'none',
      '--author': 'string',
    },
  },
  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
    },
    // SECURITY: block expire/delete/exists 子命令（写 .git/logs/**）
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      const DANGEROUS_SUBCOMMANDS = new Set(['expire', 'delete', 'exists'])
      for (const token of args) {
        if (!token || token.startsWith('-')) continue
        if (DANGEROUS_SUBCOMMANDS.has(token)) {
          return true
        }
        return false
      }
      return false
    },
  },
  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_COUNT_FLAGS,
    },
  },
  'git ls-remote': {
    safeFlags: {
      '--branches': 'none',
      '-b': 'none',
      '--tags': 'none',
      '-t': 'none',
      '--heads': 'none',
      '-h': 'none',
      '--refs': 'none',
      '--quiet': 'none',
      '-q': 'none',
      '--exit-code': 'none',
      '--get-url': 'none',
      '--symref': 'none',
      '--sort': 'string',
      // SECURITY: --server-option / -o INTENTIONALLY EXCLUDED
    },
  },
  'git status': {
    safeFlags: {
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      '--untracked-files': 'string',
      '-u': 'string',
      '--ignored': 'none',
      '--ignore-submodules': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      '--renames': 'none',
      '--no-renames': 'none',
      '--find-renames': 'string',
      '-M': 'string',
    },
  },
  'git blame': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      '-L': 'string',
      '--porcelain': 'none',
      '-p': 'none',
      '--line-porcelain': 'none',
      '--incremental': 'none',
      '--root': 'none',
      '--show-stats': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-f': 'none',
      '--date': 'string',
      '-w': 'none',
      '--ignore-rev': 'string',
      '--ignore-revs-file': 'string',
      '-M': 'none',
      '-C': 'none',
      '--score-debug': 'none',
      '--abbrev': 'number',
      '-s': 'none',
      '-l': 'none',
      '-t': 'none',
    },
  },
  'git ls-files': {
    safeFlags: {
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      '--directory': 'none',
      '--no-empty-directory': 'none',
      '--eol': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--debug': 'none',
      '-z': 'none',
      '-t': 'none',
      '-v': 'none',
      '-f': 'none',
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-per-directory': 'string',
      '--exclude-standard': 'none',
      '--error-unmatch': 'none',
      '--recurse-submodules': 'none',
    },
  },
  'git config --get': {
    safeFlags: {
      '--local': 'none',
      '--global': 'none',
      '--system': 'none',
      '--worktree': 'none',
      '--default': 'string',
      '--type': 'string',
      '--bool': 'none',
      '--int': 'none',
      '--bool-or-int': 'none',
      '--path': 'none',
      '--expiry-date': 'none',
      '-z': 'none',
      '--null': 'none',
      '--name-only': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
    },
  },
  // NOTE: 'git remote show' 必须在 'git remote' 前匹配（更长前缀）
  'git remote show': {
    safeFlags: {
      '-n': 'none',
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      const positional = args.filter((a) => a !== '-n')
      if (positional.length !== 1) return true
      return !/^[a-zA-Z0-9_-]+$/.test(positional[0]!)
    },
  },
  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      return args.some((a) => a !== '-v' && a !== '--verbose')
    },
  },
  'git merge-base': {
    safeFlags: {
      '--is-ancestor': 'none',
      '--fork-point': 'none',
      '--octopus': 'none',
      '--independent': 'none',
      '--all': 'none',
    },
  },
  'git rev-parse': {
    safeFlags: {
      '--verify': 'none',
      '--short': 'string',
      '--abbrev-ref': 'none',
      '--symbolic': 'none',
      '--symbolic-full-name': 'none',
      '--show-toplevel': 'none',
      '--show-cdup': 'none',
      '--show-prefix': 'none',
      '--git-dir': 'none',
      '--git-common-dir': 'none',
      '--absolute-git-dir': 'none',
      '--show-superproject-working-tree': 'none',
      '--is-inside-work-tree': 'none',
      '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--is-shallow-update': 'none',
      '--path-prefix': 'none',
    },
  },
  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      '--count': 'none',
      '--reverse': 'none',
      '--first-parent': 'none',
      '--ancestry-path': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--min-parents': 'number',
      '--max-parents': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--walk-reflogs': 'none',
      '--oneline': 'none',
      '--abbrev-commit': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--abbrev': 'number',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--source': 'none',
      '--graph': 'none',
    },
  },
  'git describe': {
    safeFlags: {
      '--tags': 'none',
      '--match': 'string',
      '--exclude': 'string',
      '--long': 'none',
      '--abbrev': 'number',
      '--always': 'none',
      '--contains': 'none',
      '--first-match': 'none',
      '--exact-match': 'none',
      '--candidates': 'number',
      '--dirty': 'none',
      '--broken': 'none',
    },
  },
  'git cat-file': {
    safeFlags: {
      '-t': 'none',
      '-s': 'none',
      '-p': 'none',
      '-e': 'none',
      '--batch-check': 'none',
      '--allow-undetermined-type': 'none',
    },
  },
  'git for-each-ref': {
    safeFlags: {
      '--format': 'string',
      '--sort': 'string',
      '--count': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--points-at': 'string',
    },
  },
  'git grep': {
    safeFlags: {
      '-e': 'string',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-G': 'none',
      '--basic-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-c': 'none',
      '--count': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-h': 'none',
      '-H': 'none',
      '--heading': 'none',
      '--break': 'none',
      '--full-name': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      '--max-depth': 'number',
      '--untracked': 'none',
      '--no-index': 'none',
      '--recurse-submodules': 'none',
      '--cached': 'none',
      '--threads': 'number',
      '-q': 'none',
      '--quiet': 'none',
    },
  },
  'git stash show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--diff-filter': 'string',
      '--abbrev': 'number',
    },
  },
  'git worktree list': {
    safeFlags: {
      '--porcelain': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--expire': 'string',
    },
  },
  'git tag': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--sort': 'string',
      '--format': 'string',
      '--points-at': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // SECURITY: positional arg without --list = tag creation
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '--sort',
        '--format',
        '-n',
      ])
      let i = 0
      let seenListFlag = false
      let seenDashDash = false
      while (i < args.length) {
        const token = args[i]
        if (!token) {
          i++
          continue
        }
        if (token === '--' && !seenDashDash) {
          seenDashDash = true
          i++
          continue
        }
        if (!seenDashDash && token.startsWith('-')) {
          if (isGitListModeFlag(token)) {
            seenListFlag = true
          }
          i = getNextFlagIndex(token, i, flagsWithArgs)
          continue
        }
        if (!seenListFlag) return true
        i++
      }
      return false
    },
  },
  'git branch': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-v': 'none',
      '-vv': 'none',
      '--verbose': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '--column': 'none',
      '--no-column': 'none',
      '--abbrev': 'number',
      '--no-abbrev': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'none',
      '--no-merged': 'none',
      '--points-at': 'string',
      '--sort': 'string',
      '--show-current': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // SECURITY: positional without --list = branch creation
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--points-at',
        '--sort',
        // --abbrev REMOVED: git PARSE_OPT_OPTARG (注释)
      ])
      const flagsWithOptionalArgs = new Set(['--merged', '--no-merged'])
      let i = 0
      let lastFlag = ''
      let seenListFlag = false
      let seenDashDash = false
      while (i < args.length) {
        const token = args[i]
        if (!token) {
          i++
          continue
        }
        if (token === '--' && !seenDashDash) {
          seenDashDash = true
          lastFlag = ''
          i++
          continue
        }
        if (!seenDashDash && token.startsWith('-')) {
          if (isGitListModeFlag(token)) {
            seenListFlag = true
          }
          lastFlag = token.includes('=') ? getFlagName(token) : token
          i = getNextFlagIndex(token, i, flagsWithArgs)
          continue
        }
        const lastFlagHasOptionalArg = flagsWithOptionalArgs.has(lastFlag)
        if (!seenListFlag && !lastFlagHasOptionalArg) return true
        i++
      }
      return false
    },
  },
}

// ---------------------------------------------------------------------------
// xargs / sed / ps / tree configs
// ---------------------------------------------------------------------------

const XARGS_CONFIG: ExternalCommandConfig = {
  safeFlags: {
    '-I': '{}',
    // SECURITY: -i / -e (lowercase) REMOVED — GNU getopt
    // optional-attached-arg semantics 与 validator 解析有 differential
    '-n': 'number',
    '-P': 'number',
    '-L': 'number',
    '-s': 'number',
    '-E': 'EOF',
    '-0': 'none',
    '-t': 'none',
    '-r': 'none',
    '-x': 'none',
    '-d': 'char',
  },
}

const SED_CONFIG: ExternalCommandConfig = {
  safeFlags: {
    '--expression': 'string',
    '-e': 'string',
    '--quiet': 'none',
    '--silent': 'none',
    '-n': 'none',
    '--regexp-extended': 'none',
    '-r': 'none',
    '--posix': 'none',
    '-E': 'none',
    '--line-length': 'number',
    '-l': 'number',
    '--zero-terminated': 'none',
    '-z': 'none',
    '--separate': 'none',
    '-s': 'none',
    '--unbuffered': 'none',
    '-u': 'none',
    '--debug': 'none',
    '--help': 'none',
    '--version': 'none',
  },
  /**
   * **产品差异（fail-close 折中）**：完整 sed 表达式分析会做
   * sed 表达式深度分析（识别 `p` print / `!d` / `s/.../.../[gpiw]` 等命令的语义）。
   * 本批未移植；改用以下浅校验，**reject 更多 / approve 更少**——绝不引入 false-allow：
   *
   *   1. 命令字符串中 `s/.../.../w` substitute-with-write 标志 → reject
   *   2. 命令字符串中 `[wWrRF]\s+[~./]`（写 / 读外部文件命令 + 文件路径）→ reject
   *   3. 命令字符串中 `e\s+\S`（执行子 shell 命令）→ reject
   *   4. 各 -e/--expression 表达式内 `[wWrRFe]` 命令在合法 boundary 后 → reject
   *
   * **关键 boundary 字符**：必须包含 `{` —— GNU sed `addr { cmd1; cmd2; }` 块语法
   * 允许在块内放 `e cmd` / `w path` 等危险指令。漏掉 `{` 字符类等于让
   * `sed '1{e cat /etc/passwd;p;}' file` 直接穿透浅校验（→ RCE）。
   * `sedValidation.ts` 685 行后端实际 case：块开始/分号/地址范围结束都
   * 是合法的 cmd 前驱位置。
   *
   * 完整深度分析记入 R3a 后续轮次遗留（见 system-command-allowlist.ts 顶部说明）。
   */
  additionalCommandIsDangerousCallback: (
    rawCommand: string,
    args: string[],
  ) => {
    if (hasDangerousSedRawCommand(rawCommand)) return true

    // 第二道：检查所有 string 类参数（-e 后的 sed expression）
    for (let i = 0; i < args.length; i++) {
      const expr = getSedExpression(args, i)
      if (expr && hasDangerousSedExpression(expr)) return true
    }

    return false
  },
}

function hasDangerousSedRawCommand(rawCommand: string): boolean {
  // 第一道：原始命令字符串级粗筛（所有 args 拼接后的字面）
  // boundary 字符类：空白 / 单引号 / 分号 / `{`（块开始）—— 含 `{` 修复 P0 块语法绕过
  const cmdBoundary = "(?:^|[\\s';{])"

  if (new RegExp(`${cmdBoundary}s\\/[^/]*\\/[^/]*\\/[a-zA-Z]*w\\b`).test(rawCommand)) {
    return true // s/.../.../w 标志
  }
  if (new RegExp(`${cmdBoundary}[wWrRF]\\s+[~./]`).test(rawCommand)) {
    return true // w/W/r/R/F + 文件路径
  }
  if (new RegExp(`${cmdBoundary}e\\s+\\S`).test(rawCommand)) {
    return true // e + cmd（执行子 shell）
  }

  return false
}

function getSedExpression(args: string[], index: number): string | undefined {
  const token = args[index]
  if (!token) return undefined

  if (token === '-e' || token === '--expression') return args[index + 1]
  if (token.startsWith('--expression=')) return token.slice('--expression='.length)
  if (token.startsWith('-e') && token.length > 2 && !token.startsWith('--')) {
    return token.slice(2)
  }
  // 第一个非 flag 位置参数即 sed 表达式（无 -e 时）
  if (!token.startsWith('-')) return token

  return undefined
}

function hasDangerousSedExpression(expr: string): boolean {
  // boundary 字符类：行首 / 分号 / `}`（块结束）/ `{`（块开始）—— 含 `{` 修复 P0
  const exprBoundary = '(?:^|[;{}])'
  const trimmed = expr.trim()

  // 表达式内的 w / W / r / R / e / F 危险命令（开头 / 分号后 / 块开/结尾）
  if (new RegExp(`${exprBoundary}\\s*[wWrRFe](?:\\s+|$|;|\\})`).test(trimmed)) {
    return true
  }

  // s/.../.../w 标志
  return /s\/[^/]*\/[^/]*\/[a-zA-Z]*w\b/.test(trimmed)
}

const PS_CONFIG: ExternalCommandConfig = {
  safeFlags: {
    '-e': 'none',
    '-A': 'none',
    '-a': 'none',
    '-d': 'none',
    '-N': 'none',
    '--deselect': 'none',
    '-f': 'none',
    '-F': 'none',
    '-l': 'none',
    '-j': 'none',
    '-y': 'none',
    '-w': 'none',
    '-ww': 'none',
    '--width': 'number',
    '-c': 'none',
    '-H': 'none',
    '--forest': 'none',
    '--headers': 'none',
    '--no-headers': 'none',
    '-n': 'string',
    '--sort': 'string',
    '-L': 'none',
    '-T': 'none',
    '-m': 'none',
    '-C': 'string',
    '-G': 'string',
    '-g': 'string',
    '-p': 'string',
    '--pid': 'string',
    '-q': 'string',
    '--quick-pid': 'string',
    '-s': 'string',
    '--sid': 'string',
    '-t': 'string',
    '--tty': 'string',
    '-U': 'string',
    '-u': 'string',
    '--user': 'string',
    '--help': 'none',
    '--info': 'none',
    '-V': 'none',
    '--version': 'none',
  },
  // SECURITY: block BSD-style 'e' modifier (shows env vars)
  additionalCommandIsDangerousCallback: (
    _rawCommand: string,
    args: string[],
  ) => {
    return args.some(
      (a) => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a),
    )
  },
}

const TREE_CONFIG: ExternalCommandConfig = {
  safeFlags: {
    '-a': 'none',
    '-d': 'none',
    '-l': 'none',
    '-f': 'none',
    '-x': 'none',
    '-L': 'number',
    // SECURITY: -R REMOVED — combined with -H -L 写
    // 00Tree.html 文件到子目录（FILE WRITE without permission）
    '-P': 'string',
    '-I': 'string',
    '--gitignore': 'none',
    '--gitfile': 'string',
    '--ignore-case': 'none',
    '--matchdirs': 'none',
    '--metafirst': 'none',
    '--prune': 'none',
    '--info': 'none',
    '--infofile': 'string',
    '--noreport': 'none',
    '--charset': 'string',
    '--filelimit': 'number',
    '-q': 'none',
    '-N': 'none',
    '-Q': 'none',
    '-p': 'none',
    '-u': 'none',
    '-g': 'none',
    '-s': 'none',
    '-h': 'none',
    '--si': 'none',
    '--du': 'none',
    '-D': 'none',
    '--timefmt': 'string',
    '-F': 'none',
    '--inodes': 'none',
    '--device': 'none',
    '-v': 'none',
    '-t': 'none',
    '-c': 'none',
    '-U': 'none',
    '-r': 'none',
    '--dirsfirst': 'none',
    '--filesfirst': 'none',
    '--sort': 'string',
    '-i': 'none',
    '-A': 'none',
    '-S': 'none',
    '-n': 'none',
    '-C': 'none',
    '-X': 'none',
    '-J': 'none',
    '-H': 'string',
    '--nolinks': 'none',
    '--hintro': 'string',
    '--houtro': 'string',
    '-T': 'string',
    '--hyperlink': 'none',
    '--scheme': 'string',
    '--authority': 'string',
    '--fromfile': 'none',
    '--fromtabfile': 'none',
    '--fflinks': 'none',
    '--help': 'none',
    '--version': 'none',
  },
}

// ---------------------------------------------------------------------------
// SAFE_TARGET_COMMANDS_FOR_XARGS
//
// xargs target command 必须在这个集合内才允许。这些命令本身是纯 readonly utility
// （无危险 flag），所以一旦匹配 xargs target 就停止 flag 校验（`break`）。
// ---------------------------------------------------------------------------

const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo',
  'printf',
  'wc',
  'grep',
  'head',
  'tail',
] as const

// ---------------------------------------------------------------------------
// COMMAND_ALLOWLIST — 整合 6 命令（git × 25 + xargs + sed + ps + tree）
// ---------------------------------------------------------------------------

const COMMAND_ALLOWLIST: Record<string, ExternalCommandConfig> = {
  ...GIT_READ_ONLY_COMMANDS,
  xargs: XARGS_CONFIG,
  sed: SED_CONFIG,
  ps: PS_CONFIG,
  tree: TREE_CONFIG,
}

// ---------------------------------------------------------------------------
// find — 单 regex denylist
//
// 设计取舍：find 的 flags 太多（GNU/macOS find 各一堆），用 allowlist 反而漏；
// 改用 denylist：禁 -delete / -exec / -execdir / -ok / -okdir / -fprint(0) / -fls /
// -fprintf。这些是真正写文件 / 执行子命令的危险 flag，其余全 readonly。
// 同时 [^<>()$`|{}&;\n\r\s] 字符类禁 shell metachar 防注入。
// ---------------------------------------------------------------------------

const FIND_REGEX =
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/

// ---------------------------------------------------------------------------
// containsUnquotedExpansion
//
// 检测命令字符串中**未在引号内**的 `$VAR` 变量展开 / glob `?*[]` 字符。
// 这些会在 bash 运行时展开成任意内容，可能绕过我们 token 级的校验。
// 例如 `git diff "$Z--output=/tmp/pwned"` → bash 展开成 `git diff --output=/tmp/pwned`
// → 文件写入。我们无法在 input-time 知道展开后是什么，所以只能拒绝。
// ---------------------------------------------------------------------------

/**
 * Quote-aware metachar 检测：只拒绝 **未在引号内** 的 shell metachar `| ; > < `'\``。
 *
 * 简单 regex `[|;><\`]` 会把 `sed '1{e cat;p;}'` 这种"分号在 sed expression 引号内"
 * 的合法 case 错杀。sed / awk / find -name "..." 等命令的 expression 内允许字面
 * `;` / `<` 等字符。
 *
 * 注：未引号 `$VAR` / glob 由 `containsUnquotedExpansion` 单独检测，这里只看
 * pipe / redirect / subshell / backtick 这种 shell 控制字符。
 */
function containsUnquotedShellMetachar(command: string): boolean {
  const quoteState = createQuoteScanState()

  for (let i = 0; i < command.length; i++) {
    const c = command[i]

    if (consumeQuoteControlChar(quoteState, c)) continue
    if (quoteState.inSingleQuote || quoteState.inDoubleQuote) continue

    // unquoted shell metachar
    if (c === '|' || c === ';' || c === '>' || c === '<' || c === '`') {
      return true
    }
  }
  return false
}

function containsUnquotedExpansion(command: string): boolean {
  const quoteState = createQuoteScanState()

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // SECURITY: 仅在 single quote 外把 `\` 当 escape
    if (consumeQuoteControlChar(quoteState, currentChar)) continue

    if (quoteState.inSingleQuote) continue

    // `$` 在 double quote 和 unquoted 都展开（仅 single quote 内字面）
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    if (quoteState.inDoubleQuote) continue

    // glob 字符仅在完全 unquoted 时危险（双引号内字面）
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  return false
}

interface TokenizeState extends QuoteScanState {
  current: string
  hasContent: boolean
}

function createTokenizeState(): TokenizeState {
  return {
    ...createQuoteScanState(),
    current: '',
    hasContent: false,
  }
}

function consumeTokenControlChar(state: TokenizeState, c: string | undefined): boolean {
  if (state.escaped) {
    state.current += c
    state.escaped = false
    state.hasContent = true
    return true
  }

  if (c === '\\' && !state.inSingleQuote) {
    state.escaped = true
    return true
  }

  if (c === "'" && !state.inDoubleQuote) {
    state.inSingleQuote = !state.inSingleQuote
    state.hasContent = true
    return true
  }

  if (c === '"' && !state.inSingleQuote) {
    state.inDoubleQuote = !state.inDoubleQuote
    state.hasContent = true
    return true
  }

  return false
}

function pushToken(tokens: string[], state: TokenizeState): void {
  if (!state.hasContent) return

  tokens.push(state.current)
  state.current = ''
  state.hasContent = false
}

// ---------------------------------------------------------------------------
// tokenize — 简化版 shell tokenizer
//
// 不引入 shell-quote 依赖，自行实现最小化 quote 解析。
// 处理：
//   - 单引号 / 双引号边界（quote 内字面，包括空格）
//   - `\` 转义（quote 外）
//   - 空白分隔
//   - 拒绝 shell metachar (`|` `>` `<` `;` `&` 单独出现) —— 由 caller 上游已经拒过
//
// 返回：成功 tokens 数组 / 失败 null（quote 不闭合等）。
// ---------------------------------------------------------------------------

export function tokenizeShellCommand(command: string): string[] | null {
  const tokens: string[] = []
  const state = createTokenizeState()

  for (let i = 0; i < command.length; i++) {
    const c = command[i]

    if (consumeTokenControlChar(state, c)) continue

    if ((c === ' ' || c === '\t') && !state.inSingleQuote && !state.inDoubleQuote) {
      pushToken(tokens, state)
      continue
    }

    state.current += c
    state.hasContent = true
  }

  if (state.inSingleQuote || state.inDoubleQuote) return null // 引号未闭合
  if (state.escaped) return null // 末尾孤立 `\`
  pushToken(tokens, state)
  return tokens
}

// ---------------------------------------------------------------------------
// validateFlagArgument
// ---------------------------------------------------------------------------

const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/

interface ValidateFlagsOptions {
  commandName?: string
  rawCommand?: string
  xargsTargetCommands?: readonly string[]
}

interface FlagTokenParts {
  flag: string
  hasEquals: boolean
  inlineValue: string
}

interface FlagValidationResult {
  ok: boolean
  nextIndex: number
}

interface XargsTargetResult {
  handled: boolean
  allowed: boolean
  stop: boolean
  nextIndex: number
}

function validateFlagArgument(value: string, argType: FlagArgType): boolean {
  switch (argType) {
    case 'none':
      return false
    case 'number':
      return /^\d+$/.test(value)
    case 'string':
      return true
    case 'char':
      return value.length === 1
    case '{}':
      return value === '{}'
    case 'EOF':
      return value === 'EOF'
    default:
      return false
  }
}

function isFlagToken(token: string): boolean {
  return token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)
}

function splitFlagToken(token: string): FlagTokenParts {
  const hasEquals = token.includes('=')
  const [flag, ...valueParts] = token.split('=')

  return {
    flag: flag || '',
    hasEquals,
    inlineValue: valueParts.join('='),
  }
}

function readFlagArgument(
  tokens: string[],
  index: number,
  parts: FlagTokenParts,
): FlagValidationResult & { argValue: string } {
  if (parts.hasEquals) {
    return {
      ok: true,
      nextIndex: index + 1,
      argValue: parts.inlineValue,
    }
  }

  const nextToken = tokens[index + 1]
  if (index + 1 >= tokens.length || (nextToken && isFlagToken(nextToken))) {
    return {
      ok: false,
      nextIndex: index,
      argValue: '',
    }
  }

  return {
    ok: true,
    nextIndex: index + 2,
    argValue: nextToken || '',
  }
}

function isAllowedDashPrefixedStringArg(
  flag: string,
  argValue: string,
  options?: ValidateFlagsOptions,
): boolean {
  if (!argValue.startsWith('-')) return true

  // git --sort 允许 -prefix 反向排序（特殊 case）
  return (
    flag === '--sort' &&
    options?.commandName === 'git' &&
    argValue.match(/^-[a-zA-Z]/) !== null
  )
}

function isAllowedAttachedNumericArg(
  flag: string,
  config: ExternalCommandConfig,
  options?: ValidateFlagsOptions,
): boolean {
  // grep / rg 的 -A20 / -B10 attached numeric arg（本批不含独立 grep / rg，
  // 但 git grep 的 commandName 是 'git'，已经走 git 子命令路径不会到这里；
  // 保留这段以保持算法完整）
  if (options?.commandName !== 'grep' && options?.commandName !== 'rg') return false
  if (!flag.startsWith('-') || flag.startsWith('--') || flag.length <= 2) return false

  const potentialFlag = flag.substring(0, 2)
  const potentialValue = flag.substring(2)
  const flagType = config.safeFlags[potentialFlag]

  if (!flagType || !/^\d+$/.test(potentialValue)) return false
  if (flagType !== 'number' && flagType !== 'string') return false

  return validateFlagArgument(potentialValue, flagType)
}

function validateBundledShortFlags(
  flag: string,
  config: ExternalCommandConfig,
): boolean {
  // SECURITY: bundled 短 flag 如 -nr，必须每个都是 'none'
  if (!flag.startsWith('-') || flag.startsWith('--') || flag.length <= 2) return false

  for (let j = 1; j < flag.length; j++) {
    const singleFlag = '-' + flag[j]
    const flagType = config.safeFlags[singleFlag]
    if (!flagType || flagType !== 'none') return false
  }

  return true
}

function isAllowedUnknownFlag(
  flag: string,
  config: ExternalCommandConfig,
  options?: ValidateFlagsOptions,
): boolean {
  // git -<number> shorthand for -n <number>
  if (options?.commandName === 'git' && flag.match(/^-\d+$/)) return true
  if (isAllowedAttachedNumericArg(flag, config, options)) return true
  return validateBundledShortFlags(flag, config)
}

function validateKnownFlag(
  tokens: string[],
  index: number,
  parts: FlagTokenParts,
  flagArgType: FlagArgType,
  options?: ValidateFlagsOptions,
): FlagValidationResult {
  if (flagArgType === 'none') {
    return {
      ok: !parts.hasEquals,
      nextIndex: parts.hasEquals ? index : index + 1,
    }
  }

  const arg = readFlagArgument(tokens, index, parts)
  if (!arg.ok) return arg
  if (flagArgType === 'string' && !isAllowedDashPrefixedStringArg(parts.flag, arg.argValue, options)) {
    return {
      ok: false,
      nextIndex: arg.nextIndex,
    }
  }
  if (!validateFlagArgument(arg.argValue, flagArgType)) {
    return {
      ok: false,
      nextIndex: arg.nextIndex,
    }
  }

  return {
    ok: true,
    nextIndex: arg.nextIndex,
  }
}

function checkXargsTarget(
  tokens: string[],
  index: number,
  options?: ValidateFlagsOptions,
): XargsTargetResult {
  let token = tokens[index]
  let targetIndex = index
  const noResult = {
    handled: false,
    allowed: true,
    stop: false,
    nextIndex: index,
  }

  if (!options?.xargsTargetCommands || options.commandName !== 'xargs') return noResult
  if (!token || (token.startsWith('-') && token !== '--')) return noResult

  if (token === '--' && index + 1 < tokens.length) {
    targetIndex = index + 1
    token = tokens[targetIndex]
  }

  if (token && options.xargsTargetCommands.includes(token)) {
    return {
      handled: true,
      allowed: true,
      stop: true,
      nextIndex: targetIndex,
    }
  }

  return {
    handled: true,
    allowed: false,
    stop: false,
    nextIndex: index,
  }
}

interface QuoteScanState {
  inSingleQuote: boolean
  inDoubleQuote: boolean
  escaped: boolean
}

function createQuoteScanState(): QuoteScanState {
  return {
    inSingleQuote: false,
    inDoubleQuote: false,
    escaped: false,
  }
}

function consumeQuoteControlChar(state: QuoteScanState, c: string | undefined): boolean {
  if (state.escaped) {
    state.escaped = false
    return true
  }

  if (c === '\\' && !state.inSingleQuote) {
    state.escaped = true
    return true
  }

  if (c === "'" && !state.inDoubleQuote) {
    state.inSingleQuote = !state.inSingleQuote
    return true
  }

  if (c === '"' && !state.inSingleQuote) {
    state.inDoubleQuote = !state.inDoubleQuote
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// validateFlags
//
// 主算法：从 startIndex 开始遍历 tokens，对每个 flag 校验 safeFlags 中是否注册 +
// 是否 arg type 一致；遇到 `--` 终止（除非 respectsDoubleDash=false）；
// xargs 特殊处理 target command；git 特殊处理 -<number> shorthand。
// ---------------------------------------------------------------------------

function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: ValidateFlagsOptions,
): boolean {
  let i = startIndex

  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) {
      i++
      continue
    }

    // xargs special: 命中 target command 则 break（target 自身的 flag 不校验）
    const xargsTarget = checkXargsTarget(tokens, i, options)
    if (xargsTarget.handled) {
      if (!xargsTarget.allowed) return false
      if (xargsTarget.stop) break
      i = xargsTarget.nextIndex
      continue
    }

    if (token === '--') {
      if (config.respectsDoubleDash !== false) {
        i++
        break
      }
      i++
      continue
    }

    if (!isFlagToken(token)) {
      // 非 flag 参数（rev spec / file path / pattern）
      i++
      continue
    }

    const parts = splitFlagToken(token)
    if (!parts.flag) return false

    const flagArgType = config.safeFlags[parts.flag]
    if (!flagArgType) {
      if (!isAllowedUnknownFlag(parts.flag, config, options)) return false
      i++
      continue
    }

    const flagResult = validateKnownFlag(tokens, i, parts, flagArgType, options)
    if (!flagResult.ok) return false
    i = flagResult.nextIndex
  }

  return true
}

// ---------------------------------------------------------------------------
// 入口：validateSystemCommand
// ---------------------------------------------------------------------------

/**
 * 决策结果。`code` 给上层做分类（telemetry / 测试断言）。
 */
export interface SystemCommandDecision {
  allowed: boolean
  reason?: string
  code?:
    | 'not_system_command'
    | 'forbidden_metachar'
    | 'unquoted_expansion'
    | 'tokenize_failed'
    | 'unknown_flag'
    | 'unsafe_command'
    | 'find_denylist_match'
    | 'sed_dangerous_expression'
}

interface MatchedCommandConfig {
  commandConfig: ExternalCommandConfig
  commandTokens: number
  matchedPattern: string
}

function rejectSystemCommand(
  code: NonNullable<SystemCommandDecision['code']>,
  reason: string,
): SystemCommandDecision {
  return {
    allowed: false,
    code,
    reason,
  }
}

function getSyntaxRejection(trimmed: string): SystemCommandDecision | null {
  // Defense-in-depth: 即便 caller 已经拒过 metachar，再筛一次防独立调用。
  // **关键 quote-aware**：sed / awk / find 等命令的 expression 内允许字面 `;` `<`
  // 等字符（如 `sed '1{p;}'` 块内分隔符）；naive regex `[|;><\`]` 会错杀这些
  // 合法 case，并把后续 sed/find 的 dangerous-callback 路径短路（提前返回
  // forbidden_metachar，让具体 sed_dangerous_expression code 失效）。
  if (containsUnquotedShellMetachar(trimmed)) {
    return rejectSystemCommand(
      'forbidden_metachar',
      '命令含管道 / 重定向 / 子 shell 字符',
    )
  }
  if (/\$\(/.test(trimmed)) {
    return rejectSystemCommand('forbidden_metachar', '命令含 $(...) 子 shell')
  }

  // SECURITY: 未引号 `$VAR` / glob 在运行时展开成任意值
  if (containsUnquotedExpansion(trimmed)) {
    return rejectSystemCommand(
      'unquoted_expansion',
      '命令含未引号 $VAR 变量展开 / glob 字符（运行时不可预测）',
    )
  }

  return null
}

function validateFindCommand(trimmed: string): SystemCommandDecision | null {
  if (!/^find(?:\s|$)/.test(trimmed)) return null
  if (FIND_REGEX.test(trimmed)) return { allowed: true }

  return rejectSystemCommand(
    'find_denylist_match',
    'find 命令含被拒绝的 flag（-delete / -exec / -execdir / -ok / -okdir / -fprint / -fls / -fprintf）或字符',
  )
}

function getGitGlobalDangerousFlagRejection(
  tokens: string[],
  trimmed: string,
): SystemCommandDecision | null {
  if (tokens[0] !== 'git') return null

  if (/(?:^|\s)-c(?:\s|=)/.test(' ' + trimmed)) {
    return rejectSystemCommand(
      'unsafe_command',
      'git -c 允许任意 config 注入（如 core.fsmonitor → RCE）',
    )
  }
  if (/(?:^|\s)--exec-path(?:\s|=)/.test(trimmed)) {
    return rejectSystemCommand(
      'unsafe_command',
      'git --exec-path 允许 path manipulation → RCE',
    )
  }
  if (/(?:^|\s)--config-env(?:\s|=)/.test(trimmed)) {
    return rejectSystemCommand(
      'unsafe_command',
      'git --config-env 允许通过 env var 注入 config → RCE',
    )
  }

  return null
}

function commandPatternMatches(tokens: string[], cmdParts: string[]): boolean {
  if (tokens.length < cmdParts.length) return false

  for (let i = 0; i < cmdParts.length; i++) {
    if (tokens[i] !== cmdParts[i]) return false
  }

  return true
}

function matchCommandConfig(tokens: string[]): MatchedCommandConfig | null {
  // 多词命令前缀匹配（"git diff" / "git remote show" / "git stash list" 等）
  // 1284-1300：按 allowlist key 顺序遍历，最长前缀优先。
  // 用 Object.entries 顺序（JavaScript 对象迭代是插入顺序）。
  // 我们这里按 key 长度倒序（更长的先尝试），等价但更显式。
  const sortedKeys = Object.keys(COMMAND_ALLOWLIST).sort(
    (a, b) => b.split(' ').length - a.split(' ').length,
  )

  for (const cmdPattern of sortedKeys) {
    const cmdParts = cmdPattern.split(' ')
    if (!commandPatternMatches(tokens, cmdParts)) continue

    const commandConfig = COMMAND_ALLOWLIST[cmdPattern]
    if (!commandConfig) return null

    return {
      commandConfig,
      commandTokens: cmdParts.length,
      matchedPattern: cmdPattern,
    }
  }

  return null
}

function getGitLsRemoteRejection(tokens: string[]): SystemCommandDecision | null {
  if (tokens[0] !== 'git' || tokens[1] !== 'ls-remote') return null

  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token || token.startsWith('-')) continue

    if (token.includes('://')) {
      return rejectSystemCommand(
        'unsafe_command',
        'git ls-remote 不允许 URL 参数（防止数据 exfil）',
      )
    }
    if (token.includes('@') || token.includes(':')) {
      return rejectSystemCommand(
        'unsafe_command',
        'git ls-remote 不允许 SSH/远程协议参数',
      )
    }
    if (token.includes('$')) {
      return rejectSystemCommand(
        'unsafe_command',
        'git ls-remote 不允许变量引用',
      )
    }
  }

  return null
}

function getTokenSafetyRejection(
  tokens: string[],
  commandTokens: number,
): SystemCommandDecision | null {
  // SECURITY 1351-1369: token 内含 `$` (containsUnquotedExpansion
  // 已经挡了未引号 `$`，但 tokenize 后引号被剥，token 内可能仍有字面 `$`)
  // 也防 brace expansion `{a,b}` / `{1..5}`
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue

    if (token.includes('$')) {
      return rejectSystemCommand('unquoted_expansion', 'token 内含变量引用 $')
    }
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return rejectSystemCommand(
        'unsafe_command',
        'token 内含 brace expansion {a,b} / {1..5}（运行时不可预测）',
      )
    }
  }

  return null
}

function getPatternNewlineRejection(
  tokens: string[],
  trimmed: string,
): SystemCommandDecision | null {
  // grep / git grep / 其他 ts pattern 命令的 newline / CR 注入防御
  if ((tokens[0] === 'rg' || tokens[0] === 'grep') && /[\n\r]/.test(trimmed)) {
    return rejectSystemCommand(
      'unsafe_command',
      'grep / rg pattern 含换行符（可被用于注入）',
    )
  }

  return null
}

function getBacktickRejection(trimmed: string): SystemCommandDecision | null {
  // 反引号 backtick 是 command substitution（同 $() 等价但旧语法）
  if (!/`/.test(trimmed)) return null

  return rejectSystemCommand('forbidden_metachar', '命令含反引号子 shell')
}

function getDangerousCallbackRejection(
  trimmed: string,
  tokens: string[],
  matched: MatchedCommandConfig,
): SystemCommandDecision | null {
  if (!matched.commandConfig.additionalCommandIsDangerousCallback) return null

  const args = tokens.slice(matched.commandTokens)
  if (!matched.commandConfig.additionalCommandIsDangerousCallback(trimmed, args)) {
    return null
  }

  // 把 sed 的 callback 拒绝单独标 code，便于测试断言
  const code: SystemCommandDecision['code'] =
    matched.matchedPattern === 'sed' ? 'sed_dangerous_expression' : 'unsafe_command'

  return rejectSystemCommand(
    code,
    `命令 "${matched.matchedPattern}" 含被 deep-validation 拒绝的危险参数`,
  )
}

/**
 * 校验系统命令是否符合 readonly + flag allowlist 协议。
 *
 * 调用方约定：caller 已经拒过 shell metachar `|;><`/反引号/`$()`（见
 * `restricted-shell-allowlist.ts` `parseTabtinSubcommand`）。本函数仍做一次
 * defense-in-depth，避免单独使用时被绕过。
 *
 * @param command 完整命令字符串（不含 `cd ... &&` 前缀，由 caller 剥离）
 */
export function validateSystemCommand(command: string): SystemCommandDecision {
  const trimmed = command.trim()
  if (!trimmed) {
    return rejectSystemCommand('not_system_command', '命令为空')
  }

  const syntaxRejection = getSyntaxRejection(trimmed)
  if (syntaxRejection) return syntaxRejection

  // 特殊处理：find 用单 regex denylist（1569）
  // tokenize 之前直接对原始字符串匹配。
  const findDecision = validateFindCommand(trimmed)
  if (findDecision) return findDecision

  const tokens = tokenizeShellCommand(trimmed)
  if (!tokens || tokens.length === 0) {
    return rejectSystemCommand(
      'tokenize_failed',
      '命令解析失败（引号未闭合或格式异常）',
    )
  }

  // git 全局危险 flag 在 prefix 匹配前先拦——否则 `git -c X log` 因为
  // tokens[1] 是 `-c` 而不是 `log`，prefix 匹配会 miss 全部 'git <X>' 配置，
  // 落到 'not_system_command'（reason 不准确，且依赖 caller 进一步检查容易遗漏）。
  // isCommandReadOnly:1726-1747 的 fallback-path 防护。
  const gitGlobalRejection = getGitGlobalDangerousFlagRejection(tokens, trimmed)
  if (gitGlobalRejection) return gitGlobalRejection

  const matched = matchCommandConfig(tokens)
  if (!matched) return rejectSystemCommand('not_system_command', '不在系统命令 allowlist 中')

  // git ls-remote URL 防御（1307-1326）
  const lsRemoteRejection = getGitLsRemoteRejection(tokens)
  if (lsRemoteRejection) return lsRemoteRejection

  const tokenRejection = getTokenSafetyRejection(tokens, matched.commandTokens)
  if (tokenRejection) return tokenRejection

  // 主 flag 校验
  const ok = validateFlags(tokens, matched.commandTokens, matched.commandConfig, {
    commandName: tokens[0],
    rawCommand: trimmed,
    xargsTargetCommands:
      tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
  })

  if (!ok) {
    return rejectSystemCommand(
      'unknown_flag',
      `命令 "${matched.matchedPattern}" 含未知 flag / 错误 arg 类型 / 不安全 bundle`,
    )
  }

  const newlineRejection = getPatternNewlineRejection(tokens, trimmed)
  if (newlineRejection) return newlineRejection

  const backtickRejection = getBacktickRejection(trimmed)
  if (backtickRejection) return backtickRejection

  // 命令特定 dangerous callback
  const callbackRejection = getDangerousCallbackRejection(trimmed, tokens, matched)
  if (callbackRejection) return callbackRejection

  return { allowed: true }
}

// ---------------------------------------------------------------------------
// 测试用辅助
// ---------------------------------------------------------------------------

export const __testExports = {
  COMMAND_ALLOWLIST,
  GIT_READ_ONLY_COMMANDS,
  SAFE_TARGET_COMMANDS_FOR_XARGS,
  FIND_REGEX,
  tokenize: tokenizeShellCommand,
  validateFlags,
  containsUnquotedExpansion,
}
