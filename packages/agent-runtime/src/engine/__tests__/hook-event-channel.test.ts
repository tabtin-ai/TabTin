/**
 * HookEventChannel 实时性守门（ review D1 修复）。
 *
 * 验证：含 await 的 hook（如 413 恢复的 autoCompact）在执行**期间** emit 的
 * 事件能被消费端实时拿到，而不是攒到 hook 结束才一次性 flush——「过程开始」
 * 事件（COMPACTION start）必须在慢操作完成前到达前端。
 */

import { describe, expect, it } from 'vitest';
import { HookEventChannel } from '../core/hook-event-channel.js';
import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';

function ev(tag: string): StreamEvent {
  return { type: 'agent.stream.system_notice', payload: { content: tag, notice_type: tag } };
}

describe('HookEventChannel', () => {
  it('慢 hook 执行期间已入队的事件实时可达（不等 hook 结束）', async () => {
    const channel = new HookEventChannel();
    let releaseSlowWork: () => void;
    const slowWork = new Promise<void>((resolve) => {
      releaseSlowWork = resolve;
    });
    const work = (async () => {
      channel.push(ev('start'));
      await slowWork;
      channel.push(ev('end'));
    })();

    const received: string[] = [];
    const gen = channel.drain(work);
    // 第一个事件应在 slowWork 完成前就能拿到
    const first = await gen.next();
    received.push((first.value as StreamEvent).payload.notice_type as string);
    expect(received).toEqual(['start']);

    releaseSlowWork!();
    for await (const e of gen) {
      received.push(e.payload.notice_type as string);
    }
    expect(received).toEqual(['start', 'end']);
  });

  it('FIFO 顺序 = emit 顺序；work settle 后排空队列结束', async () => {
    const channel = new HookEventChannel();
    const work = (async () => {
      channel.push(ev('a'));
      channel.push(ev('b'));
      await Promise.resolve();
      channel.push(ev('c'));
    })();
    const seen: string[] = [];
    for await (const e of channel.drain(work)) {
      seen.push(e.payload.notice_type as string);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('work 抛错不向消费端传播（fail-soft 由调用方包在 work 内）', async () => {
    const channel = new HookEventChannel();
    const work = (async () => {
      channel.push(ev('before-throw'));
      throw new Error('boom');
    })().catch(() => {
      channel.push(ev('hook_error'));
    });
    const seen: string[] = [];
    for await (const e of channel.drain(work)) {
      seen.push(e.payload.notice_type as string);
    }
    expect(seen).toEqual(['before-throw', 'hook_error']);
  });
});
