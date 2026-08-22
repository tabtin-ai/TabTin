/**
 * 抓取模块专用日志器
 * 支持命名空间和结构化日志
 */

// 日志级别
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4
}

// 日志条目接口
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  namespace: string;
  message: string;
  data?: any;
  context?: Record<string, any>;
  traceId?: string;
  requestId?: string;
}

// 日志输出器接口
export interface LogOutput {
  write(entry: LogEntry): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

// 控制台输出器
export class ConsoleOutput implements LogOutput {
  private colors = {
    [LogLevel.DEBUG]: '\x1b[36m',  // 青色
    [LogLevel.INFO]: '\x1b[32m',   // 绿色
    [LogLevel.WARN]: '\x1b[33m',   // 黄色
    [LogLevel.ERROR]: '\x1b[31m',  // 红色
    [LogLevel.FATAL]: '\x1b[35m'   // 紫色
  };

  private reset = '\x1b[0m';
  private useColor: boolean;

  constructor(options?: { forceColor?: boolean }) {
    this.useColor = options?.forceColor ??
      (typeof process !== 'undefined' &&
       process.stdout?.isTTY === true &&
       !process.env.NO_COLOR);
  }

  write(entry: LogEntry): void {
    const color = this.useColor ? this.colors[entry.level] : '';
    const reset = this.useColor ? this.reset : '';
    const levelName = LogLevel[entry.level];
    const timestamp = entry.timestamp.toISOString();

    let message = `${color}[${timestamp}] ${levelName} ${entry.namespace}${reset}: ${entry.message}`;

    if (entry.data) {
      message += `\n${JSON.stringify(entry.data, null, 2)}`;
    }

    if (entry.context && Object.keys(entry.context).length > 0) {
      message += `\n  Context: ${JSON.stringify(entry.context)}`;
    }

    if (entry.traceId) {
      message += `\n  TraceId: ${entry.traceId}`;
    }

    console.log(message);
  }
}

// 文件输出器
export class FileOutput implements LogOutput {
  private buffer: LogEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(
    private filePath: string,
    private bufferSize: number = 100,
    private flushIntervalMs: number = 5000
  ) {
    this.startFlushTimer();
  }

  write(entry: LogEntry): void {
    this.buffer.push(entry);

    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const entries = this.buffer.splice(0);
    const lines = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

    try {
      const fs = await import('fs/promises');
      await fs.appendFile(this.filePath, lines, 'utf8');
    } catch (error) {
      console.error('Failed to write log file:', error);
    }
  }

  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    await this.flush();
  }

  private startFlushTimer(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch(console.error);
    }, this.flushIntervalMs);
  }
}

// 抓取日志器配置
export interface CrawlLoggerConfig {
  level: LogLevel;
  outputs: LogOutput[];
  enableTracing: boolean;
  enableContext: boolean;
  maxContextSize: number;
}

// 抓取日志器主类
export class CrawlLogger {
  private static instance: CrawlLogger | null = null;
  private config: CrawlLoggerConfig;
  private contextStack: Record<string, any>[] = [];

  constructor(config: Partial<CrawlLoggerConfig> = {}) {
    this.config = {
      level: LogLevel.INFO,
      outputs: [new ConsoleOutput()],
      enableTracing: true,
      enableContext: true,
      maxContextSize: 1000,
      ...config
    };
  }

  // 单例模式
  static getInstance(config?: Partial<CrawlLoggerConfig>): CrawlLogger {
    if (!CrawlLogger.instance) {
      CrawlLogger.instance = new CrawlLogger(config);
    }
    return CrawlLogger.instance;
  }

  // 创建命名空间日志器
  namespace(name: string): NamespaceLogger {
    return new NamespaceLogger(this, name);
  }

  // 核心日志方法
  log(
    level: LogLevel,
    namespace: string,
    message: string,
    data?: any,
    context?: Record<string, any>
  ): void {
    if (level < this.config.level) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      namespace,
      message,
      data,
      context: this.buildContext(context),
      traceId: this.getCurrentTraceId(),
      requestId: this.getCurrentRequestId()
    };

    this.config.outputs.forEach(output => {
      try {
        output.write(entry);
      } catch (error) {
        console.error('Log output error:', error);
      }
    });
  }

  // 上下文管理
  pushContext(context: Record<string, any>): void {
    if (!this.config.enableContext) return;

    this.contextStack.push(context);

    // 限制上下文栈大小
    if (this.contextStack.length > this.config.maxContextSize) {
      this.contextStack.shift();
    }
  }

  popContext(): Record<string, any> | undefined {
    return this.contextStack.pop();
  }

  clearContext(): void {
    this.contextStack.length = 0;
  }

  // 构建完整上下文
  private buildContext(additionalContext?: Record<string, any>): Record<string, any> {
    if (!this.config.enableContext) return {};

    const context = this.contextStack.reduce((acc, ctx) => ({ ...acc, ...ctx }), {});

    if (additionalContext) {
      Object.assign(context, additionalContext);
    }

    return context;
  }

  // 获取当前跟踪ID（从上下文中）
  private getCurrentTraceId(): string | undefined {
    const context = this.buildContext();
    return context.traceId;
  }

  // 获取当前请求ID（从上下文中）
  private getCurrentRequestId(): string | undefined {
    const context = this.buildContext();
    return context.requestId;
  }

  // 配置管理
  updateConfig(config: Partial<CrawlLoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): CrawlLoggerConfig {
    return { ...this.config };
  }

  // 添加输出器
  addOutput(output: LogOutput): void {
    this.config.outputs.push(output);
  }

  // 移除输出器
  removeOutput(output: LogOutput): void {
    const index = this.config.outputs.indexOf(output);
    if (index > -1) {
      this.config.outputs.splice(index, 1);
    }
  }

  // 清理资源
  async close(): Promise<void> {
    await Promise.all(
      this.config.outputs
        .filter(output => output.close)
        .map(output => output.close!())
    );
  }
}

// 命名空间日志器
export class NamespaceLogger {
  constructor(
    private logger: CrawlLogger,
    private namespace: string
  ) {}

  debug(message: string, data?: any, context?: Record<string, any>): void {
    this.logger.log(LogLevel.DEBUG, this.namespace, message, data, context);
  }

  info(message: string, data?: any, context?: Record<string, any>): void {
    this.logger.log(LogLevel.INFO, this.namespace, message, data, context);
  }

  warn(message: string, data?: any, context?: Record<string, any>): void {
    this.logger.log(LogLevel.WARN, this.namespace, message, data, context);
  }

  error(message: string, data?: any, context?: Record<string, any>): void {
    this.logger.log(LogLevel.ERROR, this.namespace, message, data, context);
  }

  fatal(message: string, data?: any, context?: Record<string, any>): void {
    this.logger.log(LogLevel.FATAL, this.namespace, message, data, context);
  }

  // 带上下文的日志方法
  withContext(context: Record<string, any>) {
    return {
      debug: (message: string, data?: any) => this.debug(message, data, context),
      info: (message: string, data?: any) => this.info(message, data, context),
      warn: (message: string, data?: any) => this.warn(message, data, context),
      error: (message: string, data?: any) => this.error(message, data, context),
      fatal: (message: string, data?: any) => this.fatal(message, data, context)
    };
  }

  // 创建子命名空间
  child(name: string): NamespaceLogger {
    return new NamespaceLogger(this.logger, `${this.namespace}:${name}`);
  }
}

// 便捷的全局日志器实例
export const logger = CrawlLogger.getInstance();

// 预定义的命名空间日志器
export const loggers = {
  http: logger.namespace('HTTPEngine'),
  strategy: logger.namespace('StrategyManager'),
  cache: logger.namespace('CacheManager'),
  queue: logger.namespace('TaskQueue'),
  security: logger.namespace('SecurityManager'),
  core: logger.namespace('TabTinScraper')
};
