/**
 * ContentBlock 六件套事件构造。
 *
 * 对外实时路径由 `EnvelopeEmitter` 负责完整 wire payload；SessionStorage 的 record*
 * 路径先构造最小 envelope，再由 `_writeEnvelopeEntry` 补 protocol/trace/thread/_seq。
 * 两条路径都通过 AgentEvent 类，不再直接拼 `{type,payload}`。
 */

import { ContentBlockEvents } from '../../engine/contracts/stream-events.js';
import { AgentEvent } from '../agent-event.js';

export type ContentEnvelopeType =
  | typeof ContentBlockEvents.MESSAGE_START
  | typeof ContentBlockEvents.MESSAGE_DELTA
  | typeof ContentBlockEvents.MESSAGE_STOP
  | typeof ContentBlockEvents.CONTENT_BLOCK_START
  | typeof ContentBlockEvents.CONTENT_BLOCK_DELTA
  | typeof ContentBlockEvents.CONTENT_BLOCK_STOP;

/** SessionStorage record* 使用的最小六件套事件；公共 envelope 字段由 storage 出口补齐。 */
export class StoredContentEvent extends AgentEvent {
  constructor(
    readonly type: ContentEnvelopeType,
    private readonly payload: Record<string, unknown>,
  ) {
    super();
  }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}
