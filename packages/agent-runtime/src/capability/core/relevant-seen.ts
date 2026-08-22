/**
 * 动态段描述去重（ 后续优化）—— skills / MCP / CLI 共用。
 *
 * 三者的动态段（`<relevant_skills>` / `<relevant_mcp>` / `<relevant_cli>`）会随
 * context-injector 落库、跨轮作为 HISTORICAL_CONTEXT 持续发给 LLM。同一条目多轮相关时，
 * 它的描述会在每轮历史块里各留一份 + 当轮再来一份，重复占 token。
 *
 * 本模块：扫**当前 live `state.messages`**（而非落库历史）里已出现的动态块，收集「已带过
 * 描述」的行标识；当轮渲染时把命中的行描述替换成可恢复引导 `（见上文）`。
 *
 * **压缩安全**：检测基于当轮真实发送的消息——被引用的描述必然在同一 payload 里；即便后续
 * compaction 摘掉历史块，条目名字仍在静态段（`<skills>`/`<mcp_servers>`/`<cli_commands>`），
 * 模型可用 skills_read / `tabtin mcp list-tools` / `tabtin commands` 重取，`（见上文）`是
 * 可恢复引导而非死指针。
 *
 * 三者动态段都是同构 Markdown 表 `| 标识 | 次列 | 描述 |`（skills=key、mcp=tool、cli=command），
 * 故一套解析/改写逻辑通用；标识 = 第 1 列。
 */

import type {
  ContentBlock,
  Message,
  TextBlock,
} from '../../engine/contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../../engine/contracts/conversation.js';

/** 描述已在上文出现时，动态段描述列替换成的可恢复引导。 */
export const RELEVANT_SEEN_MARKER = '（见上文）';

/** 空描述占位（与各 renderer 的 cell 空值占位一致）。 */
const EMPTY_CELL = '—';

function messageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** 解析一行 Markdown 表格为 cell 数组；非表格行返回 null。 */
function parseRow(line: string): string[] | null {
  if (!line.startsWith('| ')) return null;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  return cells.length >= 3 ? cells : null;
}

/** 表头 / 分隔行的第 1 列值（跳过，不当数据行）。 */
const HEADER_FIRST_CELLS = new Set(['key', 'tool', 'command', '---']);

/**
 * 扫历史消息，收集某类动态块中「已带过真实描述」的行标识（第 1 列）。
 *
 * 只收描述列为真实描述的行——排除空占位 `—` 与本模块的 `（见上文）` marker
 * （被 blank 过的行不再算「带过描述」，避免链式误判）。
 */
/** 把一个动态块正文里「带真实描述」的行标识加入 seen（排除表头/占位/marker）。 */
function addDescribedFromBlock(block: string, seen: Set<string>): void {
  for (const line of block.split('\n')) {
    const cells = parseRow(line);
    if (!cells) continue;
    const first = cells[0];
    const desc = cells[cells.length - 1];
    if (!first || HEADER_FIRST_CELLS.has(first)) continue;
    if (desc && desc !== EMPTY_CELL && desc !== RELEVANT_SEEN_MARKER) {
      seen.add(first);
    }
  }
}

export function collectDescribedKeys(
  messages: Message[] | undefined,
  tagOpen: string,
  tagClose: string,
): Set<string> {
  const seen = new Set<string>();
  if (!messages) return seen;
  // tagOpen/tagClose 都是固定字面量（`<relevant_*>`），无正则特殊字符，直接拼安全。
  const blockRe = new RegExp(`${tagOpen}([\\s\\S]*?)${tagClose}`, 'g');

  for (const m of messages) {
    // ：跳过本 run 的**临时**注入块——召回块（RELEVANT_RECALL_INJECTION）与旧
    // 承载它的 context 块（CONTEXT_INJECTION）每轮会被 filter 掉再重插。若拿它们当
    // 「已带过描述」依据，会把当轮新块的描述 blank 成「（见上文）」，随后旧块被移除
    // → 变死指针。只对稳定的历史块（HISTORICAL_CONTEXT）+ 真实消息去重。
    if (
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION) ||
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)
    ) {
      continue;
    }
    const text = messageText(m.content);
    if (!text.includes(tagOpen)) continue;
    for (const match of text.matchAll(blockRe)) {
      addDescribedFromBlock(match[1], seen);
    }
  }
  return seen;
}

/**
 * 把已渲染动态块里、第 1 列命中 `seen` 的数据行，描述列替换成 `（见上文）`。
 * `seen` 为空直接原样返回。
 */
export function blankSeenDescriptions(block: string, seen: Set<string>): string {
  if (seen.size === 0) return block;
  return block
    .split('\n')
    .map((line) => {
      const cells = parseRow(line);
      if (!cells) return line;
      const first = cells[0];
      if (HEADER_FIRST_CELLS.has(first) || !seen.has(first)) return line;
      cells[cells.length - 1] = RELEVANT_SEEN_MARKER;
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
}
