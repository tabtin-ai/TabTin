import fs from 'node:fs';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  raw: string;
}

export interface LogViewerOptions {
  logPath: string;
  lines: number;
  level?: LogLevel;
  since?: string;
  format: 'text' | 'json';
  follow: boolean;
}

const LOG_LINE_RE = /^\[([^\]]+)\]\s+\[([A-Z]+)\]\s+([\s\S]*)$/;

export function parseLogLine(line: string): LogEntry | null {
  const m = LOG_LINE_RE.exec(line);
  if (!m) return null;
  const level = m[2].toLowerCase();
  if (!(level in LEVEL_PRIORITY)) return null;
  return {
    timestamp: m[1],
    level: level as LogLevel,
    message: m[3],
    raw: line,
  };
}

export function parseDuration(duration: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(duration.trim());
  if (!m) throw new Error(`Invalid duration: '${duration}'. Use format like 1h, 30m, 2d, 60s.`);
  const value = parseFloat(m[1]);
  const unit = m[2];
  const multiplier: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multiplier[unit];
}

function matchesLevel(entry: LogEntry, minLevel: LogLevel): boolean {
  return LEVEL_PRIORITY[entry.level] >= LEVEL_PRIORITY[minLevel];
}

function matchesSince(entry: LogEntry, sinceMs: number): boolean {
  const entryTime = new Date(entry.timestamp).getTime();
  if (isNaN(entryTime)) return true;
  return entryTime >= sinceMs;
}

function formatEntry(entry: LogEntry, format: 'text' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify({ timestamp: entry.timestamp, level: entry.level, message: entry.message });
  }
  return entry.raw;
}

function prependCompleteLines(
  chunk: string,
  lines: string[],
  count: number,
): string {
  const parts = chunk.split('\n');
  const remainder = parts.shift() ?? '';
  for (let index = parts.length - 1; index >= 0 && lines.length < count; index--) {
    if (parts[index].length > 0) lines.unshift(parts[index]);
  }
  return remainder;
}

/**
 * Read the last N lines from a file using a backward-seeking buffer strategy.
 * Falls back to full read for small files.
 */
export function readLastLines(filePath: string, count: number): string[] {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return [];

  const CHUNK_SIZE = 8192;
  const fd = fs.openSync(filePath, 'r');
  try {
    let position = stat.size;
    let remainder = '';
    const lines: string[] = [];

    while (position > 0 && lines.length < count) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, position);
      const chunk = buf.toString('utf-8') + remainder;
      remainder = prependCompleteLines(chunk, lines, count);
    }

    if (remainder.length > 0 && lines.length < count) {
      lines.unshift(remainder);
    }

    return lines.slice(-count);
  } finally {
    fs.closeSync(fd);
  }
}

function filterLines(
  lines: string[],
  level?: LogLevel,
  sinceMs?: number,
): LogEntry[] {
  const result: LogEntry[] = [];
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (!entry) continue;
    if (level && !matchesLevel(entry, level)) continue;
    if (sinceMs !== undefined && !matchesSince(entry, sinceMs)) continue;
    result.push(entry);
  }
  return result;
}

export function viewLogs(opts: LogViewerOptions): void {
  if (!fs.existsSync(opts.logPath)) {
    console.error(`Log file not found: ${opts.logPath}`);
    console.error(`Is the daemon initialized? Run 'tabtin-daemon init --token <token>' first.`);
    process.exit(1);
  }

  const sinceMs = opts.since
    ? Date.now() - parseDuration(opts.since)
    : undefined;

  const rawLines = readLastLines(opts.logPath, opts.lines);
  const entries = filterLines(rawLines, opts.level, sinceMs);

  for (const entry of entries) {
    console.log(formatEntry(entry, opts.format));
  }

  if (opts.follow) {
    followLogs(opts.logPath, opts.level, opts.format);
  }
}

function followLogs(
  logPath: string,
  level: LogLevel | undefined,
  format: 'text' | 'json',
): void {
  let fileSize = fs.statSync(logPath).size;

  const processNewContent = (): void => {
    let currentSize: number;
    try {
      currentSize = fs.statSync(logPath).size;
    } catch {
      return;
    }
    if (currentSize <= fileSize) {
      if (currentSize < fileSize) fileSize = currentSize;
      return;
    }

    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(currentSize - fileSize);
      fs.readSync(fd, buf, 0, buf.length, fileSize);
      fileSize = currentSize;
      const chunk = buf.toString('utf-8');
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line) continue;
        const entry = parseLogLine(line);
        if (!entry) continue;
        if (level && !matchesLevel(entry, level)) continue;
        console.log(formatEntry(entry, format));
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  const watcher = fs.watchFile(logPath, { interval: 300 }, processNewContent);

  const cleanup = (): void => {
    fs.unwatchFile(logPath);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
