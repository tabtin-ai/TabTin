import { describe, expect, it } from 'vitest';
import { projectTerminalToolResult } from '../src/projection/terminal-tool-projector.js';

describe('projectTerminalToolResult', () => {
  it('extracts compact facts from completed terminal JSON stdout', () => {
    const projection = projectTerminalToolResult({
      toolCallId: 'toolu-create-table',
      sessionId: 'thread-36kr',
      command: 'tabtin table create --name 36kr',
      output: JSON.stringify({
        status: 'completed',
        exit_code: 0,
        stdout: JSON.stringify({
          table_id: 'table-36kr',
          imported_count: 98,
          total_count: 100,
          fields: ['Project ID', 'Project Name', 'Industry'],
        }),
        stdout_truncated: false,
      }),
    });

    expect(projection).toMatchObject({
      type: 'metadata',
      kind: 'model_projection',
      projection_type: 'tool',
      tool_call_id: 'toolu-create-table',
      tool_name: 'run_terminal_command',
      quality: 'complete',
      raw_ref: 'tool-log://thread-36kr/toolu-create-table',
    });
    expect(projection.text).toContain('Tool Projection (run_terminal_command)');
    expect(projection.text).toContain('Status: completed.');
    expect(projection.text).toContain('exit_code=0');
    expect(projection.text).toContain('table_id=table-36kr');
    expect(projection.text).toContain('imported_count=98');
    expect(projection.text).toContain('fields=array(3)');
    expect(projection.text).toContain('raw_ref=tool-log://thread-36kr/toolu-create-table');
  });

  it('marks failed terminal output without losing raw_ref', () => {
    const projection = projectTerminalToolResult({
      toolCallId: 'toolu-failed',
      sessionId: 'thread-failed',
      command: 'curl https://pitchhub.36kr.com/projects',
      isError: true,
      output: JSON.stringify({
        status: 'failed',
        exit_code: 22,
        stdout: 'HTTP 403 Forbidden',
      }),
    });

    expect(projection.quality).toBe('failed');
    expect(projection.text).toContain('Status: failed.');
    expect(projection.text).toContain('exit_code=22');
    expect(projection.text).toContain('stdout_preview=HTTP 403 Forbidden');
    expect(projection.text).toContain('raw_ref=tool-log://thread-failed/toolu-failed');
  });

  it('does not copy long stdout into the model projection', () => {
    const longStdout = 'RAW_36KR_HTML_OR_LOG_SHOULD_NOT_BE_PROJECTED '.repeat(200);
    const projection = projectTerminalToolResult({
      toolCallId: 'toolu-long',
      sessionId: 'thread-long',
      command: 'python scrape_36kr.py',
      output: {
        status: 'completed',
        exit_code: 0,
        stdout: longStdout,
        stdout_truncated: true,
        full_output_path: '/tmp/tabtin-tool-results/thread-long/stdout.log',
      },
    });

    expect(projection.quality).toBe('partial');
    expect(projection.text).toContain('stdout=omitted; use raw_ref for exact evidence');
    expect(projection.text).toContain('/tmp/tabtin-tool-results/thread-long/stdout.log');
    expect(projection.text).not.toContain('RAW_36KR_HTML_OR_LOG_SHOULD_NOT_BE_PROJECTED');
    expect(projection.text.length).toBeLessThan(800);
  });
});
