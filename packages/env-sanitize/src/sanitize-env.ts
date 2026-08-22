/**
 * Environment variables that enable shared-library / code injection.
 * An attacker who controls these can force any child process to load
 * arbitrary native code, completely bypassing sandbox boundaries.
 *
 * Categories:
 * - Linux dynamic linker: LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, LD_PROFILE
 * - macOS dyld: DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH, DYLD_FRAMEWORK_PATH,
 *   DYLD_FALLBACK_LIBRARY_PATH
 * - Shell startup injection: BASH_ENV, ENV, CDPATH
 * - Language runtime injection: PYTHONSTARTUP, PERL5OPT, RUBYOPT, NODE_OPTIONS
 * - JVM / build tool injection: MAVEN_OPTS, SBT_OPTS, GRADLE_OPTS, ANT_OPTS,
 *   _JAVA_OPTIONS, JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS
 * - glibc tuning: GLIBC_TUNABLES
 * - .NET runtime injection: DOTNET_ADDITIONAL_DEPS, DOTNET_STARTUP_HOOKS
 * - Node.js module path hijack: NODE_PATH
 * - Python module path hijack: PYTHONPATH
 * - Perl module path hijack: PERL5LIB, PERLLIB
 * - macOS dyld file write: DYLD_PRINT_TO_FILE
 *
 * Additionally, DANGEROUS_INJECTION_PREFIXES blocks entire families of variables
 * by prefix (e.g. BASH_FUNC_* for bash exported function injection / ShellShock).
 */
export const DANGEROUS_INJECTION_VARS: ReadonlySet<string> = new Set([
  // Linux dynamic linker injection
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_PROFILE',
  // macOS dyld injection
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  // macOS dyld 输出文件注入 — 可写入任意文件
  'DYLD_PRINT_TO_FILE',
  // Shell startup injection
  'BASH_ENV',
  'ENV',
  'CDPATH',
  // Language runtime injection
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
  'NODE_OPTIONS',
  // JVM / 构建工具注入 — 可通过 -javaagent/-agentlib 加载任意 native 代码
  'MAVEN_OPTS',
  'SBT_OPTS',
  'GRADLE_OPTS',
  'ANT_OPTS',
  '_JAVA_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  // glibc 调优 — 可触发内存损坏 (CVE-2023-4911)
  'GLIBC_TUNABLES',
  // .NET 运行时注入 — 可加载任意 .NET 程序集
  'DOTNET_ADDITIONAL_DEPS',
  'DOTNET_STARTUP_HOOKS',
  // Node.js 模块路径劫持 — 可替换核心模块
  'NODE_PATH',
  // Python 模块路径劫持 — 与 NODE_PATH 同级风险
  'PYTHONPATH',
  // Perl 模块路径劫持
  'PERL5LIB',
  'PERLLIB',
])

/**
 * Environment variable name prefixes that indicate dangerous injection vectors.
 * Any env var whose name starts with one of these prefixes is blocked.
 *
 * This complements DANGEROUS_INJECTION_VARS (exact match) with family-level
 * blocking for variable namespaces where ALL members are dangerous.
 */
export const DANGEROUS_INJECTION_PREFIXES: readonly string[] = [
  // bash exported function injection (ShellShock family, CVE-2014-6271)
  // bash exports functions via env vars named BASH_FUNC_<name>%%
  'BASH_FUNC_',
]

/**
 * Environment variable names that must never leak into child processes.
 * These contain authentication credentials that would allow child processes
 * to impersonate the daemon or access protected APIs.
 */
export const SENSITIVE_ENV_VARS: ReadonlySet<string> = new Set([
  // TabTin internal
  'TABTIN_TOKEN',
  'TABTIN_JWT',
  'TABTIN_SOCK', // SD-039 Phase 1: socket 路径不应泄漏到子进程
  // Cloud provider keys
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GCP_SERVICE_ACCOUNT_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // AI provider keys
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'COHERE_API_KEY',
  'HUGGINGFACE_TOKEN',
  'REPLICATE_API_TOKEN',
  // Database credentials
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'PGPASSWORD',
  'MYSQL_PWD',
  'REDIS_PASSWORD',
  'MONGO_PASSWORD',
  'MONGODB_URI',
  // Common secrets
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
  'DOCKER_AUTH_CONFIG',
  'SLACK_TOKEN',
  'SLACK_WEBHOOK_URL',
  'STRIPE_SECRET_KEY',
  'TWILIO_AUTH_TOKEN',
  'SENDGRID_API_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'PRIVATE_KEY',
  'SSH_PRIVATE_KEY',
])

/**
 * Patterns that indicate a sensitive environment variable by name.
 * Any env var whose name contains one of these substrings (case-insensitive)
 * will be filtered out.
 */
export const SENSITIVE_PATTERNS: readonly string[] = [
  '_SECRET',
  '_KEY',
  '_TOKEN',
  '_PASSWORD',
  '_CREDENTIAL',
  '_CREDENTIALS',
  '_PRIVATE',
  'SECRET_',
  'PASSWORD_',
  'API_KEY',
  'APIKEY',
  'AUTH_TOKEN',
]

/**
 * System environment variables that must be preserved even if they match
 * a sensitive pattern. These are essential for shell and process operation.
 */
export const SAFE_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_SESSION_TYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'COLUMNS',
  'LINES',
  'ZDOTDIR',
  'HISTFILE',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_AGENT_INFO',
  'DBUS_SESSION_BUS_ADDRESS',
  'ComSpec',
  'SystemRoot',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
  'windir',
])

/**
 * Returns true if the given env var name looks sensitive based on pattern matching.
 */
export function isSensitiveByPattern(name: string): boolean {
  const upper = name.toUpperCase()
  return SENSITIVE_PATTERNS.some((pattern) => upper.includes(pattern))
}

export interface SanitizeEnvOptions {
  /**
   * Explicit env var names to preserve even when they match sensitive blocklists.
   *
   * **Only** for host-managed Skill credential injection keys — never pass user /
   * LLM-supplied env names here. Injection vars (LD_PRELOAD, NODE_OPTIONS, …)
   * are still blocked even when listed.
   */
  preserveKeys?: ReadonlySet<string> | readonly string[]
}

/**
 * Sanitizes an environment object, filtering out dangerous injection variables,
 * sensitive credential variables, and pattern-matched sensitive names.
 *
 * Filtering strategy (applied in order):
 * 0. Injection blocklist: shared-library and runtime injection variables
 *    (LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS, etc.) are always removed.
 * 1. Exact-match blocklist: known sensitive variable names are always removed.
 * 2. Pattern-based filtering: variables whose names contain keywords like
 *    SECRET, KEY, TOKEN, PASSWORD, CREDENTIAL are removed.
 * 3. Safe allowlist: essential system variables (PATH, HOME, SHELL, TERM, etc.)
 *    are always preserved, even if they match a sensitive pattern.
 * 4. Optional preserveKeys: Skill resolver–injected credential env only.
 */
export function sanitizeEnv(
  env: Record<string, string | undefined>,
  options?: SanitizeEnvOptions,
): Record<string, string> {
  const preserveKeys = options?.preserveKeys
    ? new Set(
        options.preserveKeys instanceof Set
          ? [...options.preserveKeys]
          : options.preserveKeys,
      )
    : null
  const result: Record<string, string> = {}
  const filteredInjectionVars: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue

    // Always block shared-library / code injection vars (P0 security)
    if (DANGEROUS_INJECTION_VARS.has(key)) {
      filteredInjectionVars.push(key)
      continue
    }

    // Block dangerous variable families by prefix (e.g. BASH_FUNC_*)
    if (DANGEROUS_INJECTION_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      filteredInjectionVars.push(key)
      continue
    }

    // Skill credential injection bypass — injection vars above still win.
    if (preserveKeys?.has(key)) {
      result[key] = value
      continue
    }

    // Always block exact-match sensitive vars
    if (SENSITIVE_ENV_VARS.has(key)) continue

    // Allow system-essential vars even if they match a pattern
    if (SAFE_ALLOWLIST.has(key)) {
      result[key] = value
      continue
    }

    // Block vars matching sensitive name patterns
    if (isSensitiveByPattern(key)) continue

    result[key] = value
  }

  if (filteredInjectionVars.length > 0) {
    console.warn(
      `[tabtin:security] sanitizeEnv: 以下环境变量因安全策略被过滤: ${filteredInjectionVars.join(', ')}`,
    )
  }

  // Electron 主进程可能没有 TERM 环境变量，
  // 导致 vim/less/tput 等子进程中显示异常。提供安全的默认值。
  result.TERM ??= 'xterm-256color'

  return result
}

/**
 * 沙箱二次消毒：敏感环境变量匹配模式。
 * 沙箱进程不应继承这些键，防止通过 /proc/self/environ 泄露凭据。
 */
export const SENSITIVE_SANDBOX_PATTERNS: readonly RegExp[] = [
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GOOGLE_CLOUD_/i,
  /^GOOGLE_APPLICATION_/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^API_KEY$/i,
  /^APIKEY$/i,
  /_API_KEY$/i,
  /^DATABASE_URL$/i,
  /^REDIS_URL$/i,
  /^MONGO_URL$/i,
  /^MONGODB_URI$/i,
  /^SSH_AUTH_SOCK$/i,
  /^SSH_AGENT_PID$/i,
  /^GPG_AGENT_INFO$/i,
  /^GITHUB_TOKEN$/i,
  /^GITLAB_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^PYPI_TOKEN$/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^COHERE_API_KEY$/i,
  /^STRIPE_/i,
  /^TWILIO_/i,
  /^SENDGRID_/i,
  /^PRIVATE_KEY/i,
]

export function isSensitiveSandboxKey(key: string): boolean {
  return SENSITIVE_SANDBOX_PATTERNS.some(p => p.test(key))
}

/**
 * 沙箱环境变量二次消毒。
 * 在第一层 sanitizeEnv 之后，沙箱路径对 env 做额外的正则过滤，
 * 作为纵深防御，防止凭据通过 /proc/self/environ 泄露。
 */
export function sanitizeSandboxEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {}
  let removedCount = 0
  for (const [k, v] of Object.entries(env)) {
    if (!isSensitiveSandboxKey(k)) {
      clean[k] = v
    } else {
      removedCount++
    }
  }

  if (removedCount > 0) {
    console.warn(
      `[tabtin:security] sanitizeSandboxEnv: 沙箱二次过滤移除了 ${removedCount} 个敏感环境变量`,
    )
  }

  return clean
}
