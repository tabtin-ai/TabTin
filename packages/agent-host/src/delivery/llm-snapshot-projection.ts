/**
 * ：LLM 调用快照上云——`llm_request` payload → `agent.stream.llm_snapshot`
 * relay 事件（Electron / Daemon 两端共享）。
 *
 * 体积护栏：WS 整帧上限 1MB（Django gateway MAX_MESSAGE_BYTES），快照的
 * system / messages / tools 全文可能超限。发送前估算 JSON 体积，超限则按
 * 「信息价值递减」顺序截断 contentPreview（messages → system sections），
 * tools 的 inputSchema 保持完整（schema 是排障关键且体积可控）。截断的
 * 字段带 `truncated_for_relay` 标记；本地 snapshots.jsonl 永远是全量，
 * 云端副本损失可回本地追。
 */
import {
  RuntimeLlmSnapshotEvent,
  type StreamEvent,
} from '@tabtin/agent-runtime'

/** 目标上限：留出 envelope / 批次开销的余量（整帧 1MB）。 */
const MAX_RELAY_SNAPSHOT_BYTES = 700_000;
/** 超限时单条 contentPreview 的截断长度。 */
const PREVIEW_CAP_CHARS = 4_000;

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function capPreviewList(
  items: unknown,
  cap: number,
): { changed: boolean; items: unknown } {
  if (!Array.isArray(items)) return { changed: false, items };
  let changed = false;
  const out = items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    const preview = record.contentPreview;
    if (typeof preview === 'string' && preview.length > cap) {
      changed = true;
      return {
        ...record,
        contentPreview: `${preview.slice(0, cap)}\n[…truncated_for_relay ${preview.length} chars…]`,
        truncated_for_relay: true,
      };
    }
    return item;
  });
  return { changed, items: out };
}

/**
 * 把 llm_request 的 snapshot payload 收敛到 relay 可发送体积。
 * 正常快照（绝大多数）原样返回；超限时逐级截断并打标。
 */
export function capLlmSnapshotForDelivery(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (jsonBytes(payload) <= MAX_RELAY_SNAPSHOT_BYTES) return payload;

  const capped: Record<string, unknown> = { ...payload, truncated_for_relay: true };

  // 第一级：messages 的 contentPreview 截断（历史消息全文占大头）
  const messagesCapped = capPreviewList(capped.messages, PREVIEW_CAP_CHARS);
  if (messagesCapped.changed) capped.messages = messagesCapped.items;
  if (jsonBytes(capped) <= MAX_RELAY_SNAPSHOT_BYTES) return capped;

  // 第二级：system sections 的 contentPreview 截断
  const system = capped.system;
  if (system && typeof system === 'object') {
    const systemRecord = system as Record<string, unknown>;
    const sectionsCapped = capPreviewList(systemRecord.sections, PREVIEW_CAP_CHARS);
    if (sectionsCapped.changed) {
      capped.system = { ...systemRecord, sections: sectionsCapped.items };
    }
  }
  if (jsonBytes(capped) <= MAX_RELAY_SNAPSHOT_BYTES) return capped;

  // 兜底：仍超限（极端 tools schema 巨大）——丢明细留计数，可回本地全量快照追。
  return {
    ...capped,
    messages: undefined,
    system: undefined,
    tools: undefined,
    truncated_for_relay: true,
    truncated_reason: 'oversize_after_preview_cap',
  };
}

/**
 * 构造 relay 用的 llm_snapshot 事件。payload 非法（缺 runId）返回 null，
 * 调用方跳过——快照是观测数据，宁缺毋错。
 */
export function projectLlmSnapshotDeliveryEvent(
  llmRequestPayload: Record<string, unknown>,
): StreamEvent | null {
  const runId = llmRequestPayload?.runId ?? llmRequestPayload?.run_id;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  return new RuntimeLlmSnapshotEvent(
    capLlmSnapshotForDelivery(llmRequestPayload),
  ).toStreamEvent();
}
