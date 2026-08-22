/**
 * User-Context Wrapper —— 自动加料统一壳协议（引擎消息形态 SSoT）。
 *
 *  Stage 2c：自 `@tabtin/agent-prompt` 迁入；产品文案仍由宿主拼 body，
 * 本模块只负责 `<context type>` 框的渲染 / 解析。
 *
 * **背景（阶段 6.4 + 6.5 议题 2）**：
 *
 * TabTinAgent 在 chat 路径上有 6 种"自动给用户 message 加料"的注入：
 *   1. `<context>` 环境（runtime hook context-injector）
 *   2. `<memory_recall>` 用户记忆（runtime hook memory-injector）
 *   3. `Referenced context data:` + 表 schema（renderer @ 引用，纯字符串拼接）
 *   4. `[文档: xxx]` + 文档正文（附件上传，纯字符串拼接）
 *   5. `<system-reminder><new-diagnostics>` LSP 诊断（runtime hook lsp-diagnostic-injector）
 *   6. tool eviction notice（`[system] 工具已下线…` —— query.ts 直接 push 无 marker）
 *
 * 6 类各搞各的格式 / 各自 marker 状态，导致两个真问题：
 *
 *   - **Bug A 跨轮看旧快照**：referenced / attached 类拼成字面字符串落盘
 *     `ChatMessage.content_blocks_json`，下次装填 history 时原样捞出—— Agent
 *     在下一轮甚至下一天看到的还是早上 9 点的 schema 快照，但表已经被改了
 *     （删列加行）。Agent 算的是基于过时数据的均值，**全链路没有任何
 *     "数据可能已变"提示**。
 *   - **Bug B normalizer 漏认 marker**：dogfood W4.3.2 撞过同型 P0 ——
 *     不同 kind 的"合成 user"被 `mergeConsecutiveMessages` 错合并成一条，
 *     LLM thinking "用户同时请求两件事"。当前只有 2 种 marker 被
 *     `classifyUserMessage` 识别（CONTEXT_INJECTION / CONTINUATION），其余
 *     3 种 hook 注入 + 1 种无 marker 路径都归入 `'other'` 兜底，存在合并风险。
 *
 * **本模块负责**：给 6 类自动加料定义"统一 wrapper 形态" + 提供渲染 / 解析
 * 双向工具，让 history 装填阶段能识别每个 wrapper 的 `type` 属性并按需替换
 * （譬如把跨轮的 `<context type="referenced" stale_after_turn="3">` 替换为
 * `[此轮曾引用 N 项资源（数据可能已变），如需最新请重新 @]`）。
 *
 * **格式约定**：
 *
 *   `<context type="<kind>" [attr1="v1" ...]>\n${body}\n</context>`
 *
 * 选 `<context>` 标签而非各自不同（`<memory_recall>` / `<system-reminder>` /
 * 等）是为了：
 *   1. LLM 端只学一个 wrapper 形态，认知负担最低；
 *   2. history 装填 / normalizer 端只需扫一个 regex（`<context type="..."`）
 *      就能枚举所有自动加料，stale 检测 / 合并保护逻辑统一。
 *
 * **历史兼容**：
 *
 *   - 老的 `<context>` 无 `type` 属性 —— message-normalizer 的 marker 识别
 *     不依赖 wrapper 格式（marker 是 in-memory 属性），向后兼容；
 *   - 老的 `Referenced context data:` / `[文档: foo]` 字面字符串持久化在
 *     `ChatMessage.content_blocks_json` 里，新的 `select-recent-history`
 *     stale 检测对 type='referenced' / type='attached' 才生效，老消息原样
 *     透传（不识别 stale → 不替换，保持旧行为，**只对新消息修复跨轮污染**）；
 *   - Python 端有等价实现 `apps/tabtin_django/apps/services/agent_execution/
 *     user_context_wrapper.py`，contract test 验证两边输出 byte-identical。
 *
 * **设计取舍 — 为什么 Python 端复刻而不让 daemon 渲染？**
 *
 * 议题 2 调研发现 wire 协议（`agent.prompt.forward.payload.prompt`）是单 string
 * 字段。改成 `{body, type, attrs}` 结构化字段会影响 Django ↔ Daemon ↔ Electron
 * 三端的字段抽取 / debug log / replay 工具，是 PR2 级别的协议改动。议题 2
 * 范围内选 (a)：Python 复刻 + 加 contract test，把"双源"风险压到测试可见。
 */

// ─── Public Types ────────────────────────────────────────────────────

/**
 * 自动加料的语义 type。
 *
 * - `environment` —— `buildContextInjectorHook` 注入的 Tab/App 焦点 + 当前时间
 * - `memory-recall` —— `buildMemoryInjectorHook` 注入的 TabMemo top-K 召回
 * - `referenced` —— 用户 @ 引用资源（表 schema / 文档 / memo 等）。**会持久化**
 * - `attached` —— 用户上传文件附件（PDF/docx/code 等）。**会持久化**
 * - `quoted-message` —— 用户「引用回复」的某条历史消息。**会持久化**
 * - `lsp-diagnostic` —— `buildLspDiagnosticInjectorHook` 注入的代码诊断
 * - `tool-eviction` —— `dynamicToolManager.evictStale` 后通告 LLM 工具已下线
 * - `mode-reminder` —— `buildModeReminderInjectorHook` 注入的 ask/plan/study sparse reminder
 * - `mode-transition-reminder` —— 任意模式切换后一次性注入的 from/to 过渡提醒
 * - `active-todos` —— todo-state-injector 注入的当前活跃待办快照
 *
 * **持久化标记的语义**：referenced / attached / quoted-message 会随
 * `ChatMessage.content_blocks_json` 落盘并跨轮重放——这三类必须挂 `stale_after_turn`
 * attr 让 history 装填阶段能识别跨轮过期。其他 4 类是 in-memory 注入，每轮重算 /
 * filter 旧 marker 后 prepend 新 message，不需要 stale 标记。
 *
 * **quoted-message 的跨轮语义**：被引用消息正文本身不会变（是历史消息，
 * 不像 @资源会随外部数据变），但它**已在历史里**——逐轮重复注入全文只是浪费
 * token。故跨轮同样折叠为指针（见 `select-recent-history` 的 stale 分支），只在
 * 引用发生的当轮携带完整正文喂给 LLM。
 */
export type UserContextWrapperType =
  | 'environment'
  | 'memory-recall'
  | 'agent-profile'
  | 'referenced'
  | 'attached'
  | 'quoted-message'
  | 'lsp-diagnostic'
  | 'tool-eviction'
  | 'mode-reminder'
  | 'mode-transition-reminder'
  | 'active-todos';

/** SSoT：Python `VALID_TYPES` contract test 对齐此列表。 */
export const VALID_USER_CONTEXT_WRAPPER_TYPES: readonly UserContextWrapperType[] = [
  'environment',
  'memory-recall',
  'agent-profile',
  'referenced',
  'attached',
  'quoted-message',
  'lsp-diagnostic',
  'tool-eviction',
  'mode-reminder',
  'mode-transition-reminder',
  'active-todos',
] as const;

/**
 * 跨轮 stale 检测必需的 attr：
 *
 *   - `stale_after_turn` —— 仅 referenced / attached 持久化类用；标"本 wrapper
 *     是哪一轮注入的"，history 装填时 `currentTurnId !== stale_after_turn` →
 *     视为跨轮 → 替换正文为指针。**值是字符串**（统一字面量，避免数字 / 字符串
 *     混用导致 parse 端要做 typeof 兜底）。
 *   - `filename` —— attached 类用；让跨轮替换时仍能保留 `[此轮曾引用文档 foo.pdf]`
 *     的可读性。
 *   - 其他自由 key —— passthrough（按需扩展，譬如 `count` / `table_id`）。
 *
 * 设计约束：所有 attr value 渲染时按 XML attr 转义（`&` → `&amp;`，
 * `"` → `&quot;`，`<` → `&lt;`），parse 端反向解。
 */
export interface UserContextWrapperAttrs {
  /** 仅 referenced / attached 用；跨轮 stale 检测锚点。 */
  stale_after_turn?: string;
  /** attached 类常带：附件文件名（跨轮替换为指针时保留可读性）。 */
  filename?: string;
  /** 自由扩展字段（譬如 referenced 类的资源 id / count）。 */
  [key: string]: string | undefined;
}

export interface ParsedUserContextWrapper {
  type: UserContextWrapperType | string;
  attrs: UserContextWrapperAttrs;
  body: string;
  /** 整段命中区间 `[startOffset, endOffset)` —— 让调用方能做"原文替换" */
  startOffset: number;
  endOffset: number;
}

// ─── XML attr escape / unescape ─────────────────────────────────────

/** XML attr value 转义。只覆盖 `&`、`"`、`<`、`>` 四类，与 Python `html.escape(..., quote=True)` 对齐。 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 反向解。`&amp;` 必须最后还原，避免 `&amp;quot;` 被先转成 `&quot;` 再误转 `"`。 */
function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ─── Builder ────────────────────────────────────────────────────────

/**
 * 渲染 user-context wrapper 为字符串。
 *
 * 形态：
 *
 *   ```
 *   <context type="<kind>"[ attr1="v1" attr2="v2" ...]>
 *   <body>
 *   </context>
 *   ```
 *
 * - attr 按 key 字典序排序，让 Python / TS 两侧输出 byte-identical（contract test）；
 * - attr value 为 `undefined` / 空字符串时跳过该 attr；
 * - body 不做任何转义（user content 直出，wrapper 只负责"框"，不动 body）；
 * - 没 attr 时形态退化为 `<context type="<kind>">\n${body}\n</context>`。
 *
 * **注意**：本 builder 不做长度截断 / budget 控制——调用方（hook / 拼接方）
 * 在传入前自行裁剪 body。
 */
export function buildUserContextWrapper(
  type: UserContextWrapperType,
  body: string,
  attrs?: UserContextWrapperAttrs,
): string {
  const attrPairs: string[] = [`type="${escapeXmlAttr(type)}"`];

  if (attrs) {
    // 字典序排序——让 Python / TS 输出位序固定，contract test 可逐字节对比。
    const keys = Object.keys(attrs).sort();
    for (const key of keys) {
      const value = attrs[key];
      if (value === undefined || value === '') continue;
      attrPairs.push(`${key}="${escapeXmlAttr(value)}"`);
    }
  }

  return `<context ${attrPairs.join(' ')}>\n${body}\n</context>`;
}

// ─── Parser ─────────────────────────────────────────────────────────

/**
 * 反向解析 wrapper 字符串。
 *
 * 输入可以是：
 *   1. 完整 wrapper（`buildUserContextWrapper` 的输出）；
 *   2. 含 1+ wrapper 的更长文本（譬如 user message 文本里嵌了多个 wrapper）。
 *
 * `findFirstUserContextWrapper` 找第一个；`findAllUserContextWrappers` 找全。
 *
 * **不匹配老形态**：
 *   - `<context>...</context>` 无 `type` 属性 → 不匹配（旧 context-injector 形态）；
 *   - `Referenced context data:\n...` 纯字符串前缀 → 不匹配（旧 renderer 形态）；
 *   - `[文档: xxx]\n...` 纯字符串前缀 → 不匹配（旧 attachment 形态）。
 *
 * 这是有意为之——老形态不挂 stale 标记，跨轮污染修复只对新形态生效，老
 * ChatMessage 落盘内容保持原行为透传（不识别 → 不替换）。
 */
export function findFirstUserContextWrapper(
  text: string,
  startFrom = 0,
): ParsedUserContextWrapper | null {
  // 匹配 <context type="..."[ ...]>\n<body>\n</context>
  // 注意：[\s\S] 跨行匹配 body；非贪婪 `*?` 避免吞掉下一个 wrapper。
  // 强制以 `type="..."` 开头——老 `<context>` 无 type 属性的形态不会被命中。
  const re = /<context\s+type="([^"]+)"((?:\s+[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*)\s*>\n([\s\S]*?)\n<\/context>/g;
  re.lastIndex = startFrom;
  const match = re.exec(text);
  if (!match) return null;

  const [whole, rawType, rawAttrs, body] = match;

  // 解析 attrs（key="value" 序列）
  const attrs: UserContextWrapperAttrs = {};
  if (rawAttrs && rawAttrs.length > 0) {
    const attrRe = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(rawAttrs)) !== null) {
      attrs[am[1]!] = unescapeXmlAttr(am[2]!);
    }
  }

  return {
    type: unescapeXmlAttr(rawType!),
    attrs,
    body: body!,
    startOffset: match.index,
    endOffset: match.index + whole!.length,
  };
}

/** 找出 text 里所有 wrapper（按起始 offset 升序）。 */
export function findAllUserContextWrappers(text: string): ParsedUserContextWrapper[] {
  const out: ParsedUserContextWrapper[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const wrapper = findFirstUserContextWrapper(text, cursor);
    if (!wrapper) break;
    out.push(wrapper);
    cursor = wrapper.endOffset;
  }
  return out;
}
