/**
 * CommandValidationError —— `CommandValidator` 拒绝命令时的结构化异常。
 *
 * **该类的核心收益**：错误信号沿四层调用栈（`commandExecutor` →
 * `BackendSession.exec` → `ShellCap.execute` → `ToolResult`）透传时，
 * 中间层一旦做 `new Error(\`wrap: \${err.message}\`)` ad-hoc duck-typed
 * 字段（`(err as any).ruleName`）就会丢失。独立 Error 类配合
 * `isCommandValidationError` 双判定（instanceof + name+kind）让识别
 * 在跨包 / 跨 vm context（vitest worker 多 ESM 实例）也稳定。
 *
 * **职责切分**：
 *   - 类只携带 `ruleName / reason`——validator 自身能产出的事实
 *   - i18n 走 `reason`（来自 `commandValidator.t()`）
 *   - `hint`（"给 LLM 的下一步指引"）由 capability 层按 ruleName 在
 *     `DENY_RULE_HINTS` 表里查表注入。terminal-core 不依赖 agent-runtime
 *     工具列表，方向解耦。
 */
export class CommandValidationError extends Error {
  /**
   * 与 `CommandValidationResult.ruleName` 同义 —— 触发拒绝的具体规则名。
   * 取值集合：`CRITICAL_DENYLIST` / `DEFAULT_DENYLIST` 中的 `name` 字段，
   * 加上 `commandValidator.ts` 内部生成的 4 条 pseudo rule：
   * `env-var-expansion` / `command-substitution` / `sensitive-path` / `empty`。
   */
  readonly ruleName?: string;

  /**
   * 类型 narrow 用 —— consumer 可以 `err.kind === 'validation'` 区分
   * "验证拒绝"和"IPC 失败 / Backend 死掉" 等其它异常。`instanceof`
   * 在跨包 / 跨 vm context 时偶尔失效，这条字段是兜底。
   */
  readonly kind = 'validation' as const;

  constructor(message: string, ruleName?: string) {
    super(message);
    this.name = 'CommandValidationError';
    this.ruleName = ruleName;
  }
}

/**
 * 跨实例 / 跨包 / 跨 vm context 的稳健类型守卫——`instanceof` 在跨 module
 * 边界（如 vitest 多 worker、esbuild 双拷贝）偶发失效，用 `name` + `kind`
 * 双判定兜底。
 */
export function isCommandValidationError(err: unknown): err is CommandValidationError {
  if (err instanceof CommandValidationError) return true;
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; kind?: unknown };
    if (e.name === 'CommandValidationError' && e.kind === 'validation') return true;
  }
  return false;
}
