/**
 * 日志系统统一导出
 */

export {
  CrawlLogger,
  NamespaceLogger,
  ConsoleOutput,
  FileOutput,
  LogLevel,
  logger,
  loggers
} from './CrawlLogger.js';

export type {
  LogEntry,
  LogOutput,
  CrawlLoggerConfig
} from './CrawlLogger.js';

export {
  JSONFormatter,
  SimpleFormatter,
  DetailedFormatter,
  CompactFormatter,
  ColoredConsoleFormatter,
  StructuredFormatter,
  FastFormatter,
  FormatterFactory
} from './formatters.js';

export type {
  LogFormatter
} from './formatters.js';
