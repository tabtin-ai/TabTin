import fs from 'node:fs';
import path from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface KernelLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export const consoleLogger: KernelLogger = {
  info: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_FILES = 5;

export interface LoggerOptions {
  maxSize?: number;
  maxFiles?: number;
}

export class Logger implements KernelLogger {
  private readonly minLevel: number;
  private logStream: fs.WriteStream | null = null;
  private readonly logFilePath: string | undefined;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private currentSize = 0;

  constructor(level: LogLevel, logFilePath?: string, options?: LoggerOptions) {
    this.minLevel = LEVEL_PRIORITY[level] ?? 1;
    this.logFilePath = logFilePath;
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
    if (logFilePath) {
      this.openStream(logFilePath);
    }
  }

  private openStream(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.logStream = fs.createWriteStream(filePath, { flags: 'a' });
    try {
      const stats = fs.statSync(filePath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }
  }

  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: any[]): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    const line = args.length > 0
      ? `${prefix} ${message} ${args.map(a => {
          if (a instanceof Error) return a.stack ?? a.message;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ')}`
      : `${prefix} ${message}`;

    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }

    if (this.logStream) {
      const bytes = Buffer.byteLength(line + '\n', 'utf-8');
      this.logStream.write(line + '\n');
      this.currentSize += bytes;
      if (this.currentSize >= this.maxSize) {
        this.rotate();
      }
    }
  }

  private rotate(): void {
    if (!this.logFilePath || !this.logStream) return;
    try {
      this.logStream.end();

      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = i === 1 ? this.logFilePath : `${this.logFilePath}.${i - 1}`;
        const dst = `${this.logFilePath}.${i}`;
        try {
          if (fs.existsSync(dst)) fs.unlinkSync(dst);
          if (fs.existsSync(src)) fs.renameSync(src, dst);
        } catch { /* best-effort per file */ }
      }

      if (fs.existsSync(this.logFilePath)) {
        fs.renameSync(this.logFilePath, `${this.logFilePath}.1`);
      }

      this.openStream(this.logFilePath);
      this.currentSize = 0;
    } catch { /* rotation failure should not block logging */ }
  }

  close(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}
