/**
 * 工具流发射器。自 query.ts 的 QueryRun 抽出为协作类——
 * 承载 rich content 块、以及工具错误 tool_result envelope 的构造与 emit。
 *
 * ：删除无生产调用方的 `openStreamingMiniMessage` / `tool_stream_id`
 * 隔离路径；工具内部流式 transcript 基建未接 UI，不再保留热路径。
 *
 * 只依赖注入的 EnvelopeEmitter / EngineConfig / 当前模型名 getter，与 QueryRun
 * 主循环解耦；QueryRun 持有一个实例并把公开入口委托给它。
 */
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { EnvelopeEmitter } from './envelope-emitter.js';
import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';
import type {
  ToolContext,
} from '../contracts/tools.js';
import type {
  EngineConfig,
} from '../contracts/kernel.js';

export class ToolStreamEmitter {
  constructor(
    private readonly envelopeEmitter: EnvelopeEmitter,
    private readonly config: EngineConfig,
    private readonly getModel: () => string,
  ) {}

  makeRichContentBlockEmitter(): NonNullable<ToolContext['emitRichContentBlock']> {
    return (args) => {
      const sink = this.config.emitStreamEvent;
      if (!sink) return;
      try {
        for (const ev of this.envelopeEmitter.emitDetachedMiniMessage({
          role: 'assistant',
          block: {
            type: 'tabtin_rich_content',
            kind: args.kind,
            summary: args.summary,
            ...(args.groupId ? { group_id: args.groupId } : {}),
            ...(args.payload ? { payload: args.payload } : {}),
          },
        })) sink(ev);
      } catch (err) {
        this.warnRichContentBlockError(err, args.kind);
      }
    };
  }

  private warnRichContentBlockError(err: unknown, kind: string): void {
    try {
      (this.config as { logger?: { warn?: (msg: string, meta?: unknown) => void } })
        .logger?.warn?.('emitRichContentBlock failed', {
          error: err instanceof Error ? err.message : String(err),
          kind,
        });
    } catch { /* swallow */ }
  }

  *emitToolErrorEnvelope(args: {
    toolUseId: string;
    errDetail: string;
    errorKind: string;
    aborted?: boolean;
  }): Generator<StreamEvent, void, undefined> {
    void args.errorKind;
    void args.aborted;
    yield* this.envelopeEmitter.beginMessage({
      messageId: nodeRandomUUID(),
      modelId: this.getModel(),
      modelName: this.getModel(),
      role: 'user',
      messageKind: 'llm',
    });
    yield* this.envelopeEmitter.emitInlineBlock({
      blockId: `blk_${nodeRandomUUID()}`,
      block: {
        type: 'tool_result',
        tool_use_id: args.toolUseId,
        content: args.errDetail,
        is_error: true,
      },
      index: 0,
    });
    yield this.envelopeEmitter.endMessage();
  }
}
