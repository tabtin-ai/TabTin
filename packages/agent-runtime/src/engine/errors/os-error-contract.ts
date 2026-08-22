/**
 * OS 访问错误本地契约（ Stage 7a）。
 *
 * 生产路径不再 import `@tabtin/os-errors`。错误对象仍由宿主侧
 * `@tabtin/safe-fs` 抛出（含 `osError` 字段）；runtime 只做 duck-type
 * 识别与 Agent 文案渲染，字段形状须与 os-errors 对齐。
 */

export interface OSErrorRecoveryAction {
  type?: string;
  label: string;
  deepLink?: string;
}

/** ShellCap / orchestration 消费的 OSError 字段子集。 */
export interface OSError {
  code: string;
  category: string;
  platform: NodeJS.Platform;
  path: string;
  rawDetail?: string;
  terminal: boolean;
  userGuidance: string;
  agentDirectives: string[];
  recoveryActions: OSErrorRecoveryAction[];
}

/** Duck-type：识别带 `osError` plain object 的错误（对齐 os-errors#isOSError）。 */
export function isOSError(err: unknown): err is { osError: OSError } {
  if (typeof err !== 'object' || err === null) return false;
  if (!('osError' in err)) return false;
  const inner = (err as { osError: unknown }).osError;
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}

/** 把 OSError 渲染成给 Agent 看的单段自然语言（算法对齐 os-errors#renderForAgent）。 */
export function renderForAgent(err: OSError): string {
  const lines: string[] = [];
  lines.push(
    `[OS_ACCESS_ERROR] code=${err.code} category=${err.category} platform=${err.platform} path=${err.path}`,
  );
  lines.push('');
  lines.push(err.userGuidance);

  if (err.agentDirectives.length > 0) {
    lines.push('');
    lines.push('约束：');
    for (const d of err.agentDirectives) lines.push(`- ${d}`);
  }

  const linkActions = err.recoveryActions.filter((a) => !!a.deepLink);
  if (linkActions.length > 0) {
    lines.push('');
    lines.push('可建议的快捷链接：');
    for (const a of linkActions) lines.push(`- ${a.label}: ${a.deepLink}`);
  }

  return lines.join('\n');
}
