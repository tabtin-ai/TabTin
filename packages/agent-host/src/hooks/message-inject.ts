/**
 * 单块消息注入工具（ Phase 1）—— 宿主消息注入 hook 的共用原语。
 *
 * **背景**：`context` / `memory` / `todo-state` / `relevant-recall` / `rules` /
 * `lsp-diagnostic` 六个宿主 hook 的 `beforeIteration` 都要做同一件事——「把一块
 * 自维护的内部 `role:'system'` 消息插进 messages，且每轮只保留最新一块（旧块按自有
 * marker 过滤掉、不堆积）」。这里把这套「过滤自有 marker 旧块 + 定位 + splice」
 * 收成两个纯函数，替代原 runtime 侧的 `SingleBlockInjector` 模板方法基类。
 *
 * **刻意不做**：这里**不**承载 per-run / per-iteration 闸门、开关关闭态撤块、
 * 注入后回执等生命周期语义——那些各 hook 差异很大，留在各 hook 里显式表达，
 * 避免重建一套 Injector 类层级 / 框架。
 *
 * 行为与原 `single-block-injector.ts` 的 filter + 插位 + splice 逐字节一致。
 */

import type { Message } from '@tabtin/agent-runtime/engine'
import {
  hasInternalMarker,
  setInternalMarker,
  findLastRealUserIndex,
  type InternalMessageMarker,
} from '@tabtin/agent-runtime/engine'

/**
 * 注入位置：
 *  - `'head'`：unshift 到 messages[0]（rules 的「宪法级」规约放最前）。
 *  - `'before-last-user'`：插到「最后一条真用户消息」之前（引擎 `findLastRealUserIndex`
 *    定位），找不到真用户消息则 append 到末尾——把易变内容贴当前 user turn 尾部。
 *  - 自定义函数：给定「已摘掉自有旧块」的 filtered 数组，返回插入 index。memory /
 *    todo / lsp / relevant 各有自己的锚点逻辑（context 块之后、todo 结果之后、
 *    末尾等），用函数形态表达。
 */
export type InjectPosition =
  | 'head'
  | 'before-last-user'
  | ((filtered: Message[]) => number)

function resolveInsertIndex(filtered: Message[], position: InjectPosition): number {
  if (position === 'head') return 0
  if (position === 'before-last-user') {
    const idx = findLastRealUserIndex(filtered)
    return idx < 0 ? filtered.length : idx
  }
  return position(filtered)
}

/** 过滤掉带指定 marker 的消息，返回新数组（单块不堆积）。 */
export function removeTaggedBlock(messages: Message[], marker: InternalMessageMarker): Message[] {
  return messages.filter((m) => !hasInternalMarker(m, marker))
}

/**
 * 用 `marker` 把 `content` 包成一条内部 `role:'system'` 消息，替换 messages 里同 marker
 * 的旧块（先 filter 再按 `position` 定位 splice），返回新数组。
 *
 * content 形态由调用方决定：context 传裸 string（跨轮 byte-stable）；其余传
 * text-block 数组（`[{type:'text', text}]`）。
 */
export function upsertTaggedBlock(
  messages: Message[],
  options: {
    marker: InternalMessageMarker
    content: Message['content']
    position: InjectPosition
  },
): Message[] {
  const filtered = removeTaggedBlock(messages, options.marker)
  const message = setInternalMarker({ role: 'system', content: options.content }, options.marker)
  const insertAt = resolveInsertIndex(filtered, options.position)
  const next = filtered.slice()
  next.splice(insertAt, 0, message)
  return next
}
