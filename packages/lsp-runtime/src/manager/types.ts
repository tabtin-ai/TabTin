/**
 * LSP server runtime types。
 *
 *   定义；本类型定义是 TabTin 根据 LSPServerInstance.ts 和 LSPServerManager.ts
 *   的实际使用场景推导出的最小完整类型。
 */

/**
 * LSP server 状态机。
 *
 * 转换：
 *   - stopped → starting → running
 *   - running → stopping → stopped
 *   - any → error (on failure)
 *   - error → starting (on retry)
 *
 */
export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';

/**
 * 单个 LSP server 的运行时配置。
 *
 * 字段语义取自 LSPServerInstance/Manager 的使用方式。
 */
export interface ScopedLspServerConfig {
  /** spawn 用的命令（如 `node` / `typescript-language-server`） */
  command: string;
  /** spawn 参数（如 `['--stdio']` 或 `['/path/to/server.js', '--stdio']`） */
  args?: string[];
  /** 额外环境变量（覆盖 process.env） */
  env?: Record<string, string>;
  /** 工作目录（缺省为调用方决定，通常 LSPServerManager 不传给 instance）*/
  cwd?: string;
  /** initialize 时传给 LSP server 的 workspaceFolders 根（缺省 process.cwd()） */
  workspaceFolder?: string;
  /** server-specific InitializeParams.initializationOptions */
  initializationOptions?: Record<string, unknown>;
  /** initialize 阶段的超时（ms）；不设则不超时等待 */
  startupTimeout?: number;
  /** 崩溃恢复 / 手动重启的最大次数，缺省 3 */
  maxRestarts?: number;
  /**
   * 扩展名 → languageId 映射（LSP didOpen 协议要求 languageId）。
   * 例：`{ '.ts': 'typescript', '.tsx': 'typescriptreact' }`
   */
  extensionToLanguage: Record<string, string>;
  /**
   * (未实现) 进程崩溃时自动重启。当前 LSPServerInstance 检查到此字段
   * 已设值会抛错，避免 caller 误以为有该功能。
   */
  restartOnCrash?: boolean;
  /**
   * (未实现) shutdown request 的超时（ms）。当前 LSPServerInstance 检查
   * 到此字段已设值会抛错，避免 caller 误以为有该功能。
   */
  shutdownTimeout?: number;
}
