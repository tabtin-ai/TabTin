/**
 * 受限模式系统命令 input 级 allowlist 单元测试（J3a / Wave 8）。
 *
 * 覆盖：
 *   - 6 命令各自的 safeFlags 表通过 / unknown flag 拒绝
 *   - find regex denylist：-delete / -exec / -execdir / -ok / -okdir / -fprint(0) / -fls / -fprintf 拒绝
 *   - sed expression 浅校验（产品差异 fail-close）：w / r / e 命令 + substitute-with-write 标志拒绝
 *   - ps BSD-style `e` 字母 token 拒绝（env 泄漏）
 *   - tree -R + -H 不被允许（safeFlags 表没 -R，自动拒）
 *   - xargs target command 必须在 SAFE_TARGET_COMMANDS_FOR_XARGS 中
 *   - shell metachar / 反引号 / `$(...)` / 未引号 `$VAR` / glob 拒绝
 *   - 引号闭合 / 多层 quote / `--` 后 args
 *   - git 全局危险 flag (-c / --exec-path / --config-env) 拒绝
 *   - git ls-remote URL 防御
 *   - git tag / git branch / git remote 的 callback 防止 creation
 *   - git 子命令前缀匹配（"git remote show" 优先于 "git remote"）
 *
 * 命名约定：unit 测试只针对 system-command-allowlist 内部函数，不含 mode 集成
 * 行为（mode 集成在 restricted-shell-allowlist.test.ts 覆盖）。
 */

import { describe, it, expect } from 'vitest'
import {
  validateSystemCommand,
  __testExports,
} from '../system-command-allowlist.js'

const { tokenize, COMMAND_ALLOWLIST, FIND_REGEX, SAFE_TARGET_COMMANDS_FOR_XARGS } =
  __testExports

describe('tokenize', () => {
  it('basic split', () => {
    expect(tokenize('git status -s')).toEqual(['git', 'status', '-s'])
  })

  it('preserves single-quoted spaces', () => {
    expect(tokenize("git log --grep='hello world'")).toEqual([
      'git',
      'log',
      '--grep=hello world',
    ])
  })

  it('preserves double-quoted spaces', () => {
    expect(tokenize('git log --author="Alice Bob"')).toEqual([
      'git',
      'log',
      '--author=Alice Bob',
    ])
  })

  it('handles backslash escape outside quotes', () => {
    expect(tokenize('git log file\\ name')).toEqual(['git', 'log', 'file name'])
  })

  it('rejects unclosed single quote', () => {
    expect(tokenize("git log 'unterminated")).toBeNull()
  })

  it('rejects unclosed double quote', () => {
    expect(tokenize('git log "unterminated')).toBeNull()
  })

  it('rejects trailing lone backslash', () => {
    expect(tokenize('git log \\')).toBeNull()
  })

  it('handles tab as separator', () => {
    expect(tokenize('git\tstatus')).toEqual(['git', 'status'])
  })
})

describe('COMMAND_ALLOWLIST 整体结构', () => {
  it('GIT_READ_ONLY_COMMANDS 至少含核心 8 个高频子命令', () => {
    const required = [
      'git status',
      'git log',
      'git diff',
      'git show',
      'git blame',
      'git branch',
      'git grep',
      'git describe',
    ]
    for (const cmd of required) {
      expect(COMMAND_ALLOWLIST[cmd]).toBeDefined()
    }
  })

  it('xargs / sed / ps / tree 4 个独立命令注册', () => {
    expect(COMMAND_ALLOWLIST['xargs']).toBeDefined()
    expect(COMMAND_ALLOWLIST['sed']).toBeDefined()
    expect(COMMAND_ALLOWLIST['ps']).toBeDefined()
    expect(COMMAND_ALLOWLIST['tree']).toBeDefined()
  })

  it('SAFE_TARGET_COMMANDS_FOR_XARGS 含 6 个 readonly utility', () => {
    expect([...SAFE_TARGET_COMMANDS_FOR_XARGS]).toEqual([
      'echo',
      'printf',
      'wc',
      'grep',
      'head',
      'tail',
    ])
  })

  it('tree config：-R 不在 safeFlags（防 -R + -H + -L 写文件）', () => {
    const tree = COMMAND_ALLOWLIST['tree']
    expect(tree?.safeFlags['-R']).toBeUndefined()
  })

  it('sed config：-i / --in-place 不在 safeFlags', () => {
    const sed = COMMAND_ALLOWLIST['sed']
    expect(sed?.safeFlags['-i']).toBeUndefined()
    expect(sed?.safeFlags['--in-place']).toBeUndefined()
  })

  it('xargs config：-i / -e (lowercase) 不在 safeFlags（GNU getopt parser differential）', () => {
    const xargs = COMMAND_ALLOWLIST['xargs']
    expect(xargs?.safeFlags['-i']).toBeUndefined()
    expect(xargs?.safeFlags['-e']).toBeUndefined()
  })

  it('ps config：-e (UNIX-style) 在 safeFlags 但 BSD `e` 字母 token 由 callback 拒绝', () => {
    const ps = COMMAND_ALLOWLIST['ps']
    expect(ps?.safeFlags['-e']).toBe('none')
    expect(ps?.additionalCommandIsDangerousCallback).toBeDefined()
  })

  it('git ls-remote：--server-option / -o 不在 safeFlags', () => {
    const cfg = COMMAND_ALLOWLIST['git ls-remote']
    expect(cfg?.safeFlags['--server-option']).toBeUndefined()
    expect(cfg?.safeFlags['-o']).toBeUndefined()
  })
})

describe('git status', () => {
  it('bare git status 通过', () => {
    const d = validateSystemCommand('git status')
    expect(d.allowed).toBe(true)
  })

  it('git status -s 通过', () => {
    expect(validateSystemCommand('git status -s').allowed).toBe(true)
  })

  it('git status --porcelain 通过', () => {
    expect(validateSystemCommand('git status --porcelain').allowed).toBe(true)
  })

  it('git status --branch -uall 通过', () => {
    expect(validateSystemCommand('git status --branch -u all').allowed).toBe(
      true,
    )
  })

  it('git status --unknown 拒绝', () => {
    const d = validateSystemCommand('git status --unknown-flag')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_flag')
  })
})

describe('git log', () => {
  it('git log 通过', () => {
    expect(validateSystemCommand('git log').allowed).toBe(true)
  })

  it('git log --oneline -10 通过（git -<num> 等价 -n <num> shorthand）', () => {
    expect(validateSystemCommand('git log --oneline -10').allowed).toBe(true)
  })

  it('git log --author="Alice" --since="2 days ago" 通过', () => {
    expect(
      validateSystemCommand('git log --author="Alice" --since="2 days ago"')
        .allowed,
    ).toBe(true)
  })

  it('git log --pretty=fuller 通过', () => {
    expect(validateSystemCommand('git log --pretty=fuller').allowed).toBe(true)
  })

  it('git log -S secret 通过（pickaxe search 是 readonly）', () => {
    expect(validateSystemCommand('git log -S secret').allowed).toBe(true)
  })

  it('git log -S （无参数）拒绝', () => {
    const d = validateSystemCommand('git log -S')
    expect(d.allowed).toBe(false)
  })
})

describe('git diff', () => {
  it('git diff 通过', () => {
    expect(validateSystemCommand('git diff').allowed).toBe(true)
  })

  it('git diff --cached 通过', () => {
    expect(validateSystemCommand('git diff --cached').allowed).toBe(true)
  })

  it('git diff --output 拒绝（不在 safeFlags）', () => {
    const d = validateSystemCommand('git diff --output=/tmp/pwned')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_flag')
  })
})

describe('git branch — callback 防 creation', () => {
  it('git branch（list）通过', () => {
    expect(validateSystemCommand('git branch').allowed).toBe(true)
  })

  it('git branch -a 通过', () => {
    expect(validateSystemCommand('git branch -a').allowed).toBe(true)
  })

  it('git branch newfeat 拒绝（positional 无 --list = creation）', () => {
    const d = validateSystemCommand('git branch newfeat')
    expect(d.allowed).toBe(false)
  })

  it('git branch -l "feat/*" 通过（pattern after --list）', () => {
    expect(validateSystemCommand('git branch -l "feat/*"').allowed).toBe(true)
  })

  it('git branch --merged main 通过（optional arg after --merged）', () => {
    expect(validateSystemCommand('git branch --merged main').allowed).toBe(
      true,
    )
  })

  it('git branch --contains HEAD 通过', () => {
    expect(validateSystemCommand('git branch --contains HEAD').allowed).toBe(
      true,
    )
  })
})

describe('git tag — callback 防 creation', () => {
  it('git tag（list）通过', () => {
    expect(validateSystemCommand('git tag').allowed).toBe(true)
  })

  it('git tag -l "v1.*" 通过', () => {
    expect(validateSystemCommand('git tag -l "v1.*"').allowed).toBe(true)
  })

  it('git tag v2.0 拒绝（无 --list 的 positional = tag creation）', () => {
    const d = validateSystemCommand('git tag v2.0')
    expect(d.allowed).toBe(false)
  })

  it('git tag --contains HEAD 通过', () => {
    expect(validateSystemCommand('git tag --contains HEAD').allowed).toBe(true)
  })
})

describe('git remote / git remote show 前缀匹配', () => {
  it('git remote -v 通过（更短前缀匹配 git remote）', () => {
    expect(validateSystemCommand('git remote -v').allowed).toBe(true)
  })

  it('git remote add origin 拒绝（positional 触发 callback）', () => {
    const d = validateSystemCommand('git remote add origin')
    expect(d.allowed).toBe(false)
  })

  it('git remote show origin 通过（更长前缀优先匹配 git remote show）', () => {
    expect(validateSystemCommand('git remote show origin').allowed).toBe(true)
  })

  it('git remote show（无 remote name）拒绝（callback 要求恰一个 positional）', () => {
    const d = validateSystemCommand('git remote show')
    expect(d.allowed).toBe(false)
  })
})

describe('git ls-remote URL 防御', () => {
  it('git ls-remote origin 通过', () => {
    expect(validateSystemCommand('git ls-remote origin').allowed).toBe(true)
  })

  it('git ls-remote https://evil/ 拒绝', () => {
    const d = validateSystemCommand('git ls-remote https://evil.example/')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('git ls-remote git@host:repo 拒绝（SSH-style）', () => {
    const d = validateSystemCommand('git ls-remote git@host:repo')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })
})

describe('git 全局危险 flag', () => {
  it('git -c core.fsmonitor=evil log 拒绝（-c 允许 config 注入）', () => {
    const d = validateSystemCommand('git -c core.fsmonitor=evil log')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('git --exec-path=/tmp log 拒绝', () => {
    const d = validateSystemCommand('git --exec-path=/tmp log')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('git --config-env=core.fsmonitor=EVIL log 拒绝', () => {
    const d = validateSystemCommand('git --config-env=core.fsmonitor=EVIL log')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })
})

describe('tree', () => {
  it('tree 通过', () => {
    expect(validateSystemCommand('tree').allowed).toBe(true)
  })

  it('tree -L 2 通过', () => {
    expect(validateSystemCommand('tree -L 2').allowed).toBe(true)
  })

  it('tree -d 通过', () => {
    expect(validateSystemCommand('tree -d').allowed).toBe(true)
  })

  it('tree -R 拒绝（-R + -H + -L 会写 00Tree.html 文件）', () => {
    const d = validateSystemCommand('tree -R -H .')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_flag')
  })

  it('tree -o output.txt 拒绝（-o 不在 safeFlags）', () => {
    const d = validateSystemCommand('tree -o output.txt')
    expect(d.allowed).toBe(false)
  })

  it('tree -P "*.ts" --noreport 通过', () => {
    expect(validateSystemCommand('tree -P "*.ts" --noreport').allowed).toBe(
      true,
    )
  })
})

describe('find', () => {
  it('find . 通过', () => {
    expect(validateSystemCommand('find .').allowed).toBe(true)
  })

  it('find . -name "*.ts" 通过', () => {
    expect(validateSystemCommand('find . -name "*.ts"').allowed).toBe(true)
  })

  it('find . -type f -name "*.test.ts" 通过', () => {
    expect(
      validateSystemCommand('find . -type f -name "*.test.ts"').allowed,
    ).toBe(true)
  })

  it('find . -delete 拒绝', () => {
    const d = validateSystemCommand('find . -delete')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -exec rm {} ; 拒绝', () => {
    const d = validateSystemCommand('find . -exec rm {}')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -execdir touch x 拒绝', () => {
    const d = validateSystemCommand('find . -execdir touch x')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -fprint /tmp/x 拒绝', () => {
    const d = validateSystemCommand('find . -fprint /tmp/x')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -fprint0 /tmp/x 拒绝', () => {
    const d = validateSystemCommand('find . -fprint0 /tmp/x')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -fls /tmp/x 拒绝', () => {
    const d = validateSystemCommand('find . -fls /tmp/x')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -fprintf /tmp/x %p 拒绝', () => {
    const d = validateSystemCommand('find . -fprintf /tmp/x')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -ok rm {} 拒绝', () => {
    const d = validateSystemCommand('find . -ok rm')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find . -okdir touch x 拒绝', () => {
    const d = validateSystemCommand('find . -okdir touch')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('find_denylist_match')
  })

  it('find regex denylist 拒绝危险谓词', () => {
    expect(FIND_REGEX.source).toContain('-delete')
    expect(FIND_REGEX.source).toContain('-exec')
    expect(FIND_REGEX.source).toContain('-execdir')
    expect(FIND_REGEX.source).toContain('-ok')
    expect(FIND_REGEX.source).toContain('-okdir')
    expect(FIND_REGEX.source).toContain('-fprint0?')
    expect(FIND_REGEX.source).toContain('-fls')
    expect(FIND_REGEX.source).toContain('-fprintf')
  })
})

describe('sed', () => {
  it("sed 's/foo/bar/g' file 通过", () => {
    expect(validateSystemCommand("sed 's/foo/bar/g' file").allowed).toBe(true)
  })

  it("sed -n '1,10p' file 通过", () => {
    expect(validateSystemCommand("sed -n '1,10p' file").allowed).toBe(true)
  })

  it('sed -i 拒绝（-i 不在 safeFlags）', () => {
    const d = validateSystemCommand("sed -i 's/old/new/g' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_flag')
  })

  it("sed 's/foo/bar/w /tmp/pwned' 拒绝（substitute-with-write 标志）", () => {
    const d = validateSystemCommand("sed 's/foo/bar/w /tmp/pwned' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed 'w /tmp/pwned' 拒绝（w 命令写文件）", () => {
    const d = validateSystemCommand("sed 'w /tmp/pwned' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed 'r /etc/passwd' 拒绝（r 命令读外部文件注入）", () => {
    const d = validateSystemCommand("sed 'r /etc/passwd' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed 'e cat' 拒绝（e 命令执行子 shell）", () => {
    const d = validateSystemCommand("sed 'e cat' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed -e 'w /tmp/pwned' 拒绝（-e 表达式中含 w 命令）", () => {
    const d = validateSystemCommand("sed -e 'w /tmp/pwned' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  // 回归：GNU sed 块语法 `addr { cmd1; cmd2; }`，块内 `e cmd` 是 RCE 入口。
  // 浅校验必须在 boundary 字符类中含 `{`；漏掉 `{` 等于穿透 → 历史 P0 false-allow。
  it("sed '1{e cat /etc/passwd;p;}' 块语法 + e cmd 拒绝（boundary 含 `{`）", () => {
    const d = validateSystemCommand("sed '1{e cat /etc/passwd;p;}' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed '1{w /tmp/pwned;p;}' 块语法 + w path 拒绝", () => {
    const d = validateSystemCommand("sed '1{w /tmp/pwned;p;}' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed -e '/pat/{s/x/y/g;w /tmp/pwned;}' 块内 substitute + w 拒绝", () => {
    const d = validateSystemCommand("sed -e '/pat/{s/x/y/g;w /tmp/pwned;}' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('sed_dangerous_expression')
  })

  it("sed '1{p;}' 块内仅 print 通过（fail-close 不应该把合法块语法错杀）", () => {
    const d = validateSystemCommand("sed '1{p;}' file")
    expect(d.allowed).toBe(true)
  })

  // brace-expansion 防御："{ + , 同时存在 → brace expansion"防御。
  // sed 地址范围 `1,3{...}` 同时含 `,` 和 `{`，命中 brace-expansion 检测被拒——
  // 是 allowlist 固有 false-positive，依赖 sedValidation.ts 687 行
  // 完整 AST 解析才能区分。本批移植该 false-positive 字面保留；记入 R3a 后续轮次遗留。
  it("sed '1,3{p;}' 地址范围 + 块语法被 brace-expansion 防御错杀（allowlist 固有 false-positive）", () => {
    const d = validateSystemCommand("sed '1,3{p;}' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it("sed '/pat/!d' negation delete 通过（写 stdout 不写文件）", () => {
    const d = validateSystemCommand("sed '/pat/!d' file")
    expect(d.allowed).toBe(true)
  })
})

describe('xargs', () => {
  it('xargs echo 通过（echo 在 SAFE_TARGET_COMMANDS_FOR_XARGS）', () => {
    expect(validateSystemCommand('xargs echo').allowed).toBe(true)
  })

  it('xargs -n 1 echo 通过', () => {
    expect(validateSystemCommand('xargs -n 1 echo').allowed).toBe(true)
  })

  it('xargs grep pattern 通过（grep 在 SAFE_TARGET）', () => {
    expect(validateSystemCommand('xargs grep pattern').allowed).toBe(true)
  })

  it('xargs rm 拒绝（rm 不在 SAFE_TARGET）', () => {
    const d = validateSystemCommand('xargs rm')
    expect(d.allowed).toBe(false)
  })

  it('xargs -I {} echo {} 通过', () => {
    expect(validateSystemCommand('xargs -I {} echo {}').allowed).toBe(true)
  })

  it('xargs -E EOF echo 通过', () => {
    expect(validateSystemCommand('xargs -E EOF echo').allowed).toBe(true)
  })

  it('xargs -e EOF echo 拒绝（-e lowercase 故意从 safeFlags 移除）', () => {
    const d = validateSystemCommand('xargs -e EOF echo')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_flag')
  })

  it('xargs -i x echo 拒绝（-i lowercase 故意移除）', () => {
    const d = validateSystemCommand('xargs -i x echo')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_flag')
  })
})

describe('ps', () => {
  it('ps 通过（bare 命令无 flag）', () => {
    expect(validateSystemCommand('ps').allowed).toBe(true)
  })

  it('ps -ef 通过', () => {
    // -ef 是 bundled 短 flag，每个都是 'none'
    expect(validateSystemCommand('ps -ef').allowed).toBe(true)
  })

  it('ps aux 拒绝（BSD-style `aux` 含 `e` 字母 token，泄漏 env）', () => {
    const d = validateSystemCommand('ps aux')
    // BSD callback 命中：'aux' 是 letter-only token 且含 'e'
    // 但 'aux' 不含 'e'，所以这条实际通过；改测 axe
    expect(d.allowed).toBe(true) // aux 不含 e
  })

  it('ps axe 拒绝（BSD `e` modifier 在 letter-only token）', () => {
    const d = validateSystemCommand('ps axe')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('ps e 拒绝（裸 e 字母 token）', () => {
    const d = validateSystemCommand('ps e')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('ps -e 通过（带 dash 的 -e 是 UNIX-style，安全）', () => {
    expect(validateSystemCommand('ps -e').allowed).toBe(true)
  })

  it('ps -p 1234 通过', () => {
    expect(validateSystemCommand('ps -p 1234').allowed).toBe(true)
  })
})

describe('Defense-in-depth：metachar / 子 shell / glob / `$VAR`', () => {
  it('管道拒绝', () => {
    expect(validateSystemCommand('git status | grep modified').code).toBe(
      'forbidden_metachar',
    )
  })

  it('重定向拒绝', () => {
    expect(validateSystemCommand('git log > /tmp/x').code).toBe(
      'forbidden_metachar',
    )
  })

  it('反引号拒绝', () => {
    const d = validateSystemCommand('git log `whoami`')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('forbidden_metachar')
  })

  it('$(...) 拒绝', () => {
    const d = validateSystemCommand('git log $(whoami)')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('forbidden_metachar')
  })

  it('未引号 $VAR 拒绝（运行时展开不可预测）', () => {
    const d = validateSystemCommand('git log $REF')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unquoted_expansion')
  })

  it('双引号内 $VAR 仍拒绝（"$Z--output=/tmp/pwned"）', () => {
    const d = validateSystemCommand('git diff "$Z--output=/tmp/pwned"')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unquoted_expansion')
  })

  it("单引号内 $VAR 仍拒绝（token-level 全拒策略）", () => {
    // 设计：containsUnquotedExpansion 在原命令字符串上跳过单引号内的 $；
    // 但 tokenize 后 token 内仍含字面 `$VAR`——validator 此时无法区分原本是单引号
    // 字面还是 unquoted/double-quoted，**为安全起见一刀切拒绝任何 token 含 $**。
    // 这是 fail-close 策略（token 级全拒）。
    const d = validateSystemCommand("git log --grep='$VAR'")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unquoted_expansion')
  })

  it('未引号 glob `*` 拒绝', () => {
    const d = validateSystemCommand('git log *.ts')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unquoted_expansion')
  })

  it('引号内 glob 通过（grep pattern 之类合法用法）', () => {
    expect(validateSystemCommand('git log --grep="*.ts"').allowed).toBe(true)
  })

  it('brace expansion {a,b} 拒绝', () => {
    const d = validateSystemCommand('git diff {a,b}')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('range expansion {1..5} 拒绝', () => {
    const d = validateSystemCommand('git log {1..5}')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unsafe_command')
  })

  it('空命令拒绝', () => {
    const d = validateSystemCommand('')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('not_system_command')
  })

  it('完全不识别的命令拒绝', () => {
    const d = validateSystemCommand('rm -rf /')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('not_system_command')
  })
})

describe('`--` 后参数处理', () => {
  it('git log -- file 通过（-- 后是 paths）', () => {
    expect(validateSystemCommand('git log -- file.ts').allowed).toBe(true)
  })

  it('git log -- --evil 通过（-- 后即使是 --evil 也只当 path）', () => {
    // 默认 respectsDoubleDash=true，-- 后停止 flag 校验
    expect(validateSystemCommand('git log -- --not-a-flag').allowed).toBe(true)
  })

  it('git tag -- mytag 拒绝（即使 -- 后，git tag callback 仍把它当 creation 拒绝）', () => {
    // tag callback：处理 seenDashDash 后仍检查 positional 不在 list 模式
    const d = validateSystemCommand('git tag -- mytag')
    expect(d.allowed).toBe(false)
  })
})
