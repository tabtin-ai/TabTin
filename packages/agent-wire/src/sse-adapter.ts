/**
 * SSE event adapter for CLI streaming.
 *
 * Maps WS Gateway `agent.stream.*` events to flat SSE event objects
 * for CLI consumption. Used by both Electron and Daemon CLI servers
 * to ensure identical SSE output regardless of which engine the CLI
 * is connected to.
 *
 * Wire format: `event: <type>\ndata: <json>\n\n`
 * where `type` is the SSE event name and `json` is the data object.
 */

const STREAM_EVENT_PREFIX = 'agent.stream.';

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Map a WS Gateway envelope (`agent.stream.*`) to an SSE event object.
 *
 * Returns an `SseEvent` with a short `type` name suitable for
 * `event: <type>` in the SSE wire format.
 *
 * Unknown event types are transparently forwarded with their short
 * type name, ensuring new Backend events are visible to CLI consumers
 * without requiring adapter updates.
 */
export function mapWsEventToSse(envelope: {
  type?: string;
  thread_id?: string;
  payload?: Record<string, any>;
}): SseEvent | null {
  const eventType: string = envelope.type || '';
  if (!eventType.startsWith(STREAM_EVENT_PREFIX)) return null;

  const payload: Record<string, any> = envelope.payload || {};
  const shortType = eventType.slice(STREAM_EVENT_PREFIX.length);

  switch (shortType) {
    case 'assistant': {
      // **W4.5 第三波 C1（2026-05-13）保留**：lite-blocks-collector 临时桥仍 inject
      // `agent.stream.assistant(phase='final')`，CLI 通过本 case 拿到 final 文本。
      // 待 W4c-Django-reconstructor 上线 + lite-collector 桥沉默后，本 case 可清。
      // delta / done 分支理论上 daemon 不再发，保留以保 SSE adapter 行为可逆。
      if (payload.phase === 'delta') {
        return { type: 'text_delta', content: payload.content || '' };
      }
      if (payload.phase === 'done' || payload.phase === 'final') {
        return { type: 'text_done', content: payload.content || '' };
      }
      return null;
    }

    // ── W4.5 第三波 C1（2026-05-13）老协议 case 物理删 ──
    // 删除：reasoning / tool
    // wire 层 `StreamEvents.REASONING/TOOL` 同步物理删，daemon 0 emit。CLI 端
    // SSE 输出"思考 / 工具调用"信号未来若需要，应走 ContentBlock 6 件套
    // (`content_block_*`) 直接消费，与 mobile/Renderer 同源。

    case 'done':
      return {
        type: 'done',
        thread_id: envelope.thread_id || payload.thread_id || '',
        usage: payload.usage || undefined,
      };

    case 'lifecycle':
      return { type: 'status', message: payload.phase || payload.status || payload.message || '' };

    case 'step':
      // **C1 范围外保留**：daemon `query.ts` 仍 emit thinking 步骤事件给 W5/W6 mobile。
      return {
        type: 'status',
        message: payload.title || payload.description || payload.message || `Step ${payload.step_id || ''}`,
      };

    case 'persist_error':
      return { type: 'error', message: payload.error || 'State persistence error', code: 'PERSIST_ERROR' };

    case 'system_notice':
      return { type: 'status', message: payload.message || '' };

    // v0.4 W1.5（PRD §7.4 / §7.5）：runtime 端切发 approval_requested batch 形态，
    // 旧 review_required 已不再 emit（按 D6 一刀切删除）。SSE 适配层同步走新事件名。
    case 'approval_requested':
      return {
        type: 'approval_requested',
        message: payload.message || 'Agent 正在等待您的审批，请在客户端确认后继续',
        batch_id: payload.batch_id || null,
        ...payload,
      };

    case 'ask_user_required':
    case 'ask_form_required':
    case 'request_approval_required':
      // W4 R3 (2026-05-11): 三件套并存——ask_user 处理单/多选 + ask_choice 兼容；
      // ask_form 处理多字段表单；request_approval 处理 destructive 操作授权（含 risk_level）。
      return {
        type: shortType,
        message: payload.title || payload.question || payload.message || 'Agent 正在等待您的回答',
        ask_id: payload.ask_id || payload.interrupt_id || null,
        ...payload,
      };

    // W4.5 第三波 C1（2026-05-13）：'chunk' case 物理删——wire `StreamEvents.CHUNK`
    // 物理删，daemon 0 emit，CLI 永不会收到该事件。

    case 'todo':
      return { type: 'todo', todos: payload.todos || [] };

    case 'ssh_output':
      return { type: 'ssh_output', output: payload.output || payload.content || '' };

    case 'compaction':
      return { type: 'compaction', ...payload };

    case 'context_pressure':
      return { type: 'context_pressure', level: payload.level || '', ...payload };

    case 'message_persisted':
      return { type: 'message_persisted', message_id: payload.message_id || null };

    // 标题更新已切到用户级广播 ``agent.user.title_updated``（W1 用户级事件
    // 治理）—— stream relay 不再产生 ``title_updated`` 短名，本 case 删除。

    case 'subagent_started':
      return { type: 'subagent_started', agent_id: payload.agent_id || null, ...payload };

    case 'subagent_completed':
      return { type: 'subagent_completed', agent_id: payload.agent_id || null, ...payload };

    case 'subagent_failed':
      return {
        type: 'subagent_failed',
        agent_id: payload.agent_id || null,
        error: payload.error || 'Subagent failed',
        ...payload,
      };

    case 'subagent_progress':
      return { type: 'subagent_progress', agent_id: payload.agent_id || null, ...payload };

    default:
      return { type: shortType, ...payload };
  }
}
