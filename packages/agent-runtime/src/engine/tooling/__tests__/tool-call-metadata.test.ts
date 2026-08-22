import { describe, expect, it } from 'vitest';
import {
  buildToolCallMetadataLifecycleMeta,
  stripToolCallMetadataFromEnvelopeHint,
  stripToolCallMetadata,
} from '../tool-call-metadata.js';

describe('tool-call metadata', () => {
  it('strips reserved runtime metadata from tool input', () => {
    const normalized = stripToolCallMetadata({
      intent: '  检查当前目录状态  ',
      path: '.',
      recursive: false,
    });

    expect(normalized).toEqual({
      toolInput: {
        path: '.',
        recursive: false,
      },
      toolCallMetadata: {
        intent: '检查当前目录状态',
      },
    });
  });

  it('ignores empty metadata and preserves business input', () => {
    expect(stripToolCallMetadata({ intent: ' ', query: 'tabtin' })).toEqual({
      toolInput: { query: 'tabtin' },
    });
  });

  it('normalizes legacy explanation as metadata during migration', () => {
    expect(stripToolCallMetadata({
      explanation: '  查成员再建任务  ',
      project_id: 'project-1',
    })).toEqual({
      toolInput: { project_id: 'project-1' },
      toolCallMetadata: { intent: '查成员再建任务' },
    });
  });

  it('prefers intent over legacy explanation when both are present', () => {
    expect(stripToolCallMetadata({
      intent: '读取最新状态',
      explanation: '旧说明',
      path: '.',
    })).toEqual({
      toolInput: { path: '.' },
      toolCallMetadata: { intent: '读取最新状态' },
    });
  });

  it('strips metadata from provider envelope tool_use hints', () => {
    const hint = stripToolCallMetadataFromEnvelopeHint({
      kind: 'agent.stream.content_block_start',
      index: 0,
      block_id: 'toolu-1',
      block: {
        type: 'tool_use',
        id: 'toolu-1',
        name: 'read_file',
        input: {
          intent: '读取配置',
          explanation: '旧说明',
          path: 'package.json',
        },
      },
    });

    expect(hint).toMatchObject({
      kind: 'agent.stream.content_block_start',
      block: {
        type: 'tool_use',
        input: { path: 'package.json' },
      },
    });
  });

  it('builds lifecycle metadata only when present', () => {
    expect(buildToolCallMetadataLifecycleMeta({ intent: '读取文件' })).toEqual({
      tool_call_metadata: { intent: '读取文件' },
    });
    expect(buildToolCallMetadataLifecycleMeta(undefined)).toEqual({});
  });
});
