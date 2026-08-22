/**
 * 极简 logger 接口。
 *
 * 设计哲学：lsp-runtime 是底层基础设施包，不绑定具体 logger 实现（避免
 * 引入 pino / winston / @tabtin/shared 等）。宿主通过 `setLogger()` 注入
 * 真实 logger；未注入时缺省走 console.debug / console.error。
 *
 * `logForDebugging` / `logError` 是对底层 logger 的薄封装。
 * 完整实现常带 HARD_FAIL 等高级特性，这里只暴露最小 API，让
 * 宿主端（agent-runtime / Electron main）自由对接。
 */

export interface LspLogger {
  /** 调试日志，缺省静默——只有用户开了 debug 环境变量才打印。 */
  debug(message: string): void;
  /** 错误日志，缺省走 stderr。 */
  error(message: string, error?: Error): void;
}

const DEFAULT_LOGGER: LspLogger = {
  debug(message) {
    if (process.env.TABTIN_LSP_DEBUG) {
      // 缺省 debug 不打印——除非显式打开 TABTIN_LSP_DEBUG=1
      // eslint-disable-next-line no-console
      console.debug(`[lsp-runtime] ${message}`);
    }
  },
  error(message, error) {
    // eslint-disable-next-line no-console
    console.error(`[lsp-runtime] ${message}`, error ?? '');
  },
};

let activeLogger: LspLogger = DEFAULT_LOGGER;

/**
 * 替换全局 logger。宿主（agent-runtime / Electron main）启动时调用，
 * 把 pino / Electron log 等接进来。
 */
export function setLogger(logger: LspLogger): void {
  activeLogger = logger;
}

export function logForDebugging(message: string): void {
  activeLogger.debug(message);
}

export function logError(message: string, error?: Error): void {
  activeLogger.error(message, error);
}
