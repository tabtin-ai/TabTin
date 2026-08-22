/**
 * 内置 LSP server 配置 + LspServerConfigLoader 实现。
 *
 * 设计要点（TabTin 自有实现）：
 *   - typescript：必须找到 tsserver.js（项目自带 > bundled），找不到则不启用
 *   - pyright：自动检测 venv 传 pythonPath
 *   - 系统 PATH 优先（高级用户自装的版本）
 *   - 所有解析失败时不抛错——返回 partial config（manager 启动该 server 时
 *     会自然失败到 error 状态，由 agent-runtime 的 spawn linter fallback 兜底）
 *
 *   TabTin 走静态注册（builtin-servers）。设计哲学：先把基础 2 个语言（TS/PY）
 *   做扎实，后续语言按需扩展。
 *   借鉴：Typescript 的 tsserver.js 必需性检查 / Pyright 的 venv 检测
 */

import {
  resolveTypescriptLanguageServer,
  resolveTsserver,
  resolvePyrightLangserver,
  detectPythonInterpreter,
} from './bundled-paths.js';
import { logForDebugging } from '../util/log.js';
import type { LspServerConfigLoader } from '../manager/LSPServerManager.js';
import type { ScopedLspServerConfig } from '../manager/types.js';

/**
 * Builtin LSP server 配置选项。
 */
export interface BuiltinServersOptions {
  /** 项目根目录（用来 resolve `node_modules/typescript` 和 venv） */
  projectRoot: string;
  /**
   * 启用哪些 server。缺省全启用。可关闭某个 server 用于测试或部分场景。
   */
  enabled?: {
    typescript?: boolean;
    pyright?: boolean;
  };
}

/**
 * 创建 typescript-language-server 配置。
 *
 * 返回 undefined 表示该 server 无法启用（tsserver 找不到或 binary 找不到）。
 */
function buildTypescriptConfig(
  projectRoot: string,
): ScopedLspServerConfig | undefined {
  const bin = resolveTypescriptLanguageServer();
  if (!bin) {
    logForDebugging(
      '[builtin-servers] typescript-language-server binary not found (no system PATH, no bundled). Skipping.',
    );
    return undefined;
  }

  const tsserverPath = resolveTsserver(projectRoot);
  if (!tsserverPath) {
    logForDebugging(
      '[builtin-servers] tsserver.js not found (no project node_modules/typescript, no bundled). Skipping.',
    );
    return undefined;
  }

  logForDebugging(
    `[builtin-servers] typescript: bin=${bin.command} args=${bin.args.join(' ')} tsserver=${tsserverPath}`,
  );

  return {
    command: bin.command,
    args: bin.args,
    extensionToLanguage: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.mts': 'typescript',
      '.cts': 'typescript',
    },
    initializationOptions: {
      tsserver: { path: tsserverPath },
    },
  };
}

/**
 * 创建 pyright 配置。
 *
 * pyright 不需要项目装等价物（自带 typeshed）。但需要检测 venv 传 pythonPath。
 */
function buildPyrightConfig(
  projectRoot: string,
): ScopedLspServerConfig | undefined {
  const bin = resolvePyrightLangserver();
  if (!bin) {
    logForDebugging(
      '[builtin-servers] pyright-langserver binary not found (no system PATH, no bundled). Skipping.',
    );
    return undefined;
  }

  const initializationOptions: Record<string, unknown> = {};
  const pythonPath = detectPythonInterpreter(projectRoot);
  if (pythonPath) {
    initializationOptions.pythonPath = pythonPath;
    logForDebugging(
      `[builtin-servers] pyright: detected pythonPath=${pythonPath}`,
    );
  } else {
    logForDebugging(
      `[builtin-servers] pyright: no venv detected; using system python`,
    );
  }

  logForDebugging(
    `[builtin-servers] pyright: bin=${bin.command} args=${bin.args.join(' ')}`,
  );

  return {
    command: bin.command,
    args: bin.args,
    extensionToLanguage: {
      '.py': 'python',
      '.pyi': 'python',
    },
    initializationOptions,
  };
}

/**
 * 创建内置 LSP server config loader。
 *
 * @param options.projectRoot 项目根目录
 * @param options.enabled 启用哪些 server（缺省全启用）
 * @returns LspServerConfigLoader 实例 —— 传给 `initializeLspServerManager()`
 */
export function createBuiltinServersLoader(
  options: BuiltinServersOptions,
): LspServerConfigLoader {
  const { projectRoot, enabled = {} } = options;

  return {
    async load() {
      const servers: Record<string, ScopedLspServerConfig> = {};

      if (enabled.typescript !== false) {
        const ts = buildTypescriptConfig(projectRoot);
        if (ts) servers.typescript = ts;
      }

      if (enabled.pyright !== false) {
        const py = buildPyrightConfig(projectRoot);
        if (py) servers.pyright = py;
      }

      logForDebugging(
        `[builtin-servers] Loaded ${Object.keys(servers).length} server(s): ${Object.keys(servers).join(', ')}`,
      );

      return { servers };
    },
  };
}
