/**
 * relevant-seen 单测：动态段描述去重（ 后续优化）。
 */

import { describe, it, expect } from 'vitest';
import {
  collectDescribedKeys,
  blankSeenDescriptions,
  RELEVANT_SEEN_MARKER,
} from '../relevant-seen.js';
import type {
  Message,
} from '../../../engine/contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  setInternalMarker,
} from '../../../engine/contracts/conversation.js';

const TAG_OPEN = '<relevant_mcp>';
const TAG_CLOSE = '</relevant_mcp>';

function ctxMsg(rows: string): Message {
  return {
    role: 'user',
    content: `<context type="environment">env</context>\n${TAG_OPEN}\n| tool | server | description |\n| --- | --- | --- |\n${rows}\n${TAG_CLOSE}`,
  } as Message;
}

describe('collectDescribedKeys', () => {
  it('收集描述列非空的行标识；跳过表头/分隔/占位/marker', () => {
    const messages: Message[] = [
      ctxMsg(
        [
          '| create_issue | gh | Create a new issue |',
          '| list_prs | gh | — |', // 空占位不算
          `| get_repo | gh | ${RELEVANT_SEEN_MARKER} |`, // 已 blank 不算
        ].join('\n'),
      ),
    ];
    const seen = collectDescribedKeys(messages, TAG_OPEN, TAG_CLOSE);
    expect([...seen]).toEqual(['create_issue']);
  });

  it('多条历史消息、多块累计', () => {
    const messages: Message[] = [
      ctxMsg('| a | s | desc a |'),
      { role: 'assistant', content: 'blah' } as Message,
      ctxMsg('| b | s | desc b |'),
    ];
    const seen = collectDescribedKeys(messages, TAG_OPEN, TAG_CLOSE);
    expect([...seen].sort()).toEqual(['a', 'b']);
  });

  it('无消息 / 无块 → 空集', () => {
    expect(collectDescribedKeys(undefined, TAG_OPEN, TAG_CLOSE).size).toBe(0);
    expect(
      collectDescribedKeys([{ role: 'user', content: 'hi' } as Message], TAG_OPEN, TAG_CLOSE).size,
    ).toBe(0);
  });

  it('#5503：跳过带 RELEVANT_RECALL / CONTEXT_INJECTION marker 的临时块（防死指针）', () => {
    // 这些块每轮会被 filter 掉重插——不能当「已带过描述」依据，否则新块描述被 blank
    // 后旧块随即被移除 → 死指针。
    const relBlock = setInternalMarker(
      ctxMsg('| a | s | desc a |'),
      INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION,
    );
    const ctxBlock = setInternalMarker(
      ctxMsg('| b | s | desc b |'),
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    expect(collectDescribedKeys([relBlock, ctxBlock], TAG_OPEN, TAG_CLOSE).size).toBe(0);
  });

  it('#5503：稳定历史块（无临时 marker）仍参与去重', () => {
    const historical = ctxMsg('| a | s | desc a |'); // 无临时 marker
    const seen = collectDescribedKeys([historical], TAG_OPEN, TAG_CLOSE);
    expect([...seen]).toEqual(['a']);
  });
});

describe('blankSeenDescriptions', () => {
  const block = [
    TAG_OPEN,
    '| tool | server | description |',
    '| --- | --- | --- |',
    '| create_issue | gh | Create a new issue |',
    '| list_prs | gh | List PRs |',
    TAG_CLOSE,
  ].join('\n');

  it('命中 seen 的行描述列替换为 marker，其余不动', () => {
    const out = blankSeenDescriptions(block, new Set(['create_issue']));
    expect(out).toContain(`| create_issue | gh | ${RELEVANT_SEEN_MARKER} |`);
    expect(out).toContain('| list_prs | gh | List PRs |'); // 未命中不动
    expect(out).toContain('| tool | server | description |'); // 表头不动
  });

  it('seen 为空 → 原样返回', () => {
    expect(blankSeenDescriptions(block, new Set())).toBe(block);
  });
});
