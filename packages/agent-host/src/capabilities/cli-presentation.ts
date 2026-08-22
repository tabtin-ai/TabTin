/**
 * TabTin CLI → 工具展示语义。
 *
 * 这里是 CLI-first 能力与客户端专属呈现之间的宿主适配层：
 * - shell core 只负责执行，不认识媒体/文档等业务；
 * - Renderer 只消费稳定的 presentation.kind，不解析命令文本；
 * - 本层用 shell tokenizer 得到 argv，再按声明式 command path 精确匹配。
 */

import type { ToolPresentation } from '@tabtin/agent-runtime/engine';
import { tokenizeShellCommand } from '@tabtin/agent-runtime/capability';

type CliPresentationDefinition = {
  commandPath: readonly string[];
  kind: string;
  requiredValueFlags?: readonly string[];
};

const CLI_PRESENTATIONS: readonly CliPresentationDefinition[] = [
  {
    commandPath: ['media', 'image', 'generate'],
    kind: 'media_image_generation',
    requiredValueFlags: ['prompt'],
  },
];

const SHELL_OPERATORS = new Set(['|', '||', ';', '>', '>>', '<', '<<', '&']);
const HELP_FLAGS = new Set(['--help', '-h']);
const PROMPT_PREVIEW_MAX = 80;

type ParsedCliInvocation = {
  command: string;
  path: string[];
  flags: Map<string, string | true>;
};

function executableName(token: string): string {
  const normalized = token.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function isEnvAssignment(token: string): boolean {
  const equals = token.indexOf('=');
  if (equals <= 0) return false;
  const name = token.slice(0, equals);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function parseFlags(tokens: readonly string[], start: number): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) continue;
    const equals = token.indexOf('=');
    if (equals > 0) {
      flags.set(token.slice(0, equals).replace(/^-+/, ''), token.slice(equals + 1));
      continue;
    }
    const name = token.replace(/^-+/, '');
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

function parseTabtinInvocation(command: string): ParsedCliInvocation | undefined {
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length === 0 || tokens.some((token) => SHELL_OPERATORS.has(token))) {
    return undefined;
  }

  let index = 0;
  if (tokens[0] === 'cd') {
    if (tokens.length < 4 || tokens[2] !== '&&') return undefined;
    index = 3;
  } else if (tokens.includes('&&')) {
    return undefined;
  }
  if (tokens.slice(index).includes('&&')) return undefined;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index++;

  const executable = executableName(tokens[index] ?? '');
  if (executable !== 'tabtin' && executable !== 'tabtin.exe') return undefined;
  index++;

  const path: string[] = [];
  while (index < tokens.length && !tokens[index].startsWith('-')) {
    path.push(tokens[index]);
    index++;
    if (path.length === 3) break;
  }
  if (tokens[index] !== undefined && !tokens[index].startsWith('-')) return undefined;

  return {
    command,
    path,
    flags: parseFlags(tokens, index),
  };
}

function samePath(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((token, index) => token === expected[index]);
}

function matchesDefinition(
  invocation: ParsedCliInvocation,
  definition: CliPresentationDefinition,
): boolean {
  if (!samePath(invocation.path, definition.commandPath)) return false;
  if ([...HELP_FLAGS].some((flag) => invocation.flags.has(flag.replace(/^-+/, '')))) {
    return false;
  }
  return (definition.requiredValueFlags ?? []).every((flag) => {
    const value = invocation.flags.get(flag);
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * `run_terminal_command` 的宿主展示语义 resolver。
 *
 * 返回 undefined 表示普通终端调用；任何未知命令默认不认领专属 UI。
 */
export function resolveCliToolPresentation(input: unknown): ToolPresentation | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string' || !command.trim()) return undefined;

  const invocation = parseTabtinInvocation(command);
  if (!invocation) return undefined;
  const definition = CLI_PRESENTATIONS.find((candidate) =>
    matchesDefinition(invocation, candidate));
  if (!definition) return undefined;

  const prompt = invocation.flags.get('prompt');
  const promptPreview = typeof prompt === 'string' && prompt.length > PROMPT_PREVIEW_MAX
    ? `${prompt.slice(0, PROMPT_PREVIEW_MAX)}…`
    : prompt;
  return {
    kind: definition.kind,
    data: {
      command: invocation.command,
      ...(typeof promptPreview === 'string' ? { prompt: promptPreview } : {}),
    },
  };
}
