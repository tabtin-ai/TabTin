import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseLogLine, parseDuration, readLastLines, viewLogs } from '../src/platform/observability/diagnostics/log-viewer.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-log-test-'));
}

describe('parseLogLine', () => {
  it('parses a standard INFO log line', () => {
    const entry = parseLogLine('[2024-06-15T10:30:00.000Z] [INFO] Daemon started');
    expect(entry).toEqual({
      timestamp: '2024-06-15T10:30:00.000Z',
      level: 'info',
      message: 'Daemon started',
      raw: '[2024-06-15T10:30:00.000Z] [INFO] Daemon started',
    });
  });

  it('parses ERROR level', () => {
    const entry = parseLogLine('[2024-06-15T10:30:00.000Z] [ERROR] Connection failed');
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('error');
    expect(entry!.message).toBe('Connection failed');
  });

  it('parses WARN level', () => {
    const entry = parseLogLine('[2024-06-15T10:30:00.000Z] [WARN] Slow heartbeat');
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('warn');
  });

  it('parses DEBUG level', () => {
    const entry = parseLogLine('[2024-06-15T10:30:00.000Z] [DEBUG] WS frame received');
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('debug');
  });

  it('returns null for non-log lines', () => {
    expect(parseLogLine('random text')).toBeNull();
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('[incomplete')).toBeNull();
  });

  it('handles messages with JSON content', () => {
    const line = '[2024-06-15T10:30:00.000Z] [INFO] Request {"action":"heartbeat","ts":123}';
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.message).toBe('Request {"action":"heartbeat","ts":123}');
  });
});

describe('parseDuration', () => {
  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
  });

  it('parses days', () => {
    expect(parseDuration('2d')).toBe(172_800_000);
  });

  it('parses seconds', () => {
    expect(parseDuration('60s')).toBe(60_000);
  });

  it('parses fractional values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('throws on invalid input', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('10x')).toThrow('Invalid duration');
  });
});

describe('readLastLines', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads last N lines from a file', () => {
    const filePath = path.join(dir, 'test.log');
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = readLastLines(filePath, 5);
    expect(result).toEqual(['Line 96', 'Line 97', 'Line 98', 'Line 99', 'Line 100']);
  });

  it('handles file with fewer lines than requested', () => {
    const filePath = path.join(dir, 'test.log');
    fs.writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\n');

    const result = readLastLines(filePath, 10);
    expect(result).toEqual(['Line 1', 'Line 2', 'Line 3']);
  });

  it('returns empty array for empty file', () => {
    const filePath = path.join(dir, 'empty.log');
    fs.writeFileSync(filePath, '');

    const result = readLastLines(filePath, 10);
    expect(result).toEqual([]);
  });

  it('handles single line without trailing newline', () => {
    const filePath = path.join(dir, 'single.log');
    fs.writeFileSync(filePath, 'Only line');

    const result = readLastLines(filePath, 5);
    expect(result).toEqual(['Only line']);
  });

  it('handles large files efficiently', () => {
    const filePath = path.join(dir, 'large.log');
    const lines = Array.from({ length: 10_000 }, (_, i) => `[2024-01-01T00:00:00.000Z] [INFO] Log entry ${i}`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = readLastLines(filePath, 3);
    expect(result).toHaveLength(3);
    expect(result[2]).toContain('Log entry 9999');
  });
});

describe('viewLogs (integration)', () => {
  let dir: string;
  let logPath: string;
  let originalLog: typeof console.log;
  let captured: string[];

  beforeEach(() => {
    dir = tmpDir();
    logPath = path.join(dir, 'daemon.log');
    captured = [];
    originalLog = console.log;
    console.log = (...args: any[]) => { captured.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('outputs last N lines in text format', () => {
    const lines = [
      '[2024-06-15T10:00:00.000Z] [INFO] Line 1',
      '[2024-06-15T10:01:00.000Z] [WARN] Line 2',
      '[2024-06-15T10:02:00.000Z] [ERROR] Line 3',
    ];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    viewLogs({ logPath, lines: 2, format: 'text', follow: false });
    expect(captured).toEqual([
      '[2024-06-15T10:01:00.000Z] [WARN] Line 2',
      '[2024-06-15T10:02:00.000Z] [ERROR] Line 3',
    ]);
  });

  it('outputs in JSON format', () => {
    fs.writeFileSync(logPath, '[2024-06-15T10:00:00.000Z] [INFO] Hello world\n');

    viewLogs({ logPath, lines: 10, format: 'json', follow: false });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]);
    expect(parsed).toEqual({
      timestamp: '2024-06-15T10:00:00.000Z',
      level: 'info',
      message: 'Hello world',
    });
  });

  it('filters by level', () => {
    const lines = [
      '[2024-06-15T10:00:00.000Z] [DEBUG] Debug msg',
      '[2024-06-15T10:01:00.000Z] [INFO] Info msg',
      '[2024-06-15T10:02:00.000Z] [WARN] Warn msg',
      '[2024-06-15T10:03:00.000Z] [ERROR] Error msg',
    ];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    viewLogs({ logPath, lines: 50, level: 'warn', format: 'text', follow: false });
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain('[WARN]');
    expect(captured[1]).toContain('[ERROR]');
  });

  it('filters by --since duration', () => {
    const now = Date.now();
    const recent = new Date(now - 30 * 60_000).toISOString();
    const old = new Date(now - 3 * 3_600_000).toISOString();
    const lines = [
      `[${old}] [INFO] Old entry`,
      `[${recent}] [INFO] Recent entry`,
    ];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    viewLogs({ logPath, lines: 50, since: '1h', format: 'text', follow: false });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('Recent entry');
  });

  it('combines level and since filters', () => {
    const now = Date.now();
    const recent = new Date(now - 10 * 60_000).toISOString();
    const old = new Date(now - 3 * 3_600_000).toISOString();
    const lines = [
      `[${old}] [ERROR] Old error`,
      `[${recent}] [INFO] Recent info`,
      `[${recent}] [ERROR] Recent error`,
    ];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    viewLogs({ logPath, lines: 50, level: 'error', since: '1h', format: 'text', follow: false });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('Recent error');
  });
});
