import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { v5 as uuidv5 } from 'uuid';

import { isTabtinToolUseId } from '../../engine/context/tool-id-mapper.js';
import { forkLocalSessionArchive } from '../fork-local-session.js';

describe('forkLocalSessionArchive ', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-local-'));
    dirs.push(dir);
    return dir;
  }

  it('skips when source archive is missing', () => {
    const root = tmpRoot();
    const result = forkLocalSessionArchive({
      sessionArchiveDir: root,
      sourceSessionId: 'src',
      newSessionId: 'dst',
    });
    expect(result.skipped).toBe(true);
    expect(result.copied).toBe(false);
    expect(result.reason).toBe('source_missing');
  });

  it('copies archive and remaps tool + session ids', () => {
    const root = tmpRoot();
    const srcId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const dstId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const srcDir = path.join(root, 'sessions', srcId);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'message-blocks.jsonl'),
      `${JSON.stringify({
        message_id: 'm1',
        threadId: srcId,
        blocks: [
          { type: 'tool_use', id: 'run_terminal_command_41', name: 'run_terminal_command', input: {} },
          { type: 'tool_result', tool_use_id: 'run_terminal_command_41', content: 'ok' },
        ],
      })}\n`,
      'utf8',
    );

    const toolLogsRoot = path.join(root, 'tool-logs');
    const srcLogs = path.join(toolLogsRoot, srcId);
    fs.mkdirSync(srcLogs, { recursive: true });
    fs.writeFileSync(path.join(srcLogs, 'run_terminal_command_41.md'), '# log\n', 'utf8');
    fs.writeFileSync(
      path.join(srcLogs, '_index.jsonl'),
      `${JSON.stringify({
        tool_call_id: 'run_terminal_command_41',
        path: `tool-logs/${srcId}/run_terminal_command_41.md`,
      })}\n`,
      'utf8',
    );

    const result = forkLocalSessionArchive({
      sessionArchiveDir: path.join(root, 'sessions'),
      toolLogsDir: toolLogsRoot,
      sourceSessionId: srcId,
      newSessionId: dstId,
    });

    expect(result.copied).toBe(true);
    expect(result.remappedToolIds).toBeGreaterThanOrEqual(1);

    const destBlocksPath = path.join(root, 'sessions', dstId, 'message-blocks.jsonl');
    const line = fs.readFileSync(destBlocksPath, 'utf8').trim();
    const parsed = JSON.parse(line) as {
      threadId: string;
      blocks: Array<{ type: string; id?: string; tool_use_id?: string }>;
    };
    expect(parsed.threadId).toBe(dstId);
    const use = parsed.blocks.find((b) => b.type === 'tool_use');
    const resultBlock = parsed.blocks.find((b) => b.type === 'tool_result');
    expect(use?.id && isTabtinToolUseId(use.id)).toBe(true);
    expect(resultBlock?.tool_use_id).toBe(use?.id);

    const destLogs = path.join(toolLogsRoot, dstId);
    expect(fs.existsSync(path.join(destLogs, `${use!.id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(destLogs, 'run_terminal_command_41.md'))).toBe(false);
  });

  it('remaps UUID message ids consistently across the fork archive', () => {
    const root = tmpRoot();
    const srcId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const dstId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sourceMessageId = '11111111-1111-4111-8111-111111111111';
    const srcDir = path.join(root, 'sessions', srcId);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'message-blocks.jsonl'),
      `${JSON.stringify({
        message_id: sourceMessageId,
        role: 'assistant',
        threadId: srcId,
        blocks: [{ type: 'text', text: sourceMessageId }],
      })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'messages.jsonl'),
      `${JSON.stringify({
        type: 'agent.stream.message_stop',
        payload: { message_id: sourceMessageId, session_id: srcId },
      })}\n`,
      'utf8',
    );

    const result = forkLocalSessionArchive({
      sessionArchiveDir: path.join(root, 'sessions'),
      sourceSessionId: srcId,
      newSessionId: dstId,
    });

    const expectedMessageId = uuidv5(`${dstId}:${sourceMessageId}`, dstId);
    const block = JSON.parse(
      fs.readFileSync(
        path.join(root, 'sessions', dstId, 'message-blocks.jsonl'),
        'utf8',
      ).trim(),
    ) as { message_id: string; blocks: Array<{ text: string }> };
    const event = JSON.parse(
      fs.readFileSync(
        path.join(root, 'sessions', dstId, 'messages.jsonl'),
        'utf8',
      ).trim(),
    ) as { payload: { message_id: string; session_id: string } };

    expect(result.remappedMessageIds).toBe(1);
    expect(block.message_id).toBe(expectedMessageId);
    expect(block.blocks[0]?.text).toBe(sourceMessageId);
    expect(event.payload.message_id).toBe(expectedMessageId);
    expect(event.payload.session_id).toBe(dstId);
  });

  it('truncates message-blocks at forkAnchorMessageId', () => {
    const root = tmpRoot();
    const srcId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const dstId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const srcDir = path.join(root, 'sessions', srcId);
    fs.mkdirSync(srcDir, { recursive: true });
    const lines = [
      { message_id: 'm1', threadId: srcId, blocks: [{ type: 'text', text: 'q1' }] },
      { message_id: 'm2', threadId: srcId, blocks: [{ type: 'text', text: 'a1' }] },
      { message_id: 'm3', threadId: srcId, blocks: [{ type: 'text', text: 'q2-after-fork' }] },
    ];
    fs.writeFileSync(
      path.join(srcDir, 'message-blocks.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );

    const result = forkLocalSessionArchive({
      sessionArchiveDir: path.join(root, 'sessions'),
      sourceSessionId: srcId,
      newSessionId: dstId,
      forkAnchorMessageId: 'm2',
    });
    expect(result.copied).toBe(true);
    expect(result.truncatedAtForkPoint).toBe(true);

    const destPath = path.join(root, 'sessions', dstId, 'message-blocks.jsonl');
    const kept = fs.readFileSync(destPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(kept.map((r: { message_id: string }) => r.message_id)).toEqual(['m1', 'm2']);
  });

  it('uses the Agent Host message id as the local fork anchor', () => {
    const root = tmpRoot();
    const srcId = 'cccccccc-cccc-cccc-cccc-cccccccccccd';
    const dstId = 'dddddddd-dddd-dddd-dddd-ddddddddddde';
    const srcDir = path.join(root, 'sessions', srcId);
    fs.mkdirSync(srcDir, { recursive: true });
    const lines = [
      { message_id: 'm1', threadId: srcId, blocks: [{ type: 'text', text: 'q1' }] },
      { message_id: 'raw-runtime-a2', threadId: srcId, blocks: [{ type: 'text', text: 'a1' }] },
      { message_id: 'm3', threadId: srcId, blocks: [{ type: 'text', text: 'after-fork' }] },
    ];
    fs.writeFileSync(
      path.join(srcDir, 'message-blocks.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );

    const result = forkLocalSessionArchive({
      sessionArchiveDir: path.join(root, 'sessions'),
      sourceSessionId: srcId,
      newSessionId: dstId,
      forkAnchorMessageId: 'raw-runtime-a2',
    });
    expect(result.copied).toBe(true);
    expect(result.truncatedAtForkPoint).toBe(true);

    const destPath = path.join(root, 'sessions', dstId, 'message-blocks.jsonl');
    const kept = fs.readFileSync(destPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(kept.map((r: { message_id: string }) => r.message_id)).toEqual(['m1', 'raw-runtime-a2']);
  });

  it('trims trailing unpaired user blocks so archive ends on assistant', () => {
    const root = tmpRoot();
    const srcId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const dstId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const srcDir = path.join(root, 'sessions', srcId);
    fs.mkdirSync(srcDir, { recursive: true });
    const lines = [
      { message_id: 'm1', role: 'user', message_kind: 'llm', blocks: [{ type: 'text', text: 'q1' }] },
      { message_id: 'm2', role: 'assistant', message_kind: 'llm', blocks: [{ type: 'text', text: 'a1' }] },
      { message_id: 'm3', role: 'user', message_kind: 'llm', blocks: [{ type: 'text', text: 'orphan-r3' }] },
    ];
    fs.writeFileSync(
      path.join(srcDir, 'message-blocks.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );
    // 六件套也带尾部 user；裁 blocks 后应按 m2 截断 messages.jsonl
    const msgLines = [
      { type: 'agent.stream.message_start', payload: { message_id: 'm1', role: 'user' } },
      { type: 'agent.stream.message_stop', payload: { message_id: 'm1' } },
      { type: 'agent.stream.message_start', payload: { message_id: 'm2', role: 'assistant' } },
      { type: 'agent.stream.message_stop', payload: { message_id: 'm2' } },
      { type: 'agent.stream.message_start', payload: { message_id: 'm3', role: 'user' } },
      { type: 'agent.stream.message_stop', payload: { message_id: 'm3' } },
    ];
    fs.writeFileSync(
      path.join(srcDir, 'messages.jsonl'),
      `${msgLines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );

    const result = forkLocalSessionArchive({
      sessionArchiveDir: path.join(root, 'sessions'),
      sourceSessionId: srcId,
      newSessionId: dstId,
    });
    expect(result.copied).toBe(true);
    expect(result.truncatedAtForkPoint).toBe(true);

    const destPath = path.join(root, 'sessions', dstId, 'message-blocks.jsonl');
    const kept = fs.readFileSync(destPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(kept.map((r: { message_id: string }) => r.message_id)).toEqual(['m1', 'm2']);
    expect(kept.some((r: { message_id: string }) => r.message_id === 'm3')).toBe(false);

    const destMsgs = fs
      .readFileSync(path.join(root, 'sessions', dstId, 'messages.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { payload: { message_id: string } });
    expect(destMsgs.every((r) => r.payload.message_id !== 'm3')).toBe(true);
    expect(destMsgs.some((r) => r.payload.message_id === 'm2')).toBe(true);
  });

  it('seeds tool id remap from cloud so both sides share the same tu_*', () => {
    const root = tmpRoot();
    const srcId = '11111111-1111-1111-1111-111111111111';
    const dstId = '22222222-2222-2222-2222-222222222222';
    const srcDir = path.join(root, 'sessions', srcId);
    fs.mkdirSync(srcDir, { recursive: true });
    const cloudTu = 'tu_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    fs.writeFileSync(
      path.join(srcDir, 'message-blocks.jsonl'),
      `${JSON.stringify({
        message_id: 'm1',
        role: 'assistant',
        blocks: [
          { type: 'tool_use', id: 'run_terminal_command_41', name: 'run_terminal_command', input: {} },
          { type: 'tool_result', tool_use_id: 'run_terminal_command_41', content: 'ok' },
        ],
      })}\n`,
      'utf8',
    );

    const result = forkLocalSessionArchive({
      sessionArchiveDir: path.join(root, 'sessions'),
      sourceSessionId: srcId,
      newSessionId: dstId,
      toolIdRemap: { run_terminal_command_41: cloudTu },
    });
    expect(result.copied).toBe(true);

    const line = fs.readFileSync(
      path.join(root, 'sessions', dstId, 'message-blocks.jsonl'),
      'utf8',
    ).trim();
    const parsed = JSON.parse(line) as {
      blocks: Array<{ type: string; id?: string; tool_use_id?: string }>;
    };
    const use = parsed.blocks.find((b) => b.type === 'tool_use');
    const resultBlock = parsed.blocks.find((b) => b.type === 'tool_result');
    expect(use?.id).toBe(cloudTu);
    expect(resultBlock?.tool_use_id).toBe(cloudTu);
  });
});
