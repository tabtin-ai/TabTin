/**
 * Wave 2（Anthropic Messages API 协议对齐）：把 proxy-provider emit 的"半成品 envelope hint"
 * 补全 envelope 公共字段（protocol_version / min_compatible_version / trace_id / _seq /
 * thread_id / message_id）后输出为完整 StreamEvent。
 *
 * 核心职责：
 *   1. 维护 query 范围内单调递增的 `_seq`（client-side counter；W3 Django relay 接管全 thread 维度的 INCR）。
 *   2. 维护"当前 message"边界——一次 LLM 调用 = 一个 message_id。retry 走新的 doRequest
 *      会产生新 envelopeState，对应新 message_id；客户端按 message_id 切换 message 容器。
 *   3. 把 `ContentBlockEnvelopeHint` 的 4 个 kind（content_block_start / delta / stop /
 *      message_delta）翻成对应 envelope event payload，再让 query.ts yield 出去。
 *      message_start / message_stop 由 query.ts 在 LLM 调用边界主动 emit（不依赖 hint）。
 *
 * 与原 blocks collector 的关系：旧 collector 已删除——Wave 2 起 blocks_json 重建职责
 * 由消费端依据 content_block_* + message_stop 序列重组（Renderer / Django relay）；
 * Daemon 不再做集中 collect。messages.jsonl 落盘改为按 envelope 序列写入（见 storage.ts §4）。
 */

import { assertMessageStartPayload } from '../contracts/message-start-assert.js';
import { ContentBlockEvents } from '../contracts/stream-events.js';
import type {
  ContentBlockDelta,
  ContentBlockStart,
  ContentBlockStop,
  ErrorInfo,
  MessageDelta,
  MessageKind,
  MessageStart,
  MessageStop,
  MessageStopReason,
  MessageUsage,
} from '../contracts/wire-payloads.js';

import type {
  StreamEvent,
  MessageStartEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
} from '../contracts/wire-protocol.js';
import { TypedAgentEvent } from '../../event/agent-event.js';
import { EventEmitter } from '../../event/event-emitter.js';
import { v4 as uuidv4 } from 'uuid';
import type {
  ContentBlock,
  ToolResultBlock,
} from '../contracts/conversation.js';
import { ToolArtifactEvent } from '../../event/events/persist-events.js';
import type {
  ContentBlockEnvelopeHint,
} from '../contracts/model-llm.js';

/**
 * @internal daemon emit `tool_artifact` mini-message 时 `model_id` / `model_name`
 * 字段的占位值。
 *
 * **业务代码禁止识别此字符串** —— 跨端识别"这条 message 是工具产物气泡"走
 * wire 层的 `message_kind === 'tool_artifact'` 字段（见
 * `@tabtin/agent-wire::MessageStartSchema.message_kind`）。本常量仅在 daemon
 * 本文件 emit 时填字段使用，不再作为跨端契约出现在 wire 层 export 路径里。
 *
 * 历史背景：W4a 阶段曾把 `'tabtin-tool-runtime'` 作为 wire 层导出的
 * `MINI_MESSAGE_MODEL_ID` 常量，让 daemon / Django / Renderer 三端按字面量
 * 识别 mini-message；五端各自靠字面量约定容易拼错 / 改字面量后 silent regress
 * （实战已踩到——dogfood 5 天内所有 widget 历史画布因 Django 端 silent skip 全部
 * 显式协议字段 `message_kind`，本字面量降级为 daemon 内部实现细节，wire 层
 * 不再暴露——本地定义保留是为了 daemon emit 时 `model_id` / `model_name` 字段
 * 仍需要一个明确的字符串占位（Anthropic 风格 envelope 这两个字段 schema 必填）。
 */
const MINI_MESSAGE_MODEL_ID_INTERNAL = 'tabtin-tool-runtime';

/**
 * daemon emit 端 self-validate 开关——dev 模式 emit 时对 MessageStart payload
 * 跑一次本地 `assertMessageStartPayload`（与 wire MessageStartSchema 角色规则
 * 对齐），让 caller 漏标 `messageKind` / 非法 `role × message_kind` 组合立即
 * throw（错误位置离根因近），而非 silent emit 后到下游消费端才发现。
 *
 * production 模式跳过——避免重复校验的性能开销（生产期信任 daemon
 * 已通过单测 + dev mode 双重门禁）。
 *
 * 设置 `process.env.TABTIN_DAEMON_EMIT_VALIDATE` 可强制启用 / 禁用，便于
 * 测试场景 override（譬如 `false` 让测试模拟"未来某个 caller 漏标"的反向 case）。
 */
const SELF_VALIDATE_ENABLED = (() => {
  const env = typeof process !== 'undefined' ? process.env.TABTIN_DAEMON_EMIT_VALIDATE : undefined;
  if (env === 'true') return true;
  if (env === 'false') return false;
  return typeof process === 'undefined' ? true : process.env.NODE_ENV !== 'production';
})();

/**
 * EnvelopeEmitter 实例化范围 = 单次 query() 调用。`_seq` 在 query 范围内单调；
 * `traceId` / `threadId` 取自 runQuery 顶层。
 *
 * `currentMessageId` 由 `beginMessage()` 设置——在每轮 LLM 调用（callModel）开始
 * 之前 query.ts 必须先 emit message_start，绑定一个 messageId；retry 不会调
 * `beginMessage`（保留同一个 messageId，让消费端在 retry 期间能 reconcile）。
 *
 * 调用顺序（每轮 LLM 调用）：
 *   1. emitter.beginMessage(modelId, modelName) → yield message_start envelope
 *   2. 主循环消费 chunk + flushHints（hint 来自 proxy-provider）
 *   3. emitter.endMessage(stopReason, usage?) → yield 残余 message_delta + message_stop
 */
export class EnvelopeEmitter {
  private currentMessageId: string | null;
  private readonly runId: string;
  private readonly subagentRunId: string | undefined;
  private readonly events: EventEmitter;
  /** Hint buffer：proxy-provider 在 SSE 解析时同步 push，主循环每个 chunk 之间 flush。 */
  private readonly hintQueue: ContentBlockEnvelopeHint[];
  /**
   * 当前 message 内尚未 `content_block_stop` 的 block index。
   * stall retry 切 message 前必须先 close，否则 Renderer case 3 会把完整
   * thinking 误标 `partial` +「…内容被截断」。
   */
  private readonly openBlockIndexes: Set<number>;

  constructor(args: {
    traceId: string;
    threadId: string;
    runId: string;
    subagentRunId?: string;
    /** 起始 _seq；默认 0。跨 query 实例不共享（见模块顶部说明）。 */
    initialSeq?: number;
  }) {
    this.currentMessageId = null;
    this.runId = args.runId;
    this.subagentRunId = args.subagentRunId;
    this.events = new EventEmitter(undefined, {
      traceId: args.traceId,
      threadId: args.threadId,
      runId: args.runId,
      subagentRunId: args.subagentRunId,
    }, args.initialSeq ?? 0);
    this.hintQueue = [];
    this.openBlockIndexes = new Set();
  }

  /** 六件套唯一包装入口：保留 public wire interface 的 payload 类型约束。 */
  private event<TEvent extends StreamEvent>(
    type: TEvent['type'],
    payload: TEvent['payload'],
  ): TEvent {
    return this.events.build<TEvent>(
      new TypedAgentEvent<TEvent>(type, payload, undefined, true),
    );
  }

  /** proxy-provider 注入的 onContentBlockEvent 回调——只 push 到 buffer，不做 yield。 */
  pushHint(hint: ContentBlockEnvelopeHint): void {
    this.hintQueue.push(hint);
  }

  /**
   * 当前 messageId（仅在 beginMessage 之后非空）。
   * 主循环必要时（如 message_stop 携带 persisted_id）需要读取。
   */
  get messageId(): string | null {
    return this.currentMessageId;
  }

  /** 公共字段补全 helper —— 返回完整 envelope base + event_type。 */
  private envelopeBase(): {
    protocol_version: 'v2';
    min_compatible_version: 'v2';
    trace_id: string;
    _seq: number;
    thread_id: string;
    arrival_seq: number;
    event_id: string;
    run_id: string;
    subagent_run_id?: string;
  } {
    return this.events.envelopeFields(true) as ReturnType<EnvelopeEmitter['envelopeBase']>;
  }

  /**
   * 开启新一轮 LLM 调用——生成 messageId 并 emit message_start envelope。
   *
   * **幂等**：若当前已有 active message（fallback retry / 413 recovery 等错误后
   * `state.iteration++; continue;` 路径回到主循环顶部时 messageId 仍非空，意味着
   * 同一条 LLM 助手回复仍在累积），返回空数组——caller 知道 messageId 复用即可。
   * stall retry / max_tokens continuation / tool_use 进下一轮等需要"切到新 message"
   * 的路径，由 caller 显式调 `endMessage` close 后再调 `beginMessage` 开新的。
   *
   * 返回空 array（已有 active）或单元素 array（首次 begin）；caller 用 `for (...) yield`
   * 模式安全展开。
   */
  beginMessage(args: {
    messageId: string;
    modelId: string;
    modelName: string;
    role?: 'assistant' | 'user' | 'system';
    /**
     * 消息级语义分类（**必填**）——caller 必须显式标识该 message_start emit 的
     * 是 LLM 真实输出（`'llm'`）、daemon 自合成的错误文案气泡（`'error_envelope'`）
     * 还是工具产物 mini-message（`'tool_artifact'`，通常走 {@link emitDetachedMiniMessage}
     * 自动标记，不会经过本入口）。
     *
     * 详见 `@tabtin/agent-wire::MessageKindSchema` docstring + wire 层
     * `superRefine` 校验 role × message_kind 9 组合里的 3 个非法组合。
     */
    messageKind: MessageKind;
  }): StreamEvent[] {
    if (this.currentMessageId !== null) return [];
    this.currentMessageId = args.messageId;
    const payload: MessageStart = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_START,
      message_id: args.messageId,
      role: args.role ?? 'assistant',
      model_id: args.modelId,
      model_name: args.modelName,
      started_at: new Date().toISOString(),
      run_id: this.runId,
      message_kind: args.messageKind,
      ...(this.subagentRunId ? { subagent_run_id: this.subagentRunId } : {}),
    };
    if (SELF_VALIDATE_ENABLED) assertMessageStartPayload(payload);
    return [this.event<MessageStartEvent>(
      ContentBlockEvents.MESSAGE_START,
      payload as MessageStartEvent['payload'],
    )];
  }

  /**
   * 在 message_stop 之前补一条 `message_delta(delta.stop_reason=...)`。
   *
   * Anthropic 协议把 `stop_reason` 放在 `message_delta.delta.stop_reason`，
   * `message_stop` 只是终结信号。proxy-provider 正常路径下 SSE 上游会自带
   * 一条 message_delta hint；但 abort / classified error 等异常路径上游 SSE
   * 还没来得及 emit message_delta 就被中断，此时由 query.ts 调用本 helper
   * 主动补一条，确保 jsonl 落盘的 envelope 序列里 stop_reason 信号不丢。
   *
   * 必须在已有 active message（currentMessageId !== null）的状态下调用。
   */
  emitStopReason(reason: string, usage?: MessageUsage): StreamEvent {
    if (this.currentMessageId === null) {
      throw new Error(
        '[envelope-emitter] emitStopReason called without prior beginMessage; '
          + 'caller must guard with envelopeEmitter.messageId !== null',
      );
    }
    const payload: MessageDelta = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_DELTA,
      message_id: this.currentMessageId,
      delta: { stop_reason: reason as MessageStopReason },
      ...(usage ? { usage } : {}),
    };
    return this.event<MessageDeltaEvent>(
      ContentBlockEvents.MESSAGE_DELTA,
      payload as MessageDeltaEvent['payload'],
    );
  }

  /**
   * 关闭当前 message —— emit message_stop envelope。
   *
   * `persistedId` 与 `blockIdOverrides` 在 W2 阶段为空（落库流程在 W3 Django 接管时填）。
   * 调用方负责把可能残留的 message_delta（usage / stop_reason）通过 flushHints 先 emit 完。
   *
   * **W4.5 第二波 P0-1（2026-05-12）** · `errorInfo` 参数：
   *
   * abort / runtime error / daemon 主动兜底等异常路径上 caller 显式传入
   * `errorInfo`，把"为何被打成 partial"的真信号附在 `message_stop.error_info`
   * 字段透传到下游。下游链路：
   *   - Daemon emit → IPC envelope event
   *   - Django `content_block_reassembler._on_message_stop` 读 `evt.error_info`
   *     落到 `_MessageState.message_stop_partial_reason`
   *   - Django `derive_error_info(message_stop_partial_reason=...)` 优先用
   *     daemon emit 的真信号；缺省时 fall back W4c R6-P0-1 启发式（stop_reason / aborted）
   *   - DB `chat_message.error_info_json.partial_reason` 持久化
   *   - Renderer `contentBlockHandler.handleMessageStop` 直播路径读
   *     `event.error_info?.partial_reason` 透传给 store messageStop({ partialReason })
   *   - Renderer `legacyBlocksAdapter::inferPartialReasonFromSignals` 历史回放
   *     路径读 `errorInfoJson.partial_reason` —— forward-compatible 早已写好
   *
   * 三档语义（见 stream-content-block.ts::PartialReasonSchema docstring）：
   *   - `aborted` — 用户主动 abort，UI 渲染"已中断"
   *   - `stream_interrupted` — 网络 / SSE 中断、stream 卡住超时，UI 渲染"内容被截断"
   *   - `message_stop_fallback` — daemon 主动收尾兜底（context_overflow / grace 等），
   *     UI 渲染"…内容被截断"。**stall retry 切 message 不再挂本档**（：
   *     先 `closeOpenBlocks` 再干净 `endMessage()`，避免完整 thinking 被误标截断）
   */
  endMessage(args?: {
    persistedId?: string;
    blockIdOverrides?: Record<string, string>;
    errorInfo?: ErrorInfo;
  }): StreamEvent {
    if (this.currentMessageId === null) {
      throw new Error(
        '[envelope-emitter] endMessage called without prior beginMessage; '
          + 'each LLM call must emit message_start first',
      );
    }
    const messageId = this.currentMessageId;
    this.currentMessageId = null;
    this.openBlockIndexes.clear();
    const payload: MessageStop = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_STOP,
      message_id: messageId,
      ...(args?.persistedId ? { persisted_id: args.persistedId } : {}),
      ...(args?.blockIdOverrides ? { block_id_overrides: args.blockIdOverrides } : {}),
      ...(args?.errorInfo ? { error_info: args.errorInfo } : {}),
    };
    return this.event<MessageStopEvent>(
      ContentBlockEvents.MESSAGE_STOP,
      payload as MessageStopEvent['payload'],
    );
  }

  /**
   * ：为仍 open 的 content block 补发 `content_block_stop`。
   *
   * stall retry / 主动切 message 前由 caller flushHints 后再调本方法，
   * 避免 `message_stop` 撞上 `finalized=false` 被 Renderer 标「…内容被截断」。
   * 无 open block 或无 active message 时返回空数组。
   */
  closeOpenBlocks(): StreamEvent[] {
    if (this.currentMessageId === null || this.openBlockIndexes.size === 0) {
      return [];
    }
    const messageId = this.currentMessageId;
    const indexes = [...this.openBlockIndexes].sort((a, b) => a - b);
    const events: StreamEvent[] = [];
    for (const index of indexes) {
      const payload: ContentBlockStop = {
        ...this.envelopeBase(),
        event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
        message_id: messageId,
        index,
      };
      events.push(this.event<ContentBlockStopEvent>(
        ContentBlockEvents.CONTENT_BLOCK_STOP,
        payload as ContentBlockStopEvent['payload'],
      ));
    }
    this.openBlockIndexes.clear();
    return events;
  }

  /**
   * 把 hint buffer 内的 hint 全部翻成完整 envelope event 返回（清空 buffer）。
   *
   * 调用方应在每个 chunk 处理之间 flush（也可在循环结束、close stream 之前 flush）。
   * 返回的 event 数组按 hint push 顺序，与上游 SSE 顺序一致；`_seq` 单调递增。
   *
   * **特例**：proxy-provider 的 message_start / message_stop hint 在 W2 阶段被忽略——
   * query.ts 已经在 LLM 调用边界主动 beginMessage / endMessage，proxy-provider 自己
   * emit 这两个 hint 仅用于让 ContentBlockEvents 6 件套 audit anchor 完整。
   */
  flushHints(): StreamEvent[] {
    if (this.hintQueue.length === 0) return [];
    if (this.currentMessageId === null) {
      throw new Error(
        '[envelope-emitter] hint flushed before beginMessage; '
          + 'proxy-provider hint pipeline requires currentMessageId',
      );
    }
    const messageId = this.currentMessageId;
    const events: StreamEvent[] = [];
    for (const hint of this.hintQueue) {
      switch (hint.kind) {
        case ContentBlockEvents.MESSAGE_START:
        case ContentBlockEvents.MESSAGE_STOP:
          // 见 docstring：proxy-provider 的 message_start / message_stop hint 在
          // W2 由 query.ts 主动控制，这里直接 drop 不重复 emit。保留 audit anchor
          // 完整性见 proxy-provider.ts 头部 `ENVELOPE_HINT_KINDS` 注释。
          break;
        case ContentBlockEvents.MESSAGE_DELTA: {
          const payload: MessageDelta = {
            ...this.envelopeBase(),
            event_type: ContentBlockEvents.MESSAGE_DELTA,
            message_id: messageId,
            delta: {
              ...(hint.delta.stop_reason
                ? { stop_reason: hint.delta.stop_reason as MessageStopReason }
                : {}),
              ...(hint.delta.stop_sequence !== undefined
                ? { stop_sequence: hint.delta.stop_sequence }
                : {}),
            },
            ...(hint.usage ? { usage: hint.usage as MessageUsage } : {}),
          };
          events.push(this.event<MessageDeltaEvent>(
            ContentBlockEvents.MESSAGE_DELTA,
            payload as MessageDeltaEvent['payload'],
          ));
          break;
        }
        case ContentBlockEvents.CONTENT_BLOCK_START: {
          this.openBlockIndexes.add(hint.index);
          const payload: ContentBlockStart = {
            ...this.envelopeBase(),
            event_type: ContentBlockEvents.CONTENT_BLOCK_START,
            message_id: messageId,
            index: hint.index,
            block_id: hint.block_id,
            block: hint.block,
          };
          events.push(this.event<ContentBlockStartEvent>(
            ContentBlockEvents.CONTENT_BLOCK_START,
            payload as ContentBlockStartEvent['payload'],
          ));
          break;
        }
        case ContentBlockEvents.CONTENT_BLOCK_DELTA: {
          const payload: ContentBlockDelta = {
            ...this.envelopeBase(),
            event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            message_id: messageId,
            index: hint.index,
            delta: hint.delta,
          };
          events.push(this.event<ContentBlockDeltaEvent>(
            ContentBlockEvents.CONTENT_BLOCK_DELTA,
            payload as ContentBlockDeltaEvent['payload'],
          ));
          break;
        }
        case ContentBlockEvents.CONTENT_BLOCK_STOP: {
          this.openBlockIndexes.delete(hint.index);
          const payload: ContentBlockStop = {
            ...this.envelopeBase(),
            event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
            message_id: messageId,
            index: hint.index,
          };
          events.push(this.event<ContentBlockStopEvent>(
            ContentBlockEvents.CONTENT_BLOCK_STOP,
            payload as ContentBlockStopEvent['payload'],
          ));
          break;
        }
        default: {
          // exhaustive check —— 新加 hint kind 时编译期立刻失败
          const _exhaustive: never = hint;
          void _exhaustive;
        }
      }
    }
    this.hintQueue.length = 0;
    return events;
  }

  /**
   * 强制注入一个完整的 ContentBlock 三件套（start + 单 delta + stop），用于
   * 工具产出的 `tabtin_rich_content` block —— 这类块由本地工具（非 LLM）产出，
   * 不经 SSE，因此走单独的"主动 emit"通道（见 query.ts 工具结果回灌段落）。
   *
   * 返回的 events 按顺序：[content_block_start, content_block_delta, content_block_stop]。
   * 调用方负责将其 yield 出去。**注意**：调用前必须 beginMessage 已经执行（currentMessageId 非空）。
   */
  emitInlineBlock(args: {
    blockId: string;
    block: ContentBlockStart['block'];
    deltaPayload?: ContentBlockDelta['delta'];
    /**
     * 当前 active 块的 index —— W2 设计：runtime 内部不维护"工具回灌块的全局 index"，
     * 由调用方传入（通常是 query.ts 内单调递增的 `inlineBlockIndex` 计数器）。
     */
    index: number;
  }): StreamEvent[] {
    if (this.currentMessageId === null) {
      throw new Error(
        '[envelope-emitter] emitInlineBlock called without beginMessage; '
          + 'inline blocks require an active message',
      );
    }
    const messageId = this.currentMessageId;
    const events: StreamEvent[] = [];
    events.push(this.event<ContentBlockStartEvent>(
      ContentBlockEvents.CONTENT_BLOCK_START,
      {
        ...this.envelopeBase(),
        event_type: ContentBlockEvents.CONTENT_BLOCK_START,
        message_id: messageId,
        index: args.index,
        block_id: args.blockId,
        block: args.block,
      } as ContentBlockStartEvent['payload'],
    ));
    if (args.deltaPayload) {
      events.push(this.event<ContentBlockDeltaEvent>(
        ContentBlockEvents.CONTENT_BLOCK_DELTA,
        {
          ...this.envelopeBase(),
          event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
          message_id: messageId,
          index: args.index,
          delta: args.deltaPayload,
        } as ContentBlockDeltaEvent['payload'],
      ));
    }
    events.push(this.event<ContentBlockStopEvent>(
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      {
        ...this.envelopeBase(),
        event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
        message_id: messageId,
        index: args.index,
      } as ContentBlockStopEvent['payload'],
    ));
    return events;
  }

  /**
   * 工具产出的 inline 块（如 `tabtin_rich_content`）注入通道——不修改主 message
   * 状态，自己生成 messageId 包装为一个独立的 5 件套 mini-message：
   *   message_start (role) → content_block_start → [content_block_delta] →
   *   content_block_stop → message_stop(end_turn)
   *
   * 与 emitInlineBlock 的区别：emitInlineBlock 寄生在主 message 内（要求
   * currentMessageId 非空，index 由调用方递增）；emitDetachedMiniMessage 完全
   * 脱离主 message —— 用于 runTools 期间（assistant message 已 stop、下一轮
   * LLM 还没开始）从工具产出 stream event 给 UI 立刻渲染。
   *
   * `_seq` 仍走 query 范围内单调 counter（共享 envelopeBase），保证消费端按
   * `_seq` 排序后能跟主 message 流自然交织。
   *
   * `message_kind` 固定为 `'tool_artifact'`（不暴露给 caller）——这是 daemon
   * 工具产出路径的唯一 emit 入口，消费端按 `message_kind === 'tool_artifact'`
   * 识别"产物气泡"并走紧凑形态（无 footer / 无 MessageActions / 紧贴上一条
   * LLM 消息）。`model_id` 仍填占位字符串（envelope schema 要求非空），
   * 但**业务代码不应再依赖该字符串识别 mini-message**——详见本文件顶部
   * {@link MINI_MESSAGE_MODEL_ID_INTERNAL} docstring。
   */
  emitDetachedMiniMessage(args: {
    role?: 'user' | 'assistant';
    block: ContentBlockStart['block'];
    deltaPayload?: ContentBlockDelta['delta'];
    /**
     * 可选自定义 messageId。**默认必须是合法 UUID4**——下游 Django reassembler
     * `relay_message_writer.py:702-708` 用 `uuid.UUID(message_id)` 强校验 +
     * silently skip，非 UUID 入参会让本条 mini-message 永久丢失。
     *
     * 历史教训（2026-05-23 dogfood 复盘）：原默认 `` `msg_inline_${generateUUID()}` ``
     * 加前缀让整个字符串变成非 UUID，导致 Django reassembler 静默跳过所有
     * widget / search_results / cli_output_* 等 mini-message——重启 Electron 后
     * 历史回放时富内容卡片全部消失。同时 LLM 主消息 + user message 都直接走
     * `generateUUID()`（query.ts L1803/L3089）落库正常，bug 只发生在 mini-message
     * 路径。修复后 default 走 `generateUUID()` 与主路径对齐。
     *
     * 消费端识别"工具产物气泡"走 envelope payload 里的 `message_kind: 'tool_artifact'`
     * 字段（见下方 `startPayload` 构造），**不再依赖** message_id 前缀做字符串
     * startsWith 判断；caller 也不应再为"易识别"传 `msg_inline_xxx` 字面量。
     */
    messageId?: string;
    /**
     * 可选自定义 blockId（默认 `block_<uuid>`）。block_id 是 ContentBlock
     * 内字段，写入 `ChatMessage.content_blocks_json` 数组里的 dict——存为字符串，
     * 不走 UUID 校验，所以保留 `block_` 前缀语义化无副作用。
     */
    blockId?: string;
  }): StreamEvent[] {
    return this.emitPersistedInlineMessage({
      role: args.role,
      block: args.block as unknown as ContentBlock,
      deltaPayload: args.deltaPayload,
      messageId: args.messageId,
      blockId: args.blockId,
    });
  }

  /**
   * 可见事实型 inline message 的统一 emit 入口。
   *
   * 这类事件同时服务两个消费者：
   *   - live UI：读取 message_start / content_block_* / message_stop 立即渲染；
   *   - 历史恢复：只信 persist_message 写入的 message blocks。
   *
   * 调用方只允许表达"我要发一个可见事实 message"，不再手写 live 事件链后自行记得
   * 补 persist_message。这样能把「实时可见事实必须落 message」收敛成 runtime
   * 协议层不变量。
   */
  emitPersistedInlineMessage(args: {
    role?: 'user' | 'assistant';
    block: ContentBlock;
    deltaPayload?: ContentBlockDelta['delta'];
    messageId?: string;
    blockId?: string;
    modelId?: string;
    modelName?: string;
  }): StreamEvent[] {
    // 默认与 query.ts L1803 / L3089 主消息路径同款 `generateUUID()`——保证
    // Django reassembler 的 `uuid.UUID(message_id)` 强校验通过，mini-message
    // 能落 ChatMessage 表。详见上方 messageId jsdoc。
    const messageId = args.messageId ?? uuidv4();
    const blockId = args.blockId ?? `block_${uuidv4()}`;
    const role = args.role ?? 'assistant';
    const modelId = args.modelId ?? MINI_MESSAGE_MODEL_ID_INTERNAL;
    const modelName = args.modelName ?? modelId;
    const events: StreamEvent[] = [];

    const startPayload: MessageStart = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_START,
      message_id: messageId,
      role,
      // 占位字符串——业务代码识别"工具产出 mini-message"走下方 message_kind
      // 字段，不再依赖 model_id 字面量。详见文件顶部 MINI_MESSAGE_MODEL_ID_INTERNAL
      // docstring。
      model_id: modelId,
      model_name: modelName,
      started_at: new Date().toISOString(),
      run_id: this.runId,
      // 跨端识别工具产物气泡的显式协议字段——五端按 message_kind switch
      // 决定视觉形态（Renderer 走紧凑产物气泡 / Django reassembler 独立落库
      // 为 message_kind='tool_artifact' 行 / mobile 显示"产物加载中…"占位）。
      message_kind: 'tool_artifact',
      ...(this.subagentRunId ? { subagent_run_id: this.subagentRunId } : {}),
    };
    if (SELF_VALIDATE_ENABLED) assertMessageStartPayload(startPayload);
    events.push(this.event<MessageStartEvent>(
      ContentBlockEvents.MESSAGE_START,
      startPayload as MessageStartEvent['payload'],
    ));

    const blockStartPayload: ContentBlockStart = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.CONTENT_BLOCK_START,
      message_id: messageId,
      index: 0,
      block_id: blockId,
      block: args.block as ContentBlockStart['block'],
    };
    events.push(this.event<ContentBlockStartEvent>(
      ContentBlockEvents.CONTENT_BLOCK_START,
      blockStartPayload as ContentBlockStartEvent['payload'],
    ));

    if (args.deltaPayload) {
      const deltaPayload: ContentBlockDelta = {
        ...this.envelopeBase(),
        event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
        message_id: messageId,
        index: 0,
        delta: args.deltaPayload,
      };
      events.push(this.event<ContentBlockDeltaEvent>(
        ContentBlockEvents.CONTENT_BLOCK_DELTA,
        deltaPayload as ContentBlockDeltaEvent['payload'],
      ));
    }

    const blockStopPayload: ContentBlockStop = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
      message_id: messageId,
      index: 0,
    };
    events.push(this.event<ContentBlockStopEvent>(
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      blockStopPayload as ContentBlockStopEvent['payload'],
    ));

    const messageStopPayload: MessageStop = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_STOP,
      message_id: messageId,
    };
    events.push(this.event<MessageStopEvent>(
      ContentBlockEvents.MESSAGE_STOP,
      messageStopPayload as MessageStopEvent['payload'],
    ));

    // 工具产物气泡落库唯一权威 = persist_message（与主 LLM / 子代理同一管线）。
    // 六件套只驱动 live UI；持久化（Django ChatMessage + 本地 message-blocks.jsonl）
    // 由这条 persist 产生，保证「落库 = jsonl」一致，且本机会话冷启动可恢复富内容卡。
    events.push(this.buildToolArtifactPersist(messageId, [args.block], role));

    return events;
  }

  /**
   * 构造工具产物 mini-message（`message_kind='tool_artifact'`）的 persist_message。
   * 一次性 `emitDetachedMiniMessage` 与流式 mini-message 收尾共用，保证落库权威一致。
   */
  buildToolArtifactPersist(
    messageId: string,
    blocks: ContentBlock[],
    role: 'assistant' | 'user' = 'assistant',
  ): StreamEvent {
    // 单一构造真相 = ToolArtifactEvent 类；arrival_seq 由 egress 盖（与旧 nextArrivalSeq 等价）。
    return new ToolArtifactEvent({
      messageId,
      blocks,
      agentRunId: this.runId,
      role,
      ...(this.subagentRunId ? { subagentRunId: this.subagentRunId } : {}),
    }).toStreamEvent();
  }

  /**
   * 流式 detached mini-message 的底层事件构造器（ digest 流式）。
   *
   * 与 {@link emitDetachedMiniMessage}（一次性 5 件套）的区别：把
   * message_start / content_block_start / content_block_delta /
   * content_block_stop / message_stop 拆成独立方法，让调用方（query.ts 的
   * streaming mini-message helper）跨多次 delta 逐个 emit——实现工具内部再调
   * LLM 时把过程 / 结论 token-by-token 显示的真流式。产出全部是标准
   * content_block 事件（`message_kind='tool_artifact'`），与普通消息同构落进
   * `messagesBySessionId`，用现成 thinking / text 块渲染，**不新增 wire 事件、
   * 不建独立 store / 面板**。
   *
   * 这些方法是 detached（自带 `messageId`、不碰 `currentMessageId`），可在
   * runTools 阶段（主 message 已 stop）安全使用；`index` 由调用方维护并传入。
   */
  emitDetachedMessageStart(messageId: string, role: 'assistant' | 'user' = 'assistant'): StreamEvent {
    const payload: MessageStart = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_START,
      message_id: messageId,
      role,
      model_id: MINI_MESSAGE_MODEL_ID_INTERNAL,
      model_name: MINI_MESSAGE_MODEL_ID_INTERNAL,
      started_at: new Date().toISOString(),
      run_id: this.runId,
      message_kind: 'tool_artifact',
      ...(this.subagentRunId ? { subagent_run_id: this.subagentRunId } : {}),
    };
    if (SELF_VALIDATE_ENABLED) assertMessageStartPayload(payload);
    return this.event<MessageStartEvent>(
      ContentBlockEvents.MESSAGE_START,
      payload as MessageStartEvent['payload'],
    );
  }

  emitDetachedBlockStart(
    messageId: string,
    index: number,
    blockId: string,
    block: ContentBlockStart['block'],
  ): StreamEvent {
    const payload: ContentBlockStart = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.CONTENT_BLOCK_START,
      message_id: messageId,
      index,
      block_id: blockId,
      block,
    };
    return this.event<ContentBlockStartEvent>(
      ContentBlockEvents.CONTENT_BLOCK_START,
      payload as ContentBlockStartEvent['payload'],
    );
  }

  emitDetachedBlockDelta(
    messageId: string,
    index: number,
    delta: ContentBlockDelta['delta'],
  ): StreamEvent {
    const payload: ContentBlockDelta = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      message_id: messageId,
      index,
      delta,
    };
    return this.event<ContentBlockDeltaEvent>(
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      payload as ContentBlockDeltaEvent['payload'],
    );
  }

  emitDetachedBlockStop(messageId: string, index: number): StreamEvent {
    const payload: ContentBlockStop = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
      message_id: messageId,
      index,
    };
    return this.event<ContentBlockStopEvent>(
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      payload as ContentBlockStopEvent['payload'],
    );
  }

  emitDetachedMessageStop(messageId: string): StreamEvent {
    const payload: MessageStop = {
      ...this.envelopeBase(),
      event_type: ContentBlockEvents.MESSAGE_STOP,
      message_id: messageId,
    };
    return this.event<MessageStopEvent>(
      ContentBlockEvents.MESSAGE_STOP,
      payload as MessageStopEvent['payload'],
    );
  }

  /** 调试 / 测试用：当前 _seq 值（下一次 envelope event 将使用 +1 后的值）。 */
  get currentSeq(): number {
    return this.events.currentSeq;
  }
}

// ─── Envelope 收尾 helpers（ 批次 6g，自 query.ts 迁入）─────────────
//
// 主循环在迭代边界 / 终态错误 / 工具结果回灌时对 envelope 的三种收尾姿势。
// 归 wire 域：它们只关心 envelope 协议形态，不做任何控制流决策。

/** flush hints + 关闭当前 message envelope（若开着）。 */
export function* closeCurrentEnvelope(
  envelopeEmitter: EnvelopeEmitter,
): Generator<StreamEvent, void, undefined> {
  for (const ev of envelopeEmitter.flushHints()) yield ev;
  if (envelopeEmitter.messageId !== null) {
    yield envelopeEmitter.endMessage();
  }
}

/** 终态错误（abort / runtime error）时带 errorInfo 收尾 envelope。 */
export function* closeEnvelopeForTerminalError(args: {
  envelopeEmitter: EnvelopeEmitter;
  stopReason: 'aborted' | 'error';
  errorInfo: Parameters<EnvelopeEmitter['endMessage']>[0];
}): Generator<StreamEvent, void, undefined> {
  for (const ev of args.envelopeEmitter.flushHints()) yield ev;
  if (args.envelopeEmitter.messageId === null) return;
  yield args.envelopeEmitter.emitStopReason(args.stopReason);
  yield args.envelopeEmitter.endMessage(args.errorInfo);
}

/** 工具结果回灌：独立 user-role envelope 逐块 emit tool_result。 */
export function* emitToolResultEnvelope(args: {
  toolResultBlocks: ToolResultBlock[];
  envelopeEmitter: EnvelopeEmitter;
  model: string;
}): Generator<StreamEvent, void, undefined> {
  if (args.toolResultBlocks.length === 0) return;
  if (args.envelopeEmitter.messageId !== null) {
    for (const ev of args.envelopeEmitter.flushHints()) yield ev;
    yield args.envelopeEmitter.endMessage();
  }
  const toolResultMessageId = uuidv4();
  for (const ev of args.envelopeEmitter.beginMessage({
    messageId: toolResultMessageId,
    modelId: args.model,
    modelName: args.model,
    role: 'user',
    messageKind: 'llm',
  })) yield ev;
  for (let i = 0; i < args.toolResultBlocks.length; i++) {
    yield* emitOneToolResultEnvelopeBlock(args.envelopeEmitter, args.toolResultBlocks[i]!, i);
  }
  yield args.envelopeEmitter.endMessage();
}

function* emitOneToolResultEnvelopeBlock(
  envelopeEmitter: EnvelopeEmitter,
  src: ToolResultBlock,
  index: number,
): Generator<StreamEvent, void, undefined> {
  const wireContent: string = typeof src.content === 'string'
    ? src.content
    : JSON.stringify(src.content);
  for (const ev of envelopeEmitter.emitInlineBlock({
    blockId: `blk_${uuidv4()}`,
    block: {
      type: 'tool_result',
      tool_use_id: src.tool_use_id,
      content: wireContent,
      ...(src.is_error ? { is_error: true } : {}),
    },
    index,
  })) yield ev;
}
