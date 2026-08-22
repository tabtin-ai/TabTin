import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RawRefCap, type RawRefCapConfig } from '../raw-ref.js';
import type {
  ToolContext,
} from '../../../engine/contracts/tools.js';

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function makeToolLogsDir(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-raw-ref-'));
  return path.join(tmpRoot, 'tool-logs');
}

function makeContext(): ToolContext {
  return {
    threadId: 'thread-raw-ref',
    runtimeId: 'runtime-raw-ref',
    abortSignal: new AbortController().signal,
    messages: [],
  } as ToolContext;
}

function getTool(toolLogsDir: string, overrides: Partial<RawRefCapConfig> = {}) {
  const tool = new RawRefCap({
    toolLogsDir,
    sessionId: 'thread-raw-ref',
    ...overrides,
  })
    .tools()
    .find((candidate) => candidate.name === 'read_raw_ref');
  if (!tool) throw new Error('read_raw_ref not found');
  return tool;
}

describe('RawRefCap', () => {
  it('reads a bounded grep slice from the current session tool log', async () => {
    const toolLogsDir = makeToolLogsDir();
    const sessionDir = path.join(toolLogsDir, 'thread-raw-ref');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'toolu_ok.md'),
      [
        '# Tool Call: run_terminal_command',
        'alpha irrelevant',
        'needle first line',
        'beta irrelevant',
        'needle second line with more content',
      ].join('\n'),
      'utf-8',
    );

    const result = await getTool(toolLogsDir).execute({
      raw_ref: 'tool-log://thread-raw-ref/toolu_ok',
      grep: 'needle',
      max_chars: 18,
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      raw_ref: 'tool-log://thread-raw-ref/toolu_ok',
      grep: 'needle',
      max_chars: 18,
      truncated: true,
    });
    expect(parsed.content).toBe('needle first line\n');
  });

  it('prefers the complete terminal stdout side file when tool-log output is truncated', async () => {
    const toolLogsDir = makeToolLogsDir();
    const toolResultsDir = path.join(tmpRoot ?? toolLogsDir, 'tool-results');
    const sessionDir = path.join(toolLogsDir, 'thread-raw-ref');
    const outputSessionDir = path.join(toolResultsDir, 'thread-raw-ref');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(outputSessionDir, { recursive: true });

    const fullOutputPath = path.join(outputSessionDir, 'shell-runu_long-stdout.log');
    fs.writeFileSync(
      fullOutputPath,
      [
        'NOISE line=1',
        'NOISE line=1221',
        "ERROR_SENTINEL code=E_SMOKE_42 component=projection_probe message='synthetic searchable line'",
        'NOISE line=1223',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'runu_long.md'),
      [
        '# Tool Call: run_terminal_command',
        '- call_id: runu_long',
        '',
        '## Input',
        JSON.stringify({
          command: 'python3 -c "print(\\"ERROR_SENTINEL code=SOURCE_ONLY component=command\\")"',
        }, null, 2),
        '',
        '## Output',
        JSON.stringify({
          status: 'completed',
          stdout: 'NOISE line=1\n\n... [90000 bytes elided — read full output via persisted_output_path] ...\n\nNOISE line=2200',
          stdout_truncated: true,
          full_output_path: fullOutputPath,
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await getTool(toolLogsDir, { toolResultsDir }).execute({
      raw_ref: 'tool-log://thread-raw-ref/runu_long',
      grep: 'ERROR_SENTINEL',
      max_chars: 1000,
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      raw_ref: 'tool-log://thread-raw-ref/runu_long',
      grep: 'ERROR_SENTINEL',
      source: 'full_output_path',
      truncated: false,
    });
    expect(parsed.content).toContain('ERROR_SENTINEL code=E_SMOKE_42 component=projection_probe');
    expect(parsed.content).not.toContain('SOURCE_ONLY');
    expect(parsed.content).not.toContain('90000 bytes elided');
  });

  it('falls back to tool-log when terminal stdout side file escapes the session root', async () => {
    const toolLogsDir = makeToolLogsDir();
    const toolResultsDir = path.join(tmpRoot ?? toolLogsDir, 'tool-results');
    const sessionDir = path.join(toolLogsDir, 'thread-raw-ref');
    const outsideDir = path.join(tmpRoot ?? toolLogsDir, 'outside-results');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideOutputPath = path.join(outsideDir, 'shell-runu_escape-stdout.log');
    fs.writeFileSync(outsideOutputPath, 'SECRET_OUTSIDE_SESSION', 'utf-8');
    fs.writeFileSync(
      path.join(sessionDir, 'runu_escape.md'),
      [
        '# Tool Call: run_terminal_command',
        '',
        '## Input',
        JSON.stringify({ command: 'echo safe' }),
        '',
        '## Output',
        JSON.stringify({
          status: 'completed',
          stdout: 'fallback tool-log body',
          stdout_truncated: true,
          full_output_path: outsideOutputPath,
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await getTool(toolLogsDir, { toolResultsDir }).execute({
      raw_ref: 'tool-log://thread-raw-ref/runu_escape',
      grep: 'SECRET_OUTSIDE_SESSION',
      max_chars: 1000,
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      source: 'tool_log',
      truncated: false,
    });
    expect(parsed.content).toBe('');
  });

  it('supports persisted_output_path as the terminal stdout side-file alias', async () => {
    const toolLogsDir = makeToolLogsDir();
    const toolResultsDir = path.join(tmpRoot ?? toolLogsDir, 'tool-results');
    const sessionDir = path.join(toolLogsDir, 'thread-raw-ref');
    const outputSessionDir = path.join(toolResultsDir, 'thread-raw-ref');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(outputSessionDir, { recursive: true });

    const persistedOutputPath = path.join(outputSessionDir, 'shell-runu_persisted-stdout.log');
    fs.writeFileSync(persistedOutputPath, 'PERSISTED_SENTINEL component=alias_path', 'utf-8');
    fs.writeFileSync(
      path.join(sessionDir, 'runu_persisted.md'),
      [
        '# Tool Call: run_terminal_command',
        '',
        '## Input',
        JSON.stringify({ command: 'echo persisted' }),
        '',
        '## Output',
        JSON.stringify({
          status: 'completed',
          stdout: 'truncated preview',
          stdout_truncated: true,
          persisted_output_path: persistedOutputPath,
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await getTool(toolLogsDir, { toolResultsDir }).execute({
      raw_ref: 'tool-log://thread-raw-ref/runu_persisted',
      grep: 'PERSISTED_SENTINEL',
      max_chars: 1000,
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      success: true,
      source: 'full_output_path',
      truncated: false,
    });
    expect(parsed.content).toBe('PERSISTED_SENTINEL component=alias_path');
  });

  it('rejects raw_ref from another session', async () => {
    const toolLogsDir = makeToolLogsDir();
    const result = await getTool(toolLogsDir).execute({
      raw_ref: 'tool-log://other-session/toolu_ok',
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      error_kind: 'permission_denied',
    });
  });

  it('rejects malformed refs before touching the filesystem', async () => {
    const toolLogsDir = makeToolLogsDir();
    const result = await getTool(toolLogsDir).execute({
      raw_ref: 'file:///etc/passwd',
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      error_kind: 'invalid_param_format',
    });
  });

  it('rejects unsafe session ids before resolving evidence paths', async () => {
    const toolLogsDir = makeToolLogsDir();
    const tool = new RawRefCap({ toolLogsDir, sessionId: '..' })
      .tools()
      .find((candidate) => candidate.name === 'read_raw_ref');
    if (!tool) throw new Error('read_raw_ref not found');

    const result = await tool.execute({
      raw_ref: 'tool-log://../toolu_ok',
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      error_kind: 'invalid_param_format',
    });
  });

  it('rejects symlinked evidence files inside the session directory', async () => {
    const toolLogsDir = makeToolLogsDir();
    const sessionDir = path.join(toolLogsDir, 'thread-raw-ref');
    fs.mkdirSync(sessionDir, { recursive: true });
    const outsideFile = path.join(tmpRoot ?? toolLogsDir, 'outside.md');
    fs.writeFileSync(outsideFile, 'external secret', 'utf-8');
    fs.symlinkSync(outsideFile, path.join(sessionDir, 'toolu_link.md'));

    const result = await getTool(toolLogsDir).execute({
      raw_ref: 'tool-log://thread-raw-ref/toolu_link',
    }, makeContext());
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      error_kind: 'permission_denied',
    });
  });
});
