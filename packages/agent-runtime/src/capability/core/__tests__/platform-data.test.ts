import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PlatformDataCap, type PlatformDataCapConfig } from '../platform-data.js';
import type {
  ToolContext,
} from '../../../engine/contracts/tools.js';

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function makePlatformDirs(): { archiveDir: string; toolLogsDir: string } {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-platform-data-'));
  return {
    archiveDir: path.join(tmpRoot, 'sessions'),
    toolLogsDir: path.join(tmpRoot, 'tool-logs'),
  };
}

function makeContext(): ToolContext {
  return {
    threadId: 'thread-platform-data',
    runtimeId: 'runtime-platform-data',
    abortSignal: new AbortController().signal,
    messages: [],
  } as ToolContext;
}

function getTool(overrides: Partial<PlatformDataCapConfig> = {}) {
  const dirs = makePlatformDirs();
  const config: PlatformDataCapConfig = {
    archiveDir: dirs.archiveDir,
    toolLogsDir: dirs.toolLogsDir,
    archiveSessionId: 'thread-platform-data',
    toolLogsSessionId: 'thread-platform-data',
    ...overrides,
  };
  const tool = new PlatformDataCap(config)
    .tools()
    .find((candidate) => candidate.name === 'read_platform_data');
  if (!tool) throw new Error('read_platform_data not found');
  return { tool, config };
}

describe('PlatformDataCap', () => {
  it('reads a bounded grep slice from current-session messages', async () => {
    const { tool, config } = getTool();
    const sessionDir = path.join(config.archiveDir, config.archiveSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'messages.jsonl'),
      [
        '{"role":"user","text":"noise"}',
        '{"role":"assistant","text":"NEEDLE first"}',
        '{"role":"assistant","text":"NEEDLE second"}',
      ].join('\n'),
      'utf-8',
    );

    const result = await tool.execute({
      record_type: 'messages',
      grep: 'needle',
      max_chars: 40,
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      record_type: 'messages',
      grep: 'needle',
      max_chars: 40,
      truncated: true,
    });
    expect(parsed.content).toBe('{"role":"assistant","text":"NEEDLE first');
    expect(JSON.stringify(parsed)).not.toContain(config.archiveDir);
  });

  it('lists tool log ids without exposing the tool logs directory', async () => {
    const { tool, config } = getTool();
    const sessionDir = path.join(config.toolLogsDir, config.toolLogsSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'toolu_1.md'), '# Tool 1', 'utf-8');
    fs.writeFileSync(path.join(sessionDir, 'toolu_2.md'), '# Tool 2', 'utf-8');

    const result = await tool.execute({ record_type: 'tool_logs' }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      record_type: 'tool_logs',
      mode: 'index',
      tool_log_ids: ['toolu_1', 'toolu_2'],
      truncated: false,
    });
    expect(JSON.stringify(parsed)).not.toContain(config.toolLogsDir);
  });

  it('reads a specific tool log by id', async () => {
    const { tool, config } = getTool();
    const sessionDir = path.join(config.toolLogsDir, config.toolLogsSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'toolu_ok.md'),
      ['irrelevant', 'TARGET output line', 'another line'].join('\n'),
      'utf-8',
    );

    const result = await tool.execute({
      record_type: 'tool_logs',
      tool_log_id: 'toolu_ok',
      grep: 'target',
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      record_type: 'tool_logs',
      truncated: false,
      content: 'TARGET output line',
    });
  });

  it('can read archive and tool logs from different session buckets', async () => {
    const { tool, config } = getTool({
      archiveSessionId: 'thread-archive',
      toolLogsSessionId: 'thread-tools',
    });
    const archiveSessionDir = path.join(config.archiveDir, config.archiveSessionId);
    const toolLogsSessionDir = path.join(config.toolLogsDir, config.toolLogsSessionId);
    fs.mkdirSync(archiveSessionDir, { recursive: true });
    fs.mkdirSync(toolLogsSessionDir, { recursive: true });
    fs.writeFileSync(path.join(archiveSessionDir, 'events.jsonl'), 'ARCHIVE_SENTINEL', 'utf-8');
    fs.writeFileSync(path.join(toolLogsSessionDir, 'toolu_split.md'), 'TOOL_SENTINEL', 'utf-8');

    const archiveResult = await tool.execute({ record_type: 'events' }, makeContext());
    const toolLogResult = await tool.execute({
      record_type: 'tool_logs',
      tool_log_id: 'toolu_split',
    }, makeContext());

    const archiveParsed = JSON.parse(archiveResult.content as string) as Record<string, unknown>;
    const toolLogParsed = JSON.parse(toolLogResult.content as string) as Record<string, unknown>;
    expect(archiveParsed.content).toBe('ARCHIVE_SENTINEL');
    expect(toolLogParsed.content).toBe('TOOL_SENTINEL');
  });

  it('rejects unsafe tool log ids before resolving paths', async () => {
    const { tool } = getTool();
    const result = await tool.execute({
      record_type: 'tool_logs',
      tool_log_id: '../escape',
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      error_kind: 'invalid_param_format',
    });
  });

  it('rejects symlinked archive records', async () => {
    const { tool, config } = getTool();
    const sessionDir = path.join(config.archiveDir, config.archiveSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const outsideFile = path.join(tmpRoot ?? config.archiveDir, 'outside.jsonl');
    fs.writeFileSync(outsideFile, 'external secret', 'utf-8');
    fs.symlinkSync(outsideFile, path.join(sessionDir, 'events.jsonl'));

    const result = await tool.execute({ record_type: 'events' }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      error_kind: 'permission_denied',
    });
  });

  it('does not expose local paths in read failure errors', async () => {
    const { tool, config } = getTool();
    const blockingFile = path.join(config.archiveDir, config.archiveSessionId);
    fs.mkdirSync(config.archiveDir, { recursive: true });
    fs.writeFileSync(blockingFile, 'not a directory', 'utf-8');

    const result = await tool.execute({ record_type: 'snapshots' }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
    });
    expect(typeof parsed.error_kind).toBe('string');
    expect(JSON.stringify(parsed)).not.toContain(config.archiveDir);
    expect(JSON.stringify(parsed)).not.toContain(config.archiveSessionId);
  });
});
