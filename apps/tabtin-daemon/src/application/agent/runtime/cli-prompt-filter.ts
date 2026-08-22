/**
 * ：只收窄 Daemon 提示词中的 CLI 参考，绝不拦截实际 CLI 执行。
 *  的统一 Resolver 上线后删除这一发布线兼容层。
 */
/** memo / demo-app 与 Electron `<apps>` / marketplace 止血对齐。 */
const TEMPORARILY_HIDDEN_CLI_DOMAINS = new Set([
  'site',
  'phone',
  'video',
  'memo',
  'tabtin-demo-app',
]);

export function isTemporarilyHiddenCliPromptCommand(commandPath: string): boolean {
  const parts = commandPath.trim().replace(/^tabtin\s+/, '').split(/\s+/);
  const [domain, subcommand] = parts;
  return TEMPORARILY_HIDDEN_CLI_DOMAINS.has(domain)
    || (domain === 'media' && subcommand === 'video');
}

/**
 * Django 转发的 `cli_reference` 是面向模型的文本清单，每行至多描述一个命令。
 * 仅丢弃指向临时禁用域的行，保留 `media` / `media image` 等仍可用能力。
 */
export function filterTemporarilyHiddenCliPromptReference(
  cliReference: string | undefined,
): string | undefined {
  if (!cliReference?.trim()) return undefined;
  const visibleLines = cliReference
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/\btabtin\s+([^\s`]+(?:\s+[^\s`]+)?)/);
      return !match || !isTemporarilyHiddenCliPromptCommand(match[1]);
    })
    .join('\n')
    .trim();
  return visibleLines || undefined;
}
