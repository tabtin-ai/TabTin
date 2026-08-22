/**
 * 日志格式化器
 * 提供不同格式的日志输出
 */

import type { LogEntry } from './CrawlLogger.js';
import { LogLevel } from './CrawlLogger.js';
import { t } from '../i18n.js';

// 格式化器接口
export interface LogFormatter {
  format(entry: LogEntry): string;
}

// JSON 格式化器
export class JSONFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    return JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: LogLevel[entry.level],
      namespace: entry.namespace,
      message: entry.message,
      data: entry.data,
      context: entry.context,
      traceId: entry.traceId,
      requestId: entry.requestId
    });
  }
}

// 简单文本格式化器
export class SimpleFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LogLevel[entry.level].padEnd(5);
    const namespace = entry.namespace.padEnd(20);

    let message = `${timestamp} ${level} ${namespace} ${entry.message}`;

    if (entry.traceId) {
      message += ` [trace:${entry.traceId}]`;
    }

    if (entry.requestId) {
      message += ` [req:${entry.requestId}]`;
    }

    return message;
  }
}

// 详细格式化器
export class DetailedFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LogLevel[entry.level];

    let output = `[${timestamp}] ${level} ${entry.namespace}: ${entry.message}`;

    if (entry.data) {
      output += '\n  Data: ' + this.formatData(entry.data);
    }

    if (entry.context && Object.keys(entry.context).length > 0) {
      output += '\n  Context: ' + this.formatData(entry.context);
    }

    if (entry.traceId) {
      output += `\n  TraceId: ${entry.traceId}`;
    }

    if (entry.requestId) {
      output += `\n  RequestId: ${entry.requestId}`;
    }

    return output;
  }

  private formatData(data: any): string {
    if (typeof data === 'string') {
      return data;
    }

    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
}

// 紧凑格式化器（适合生产环境）
export class CompactFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LogLevel[entry.level];

    const parts = [
      timestamp,
      level,
      entry.namespace,
      entry.message
    ];

    if (entry.traceId) {
      parts.push(`trace=${entry.traceId}`);
    }

    if (entry.requestId) {
      parts.push(`req=${entry.requestId}`);
    }

    if (entry.data) {
      parts.push(`data=${this.compactData(entry.data)}`);
    }

    return parts.join(' | ');
  }

  private compactData(data: any): string {
    if (typeof data === 'string') {
      return data.length > 100 ? data.substring(0, 100) + '...' : data;
    }

    try {
      const json = JSON.stringify(data);
      return json.length > 200 ? json.substring(0, 200) + '...' : json;
    } catch {
      return String(data);
    }
  }
}

// 彩色控制台格式化器
export class ColoredConsoleFormatter implements LogFormatter {
  private colors = {
    [LogLevel.DEBUG]: '\x1b[36m',  // 青色
    [LogLevel.INFO]: '\x1b[32m',   // 绿色
    [LogLevel.WARN]: '\x1b[33m',   // 黄色
    [LogLevel.ERROR]: '\x1b[31m',  // 红色
    [LogLevel.FATAL]: '\x1b[35m'   // 紫色
  };

  private reset = '\x1b[0m';
  private bold = '\x1b[1m';
  private dim = '\x1b[2m';

  format(entry: LogEntry): string {
    const color = this.colors[entry.level];
    const levelName = LogLevel[entry.level];
    const timestamp = this.dim + entry.timestamp.toISOString() + this.reset;
    const namespace = this.bold + entry.namespace + this.reset;

    let message = `${timestamp} ${color}${levelName}${this.reset} ${namespace}: ${entry.message}`;

    if (entry.data) {
      message += '\n' + this.dim + this.formatData(entry.data) + this.reset;
    }

    if (entry.context && Object.keys(entry.context).length > 0) {
      message += '\n' + this.dim + 'Context: ' + this.formatData(entry.context) + this.reset;
    }

    if (entry.traceId || entry.requestId) {
      const ids: string[] = [];
      if (entry.traceId) ids.push(`trace:${entry.traceId}`);
      if (entry.requestId) ids.push(`req:${entry.requestId}`);
      message += '\n' + this.dim + ids.join(' | ') + this.reset;
    }

    return message;
  }

  private formatData(data: any): string {
    if (typeof data === 'string') {
      return data;
    }

    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
}

// 结构化日志格式化器（适合日志聚合系统）
export class StructuredFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    const structured = {
      '@timestamp': entry.timestamp.toISOString(),
      '@level': LogLevel[entry.level],
      '@namespace': entry.namespace,
      '@message': entry.message,
      '@version': '1.0',
      '@source': 'tabtin-crawl'
    };

    // 添加跟踪信息
    if (entry.traceId) {
      (structured as any)['@traceId'] = entry.traceId;
    }

    if (entry.requestId) {
      (structured as any)['@requestId'] = entry.requestId;
    }

    // 添加数据字段
    if (entry.data) {
      (structured as any).data = entry.data;
    }

    // 添加上下文字段
    if (entry.context) {
      Object.keys(entry.context).forEach(key => {
        (structured as any)[`ctx_${key}`] = entry.context![key];
      });
    }

    return JSON.stringify(structured);
  }
}

// 性能优化的格式化器（最小化字符串操作）
export class FastFormatter implements LogFormatter {
  private buffer: string[] = [];

  format(entry: LogEntry): string {
    this.buffer.length = 0; // 重用数组

    this.buffer.push(entry.timestamp.toISOString());
    this.buffer.push(' ');
    this.buffer.push(LogLevel[entry.level]);
    this.buffer.push(' ');
    this.buffer.push(entry.namespace);
    this.buffer.push(': ');
    this.buffer.push(entry.message);

    if (entry.traceId) {
      this.buffer.push(' [');
      this.buffer.push(entry.traceId);
      this.buffer.push(']');
    }

    return this.buffer.join('');
  }
}

// 格式化器工厂
export class FormatterFactory {
  private static formatters = new Map<string, () => LogFormatter>([
    ['json', () => new JSONFormatter()],
    ['simple', () => new SimpleFormatter()],
    ['detailed', () => new DetailedFormatter()],
    ['compact', () => new CompactFormatter()],
    ['colored', () => new ColoredConsoleFormatter()],
    ['structured', () => new StructuredFormatter()],
    ['fast', () => new FastFormatter()]
  ]);

  static create(type: string): LogFormatter {
    const factory = this.formatters.get(type.toLowerCase());
    if (!factory) {
      throw new Error(t('errors.logger.unknownFormatterType', { type }));
    }
    return factory();
  }

  static register(type: string, factory: () => LogFormatter): void {
    this.formatters.set(type.toLowerCase(), factory);
  }

  static getAvailableTypes(): string[] {
    return Array.from(this.formatters.keys());
  }
}
