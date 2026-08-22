import type { DenyRule } from './types';
import {
  HARDLINE_COMMAND_DENYLIST as GENERATED_HARDLINE_COMMAND_DENYLIST,
} from './hardline-command-denylist.generated';

/**
 * hardline-v3 absolute_command_denylist — codegen 自 hardline-v3-rules.json。
 * commandValidator 在 CRITICAL_DENYLIST 之前检查（pre-split + per-subcommand）。
 *
 * 与 security-policy/hardline-v3.ts:ABSOLUTE_COMMAND_DENYLIST 同源；
 * terminal-only 规则见下方 CRITICAL_DENYLIST / DEFAULT_DENYLIST 注释。
 */
export const HARDLINE_COMMAND_DENYLIST: DenyRule[] =
  GENERATED_HARDLINE_COMMAND_DENYLIST.map((rule) => ({
    name: rule.name,
    pattern: rule.pattern,
    reason: rule.description,
  }));

// ── Shell binary matching fragments ────────────────────────────────
// Reusable regex source strings for matching shell binaries with
// optional absolute paths (/bin/sh, /usr/bin/bash, /usr/local/bin/sh)
// and /usr/bin/env wrappers (/usr/bin/env bash, env -S sh).
//
// SHELL_BIN_SH  — matches sh / bash (with optional path)
// SHELL_ENV_SH  — matches env sh / env bash (with optional path on env)
// SHELL_ANY_SH  — combined: either direct path or via env
//
// SHELL_BIN_ALL — all shells (sh/bash/dash/zsh/fish/tcsh/csh) with optional path
// SHELL_ENV_ALL — all shells via env
// SHELL_ANY_ALL — combined for all shells

const PATH_PREFIX = String.raw`(?:\/(?:usr\/(?:local\/)?)?bin\/)?`;
const ENV_FLAGS  = String.raw`(?:-\S+\s+)*`;

const SH_NAMES  = String.raw`(?:ba)?sh`;
const ALL_NAMES = String.raw`(?:(?:ba|da)?sh|zsh|fish|tcsh|csh)`;

const SHELL_ANY_SH  = `${PATH_PREFIX}(?:${SH_NAMES}|env\\s+${ENV_FLAGS}${SH_NAMES})`;
const SHELL_ANY_ALL = `${PATH_PREFIX}(?:${ALL_NAMES}|env\\s+${ENV_FLAGS}${ALL_NAMES})`;

/**
 * Critical deny rules that take precedence over the allowlist.
 * These catch dangerous patterns that may start with an allowed binary
 * (e.g. "curl ... | sh" starts with allowlisted "curl").
 *
 * terminal-only：pipe-to-shell / process-substitution / python-inline 等
 * 预检特有规则。与 hardline 重叠的 curl|sh 已由 HARDLINE_COMMAND_DENYLIST
 * codegen（SSoT = absolute_command_denylist:"curl pipe to shell"）。
 */
export const CRITICAL_DENYLIST: DenyRule[] = [
  // ── pre-split-only rules ──────────────────────────────────────────
  // These patterns contain the pipe operator `|` and therefore ONLY
  // match when tested against the FULL (unsplit) command string.
  // After splitCommandChain() splits on `|`, individual sub-commands
  // can never match these patterns.  The pre-split check in
  // CommandValidator.validate() ensures they are still enforced.
  {
    name: 'pipe-to-shell',
    pattern: new RegExp(String.raw`\|\s*` + SHELL_ANY_SH + String.raw`\b`, 'i'),
    reasonKey: 'errors.denylist.pipeToShell'
  },
  {
    name: 'process-substitution-shell',
    pattern: new RegExp(SHELL_ANY_SH + String.raw`\s+<\s*\(`, 'i'),
    reasonKey: 'errors.denylist.pipeToShell'
  },
  {
    name: 'process-substitution-input',
    pattern: /<\s*\(\s*(curl|wget|nc|ncat)\b/i,
    reasonKey: 'errors.denylist.pipeToShell'
  },
  {
    name: 'process-substitution-output',
    pattern: new RegExp(String.raw`>\s*\(\s*` + SHELL_ANY_SH + String.raw`\b`, 'i'),
    reasonKey: 'errors.denylist.pipeToShell'
  },
  {
    name: 'python-inline',
    pattern: /\bpython3?\s+-c\b/i,
    reasonKey: 'errors.denylist.pythonInline'
  },
  {
    name: 'node-inline',
    pattern: /\bnode\s+(-e|--eval)\b/i,
    reasonKey: 'errors.denylist.nodeInline'
  },

  // curl dangerous operations — bypass allowlist
  {
    name: 'curl-write-file',
    pattern: /\bcurl\b.*\s(-o\s+|-O\b|--output[\s=])/i,
    reasonKey: 'errors.denylist.curlWriteFile'
  },
  {
    name: 'curl-upload',
    pattern: /\bcurl\b.*\s(-T\s+|--upload-file[\s=])/i,
    reasonKey: 'errors.denylist.curlUpload'
  },
  {
    name: 'curl-exfil',
    pattern: /\bcurl\b.*(-d\s+@|--data[^\s]*\s+@|-F\s+[^\s]*@)/i,
    reasonKey: 'errors.denylist.curlExfil'
  },
  {
    name: 'redirect-write',
    // Match `>` or `>>` that represent **stdout** redirect (write to file).
    //
    // Negative lookbehind `(?<![2&>])` excludes only:
    //   - `2>` / `2>>` (stderr redirect, fd 2)   — legitimate, e.g. `cmd 2>/dev/null`
    //   - `&>` / `&>>`  (combined stdout+stderr)  — legitimate, e.g. `cmd &>/dev/null`
    //   - `>>` second `>` (already matched by the first `>` via `>+`)
    //
    // NOTE: `1>file` (explicit fd 1 = stdout) IS blocked intentionally — it is
    // semantically equivalent to `>file` and must not be treated as an exemption.
    // Earlier version mistakenly used `[0-9]` which excluded `1>` alongside `2>`.
    //
    // `>+` matches one or two consecutive `>` as a unit (handles `>>` append).
    // `\s*[^\s>|&]` ensures the redirect target starts with a real non-operator char.
    pattern: /(?<![2&>])>+\s*[^\s>|&]/,
    reasonKey: 'errors.denylist.redirectWrite'
  },

  // ── export injection: dangerous environment variable manipulation ────
  // Agent 可在 shell 内通过 export 设置危险环境变量，影响所有后续子进程。
  // sanitizeEnv 仅在 PTY spawn 时清洗，无法防御 shell 内的 export。
  {
    name: 'export-env-injection',
    pattern: /\bexport\s+(LD_PRELOAD|DYLD_INSERT_LIBRARIES|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|LD_AUDIT|LD_DEBUG|LD_PROFILE|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|GLOBIGNORE|PROMPT_COMMAND)\b/i,
    reasonKey: 'errors.denylist.exportEnvInjection'
  },
  {
    name: 'export-path-hijack',
    pattern: /\bexport\s+PATH\s*=\s*["']?\/(?:tmp|var\/tmp|dev\/shm)\b/i,
    reasonKey: 'errors.denylist.exportPathHijack'
  },
];

/**
 * Standard denylist — terminal-only 宽泛预检规则（整类命令拦截 + 审批放宽语义）。
 * hardline absolute_command_denylist 的精确灾难模式见 HARDLINE_COMMAND_DENYLIST（codegen）。
 */
export const DEFAULT_DENYLIST: DenyRule[] = [
  {
    name: 'rm',
    pattern: /\brm\b/i,
    reasonKey: 'errors.denylist.rm'
  },
  {
    name: 'mv',
    pattern: /\bmv\b/i,
    reasonKey: 'errors.denylist.mv'
  },
  {
    name: 'chmod',
    pattern: /\bchmod\b/i,
    reasonKey: 'errors.denylist.chmod'
  },
  {
    name: 'chown',
    pattern: /\bchown\b/i,
    reasonKey: 'errors.denylist.chown'
  },
  {
    name: 'sudo',
    pattern: /\bsudo\b/i,
    reasonKey: 'errors.denylist.sudo'
  },
  {
    name: 'git-destructive',
    pattern: /\bgit\s+(push|commit|reset|checkout|clean|rebase|merge|tag|branch|stash)\b/i,
    reasonKey: 'errors.denylist.gitDestructive'
  },
  {
    name: 'npm-install',
    pattern: /\bnpm\s+(install|add|update|upgrade|publish|link)\b/i,
    reasonKey: 'errors.denylist.npmInstall'
  },
  {
    name: 'pnpm-install',
    pattern: /\bpnpm\s+(install|add|update|upgrade|publish|link)\b/i,
    reasonKey: 'errors.denylist.pnpmInstall'
  },
  {
    name: 'yarn-install',
    pattern: /\byarn\s+(install|add|upgrade|upgrade-interactive|publish|link)\b/i,
    reasonKey: 'errors.denylist.yarnInstall'
  },

  // --- Phase 0: shell 元编程、提权 ---
  // Note: pipe-to-shell 在 CRITICAL_DENYLIST；curl|sh 由 HARDLINE_COMMAND_DENYLIST codegen

  {
    name: 'eval',
    pattern: /\beval\b/i,
    reasonKey: 'errors.denylist.eval'
  },
  {
    name: 'source',
    pattern: /^\s*(source|\.)(\s|$)/i,
    reasonKey: 'errors.denylist.source'
  },
  {
    name: 'su',
    pattern: /\bsu\b/i,
    reasonKey: 'errors.denylist.su'
  },
  {
    name: 'dd',
    pattern: /\bdd\b/i,
    reasonKey: 'errors.denylist.dd'
  },
  {
    name: 'mkfs',
    pattern: /\bmkfs\b/i,
    reasonKey: 'errors.denylist.mkfs'
  },
  {
    name: 'reboot-shutdown',
    pattern: /\b(reboot|shutdown|poweroff|halt|init\s+[06])\b/i,
    reasonKey: 'errors.denylist.rebootShutdown'
  },
  {
    name: 'crontab-write',
    pattern: /\bcrontab\s+(-e|-r)\b/i,
    reasonKey: 'errors.denylist.crontabWrite'
  },
  {
    name: 'systemctl-destructive',
    pattern: /\bsystemctl\s+(stop|disable|mask|restart)\b/i,
    reasonKey: 'errors.denylist.systemctlDestructive'
  },
  {
    name: 'iptables',
    pattern: /\b(iptables|nftables|ufw)\b/i,
    reasonKey: 'errors.denylist.iptables'
  },
  {
    name: 'docker-destructive',
    pattern: /\bdocker\s+(rm|rmi|system\s+prune|container\s+rm)\b/i,
    reasonKey: 'errors.denylist.dockerDestructive'
  },
  {
    name: 'kubectl-destructive',
    pattern: /\bkubectl\s+(delete|drain|cordon)\b/i,
    reasonKey: 'errors.denylist.kubectlDestructive'
  },

  // --- python/node dangerous patterns ---
  {
    name: 'python-server',
    pattern: /\bpython3?\s+-m\s+(http\.server|SimpleHTTPServer|smtpd)\b/i,
    reasonKey: 'errors.denylist.pythonServer'
  },

  // --- interactive / multiplexer shells (not in allowlist; default deny) ---
  {
    name: 'shell-invocation',
    pattern: new RegExp(String.raw`^\s*` + SHELL_ANY_ALL + String.raw`\b`, 'i'),
    reasonKey: 'errors.denylist.shellInvocation'
  },
  {
    name: 'terminal-multiplexer',
    pattern: /^\s*(screen|tmux)\b/i,
    reasonKey: 'errors.denylist.terminalMultiplexer'
  },

  // --- scripting runtimes (arbitrary code execution) ---
  {
    name: 'perl-exec',
    pattern: /^\s*perl\b/i,
    reasonKey: 'errors.denylist.perlExec'
  },
  {
    name: 'ruby-exec',
    pattern: /^\s*ruby\b/i,
    reasonKey: 'errors.denylist.rubyExec'
  },
  {
    name: 'php-exec',
    pattern: /^\s*php\b/i,
    reasonKey: 'errors.denylist.phpExec'
  },

  // --- network tools (reverse shell / exfiltration) ---
  {
    name: 'nc-netcat',
    pattern: /^\s*(nc|ncat|netcat)\b/i,
    reasonKey: 'errors.denylist.ncNetcat'
  },

  // --- file-rewriting utilities ---
  {
    name: 'tee-write',
    pattern: /\btee\b/i,
    reasonKey: 'errors.denylist.teeWrite'
  },
  {
    name: 'sed-inplace',
    pattern: /\bsed\b.*\s-[a-zA-Z]*i/i,
    reasonKey: 'errors.denylist.sedInplace'
  },

  // --- command amplifiers (exec arbitrary commands) ---
  {
    name: 'find-exec',
    pattern: /\bfind\b.*-exec\b/i,
    reasonKey: 'errors.denylist.findExec'
  },
  {
    name: 'xargs-exec',
    pattern: /\bxargs\b/i,
    reasonKey: 'errors.denylist.xargsExec'
  },

  // --- network file transfer ---
  {
    name: 'scp',
    pattern: /\bscp\b/i,
    reasonKey: 'errors.denylist.scp'
  },
  {
    name: 'rsync',
    pattern: /\brsync\b/i,
    reasonKey: 'errors.denylist.rsync'
  },

  // --- system privilege escalation / namespace manipulation ---
  {
    name: 'mount-umount',
    pattern: /\b(mount|umount)\b/i,
    reasonKey: 'errors.denylist.mountUmount'
  },
  {
    name: 'chroot',
    pattern: /\bchroot\b/i,
    reasonKey: 'errors.denylist.chroot'
  },
  {
    name: 'namespace-escape',
    pattern: /\b(nsenter|unshare)\b/i,
    reasonKey: 'errors.denylist.namespaceEscape'
  },

  // --- debuggers (can attach to processes, bypass security) ---
  {
    name: 'debugger',
    pattern: /\b(strace|ltrace|gdb|lldb)\b/i,
    reasonKey: 'errors.denylist.debugger'
  },

  // --- package installers (may download/execute malicious packages) ---
  {
    name: 'pip-install',
    pattern: /\bpip3?\s+install\b/i,
    reasonKey: 'errors.denylist.pipInstall'
  },
  {
    name: 'cargo-install',
    pattern: /\bcargo\s+install\b/i,
    reasonKey: 'errors.denylist.cargoInstall'
  },
  {
    name: 'go-install',
    pattern: /\bgo\s+install\b/i,
    reasonKey: 'errors.denylist.goInstall'
  },

  // --- process control ---
  {
    name: 'kill',
    pattern: /\b(kill|killall|pkill)\b/i,
    reasonKey: 'errors.denylist.kill'
  },

  // --- remote connection / network reconnaissance ---
  {
    name: 'ssh',
    pattern: /^\s*ssh\b/i,
    reasonKey: 'errors.denylist.ssh'
  },
  {
    name: 'telnet',
    pattern: /\btelnet\b/i,
    reasonKey: 'errors.denylist.telnet'
  },
  {
    name: 'socat',
    pattern: /\bsocat\b/i,
    reasonKey: 'errors.denylist.socat'
  },
  {
    name: 'nmap',
    pattern: /\bnmap\b/i,
    reasonKey: 'errors.denylist.nmap'
  },

  // --- network data transfer tools (require approval via relaxedRules) ---
  {
    name: 'curl-basic',
    pattern: /\bcurl\b/i,
    reasonKey: 'errors.denylist.curlBasic'
  },
  {
    name: 'wget-basic',
    pattern: /\bwget\b/i,
    reasonKey: 'errors.denylist.wgetBasic'
  },
  {
    name: 'ftp-sftp',
    pattern: /\b(ftp|sftp)\b/i,
    reasonKey: 'errors.denylist.ftpSftp'
  },

  // --- scheduled task injection ---
  {
    name: 'at-batch',
    pattern: /^\s*(at|batch)\b/i,
    reasonKey: 'errors.denylist.atBatch'
  },

  // --- curl/wget write operations ---
  // 注意：curl-basic / wget-basic 已覆盖所有 curl/wget 命令，
  // 以下规则在当前顺序下不会被匹配到，保留是为了向后兼容
  // （relaxedRules 中的 'curl-mutating' / 'wget-write' 名称仍可引用）。
  // 当服务端通过 relaxedRules 放宽 curl-basic 后，mutating 操作
  // 仍会被 CRITICAL_DENYLIST 中的 curl-exfil / curl-write-file 等拦截。
  {
    name: 'curl-mutating',
    pattern: /\bcurl\b.*\s(-d\s|--data[\s=]|-X\s+(POST|PUT|PATCH|DELETE)\b|-F\s)/i,
    reasonKey: 'errors.denylist.curlMutating'
  },
  {
    name: 'wget-write',
    pattern: /\bwget\b.*\s(--post-data[\s=]|--post-file[\s=]|--method[\s=])/i,
    reasonKey: 'errors.denylist.wgetWrite'
  },
];
