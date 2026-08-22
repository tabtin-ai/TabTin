/**
 * 用户消息 / 多模态构造：初始消息（含附件 ImageBlock / VideoBlock / DocumentBlock）
 * 装配、可见正文剥离 `<context …>` wrapper、user 事件块组装。自 query.ts 抽出。
 */
import type {
  ContentBlock,
  Message,
} from '../contracts/conversation.js';
import type {
  Attachment,
} from '../contracts/kernel.js';
import { findAllUserContextWrappers } from './user-context-wrapper.js';

export type UserMessageAttachmentRef = {
  type: 'image' | 'file' | 'video';
  /** FileRecord UUID：UI 换链 / 切会话后刷新依赖此字段，不能只落短期 URL。 */
  file_id?: string;
  url?: string;
  filename?: string;
  mime_type?: string;
};

/**
 * 把用户 prompt + image/video/file 附件装配成 initial user message
 *（image → ImageBlock；video → VideoBlock；file → DocumentBlock）。
 *
 * **W4 (2026-05-13) 图装配收敛**后的单一实现；#4019 批次 7：本体从
 * `history/build-initial-messages.ts` 收进内核。#2595：视频原生 `video_url`；
 * ：文档原生 `file_url`（不再抽文本注入 prompt）。
 */
export function buildUserMessageWithAttachments(
  prompt: string,
  attachments?: UserMessageAttachmentRef[],
): Message {
  const imageAttachments = attachments?.filter(
    (a): a is UserMessageAttachmentRef & { url: string } => a.type === 'image' && !!a.url,
  ) ?? [];
  const videoAttachments = attachments?.filter(
    (a): a is UserMessageAttachmentRef & { url: string } => a.type === 'video' && !!a.url,
  ) ?? [];
  const documentAttachments = attachments?.filter(
    (a): a is UserMessageAttachmentRef & { url: string } => a.type === 'file' && !!a.url,
  ) ?? [];

  if (
    imageAttachments.length === 0
    && videoAttachments.length === 0
    && documentAttachments.length === 0
  ) {
    return { role: 'user', content: prompt };
  }

  const blocks: ContentBlock[] = [];
  if (prompt.trim().length > 0) {
    blocks.push({ type: 'text', text: prompt });
  }
  for (const att of imageAttachments) {
    blocks.push({
      type: 'image',
      source: { type: 'url', url: att.url },
      detail: 'auto',
      // Host 业务字段：本机 transcript / USER echo 切会话后靠它换链。
      ...(att.file_id ? { file_id: att.file_id } : {}),
      ...(att.filename ? { filename: att.filename } : {}),
      ...(att.mime_type ? { mime_type: att.mime_type } : {}),
    });
  }
  for (const att of videoAttachments) {
    blocks.push({
      type: 'video',
      source: { type: 'url', url: att.url },
      ...(att.file_id ? { file_id: att.file_id } : {}),
      ...(att.filename ? { filename: att.filename } : {}),
      ...(att.mime_type ? { mime_type: att.mime_type } : {}),
    });
  }
  for (const att of documentAttachments) {
    blocks.push({
      type: 'document',
      source: { type: 'url', url: att.url },
      title: att.filename,
      mime_type: att.mime_type,
      ...(att.file_id ? { file_id: att.file_id } : {}),
    });
  }
  return { role: 'user', content: blocks };
}

export function buildInitialMessage(prompt: string, attachments?: Attachment[]): Message {
  return buildUserMessageWithAttachments(
    prompt,
    attachments?.map((a) => ({
      type: a.type,
      file_id: a.file_id,
      url: a.url,
      filename: a.filename,
      mime_type: a.mime_type,
    })),
  );
}

/**
 * ：可见正文数据流唯一收口。`params.prompt` 是给 LLM 的**执行 prompt**，
 * 可能被 host 拼进 `<context type="attached"/"referenced"/…>` 注入块（附件正文、
 * @ 引用 schema 等）——这些是执行上下文，绝不能当用户可见正文落库/渲染。
 *
 * 当上游没有透传干净的 `displayMessage` 时（daemon、CLI、旧客户端），回退用本函数
 * 剥掉所有 `<context …>` wrapper，只留用户真正键入的正文。复用
 * `findAllUserContextWrappers`（agent-prompt SSoT wrapper 解析），不另造正则。
 *
 * 无 wrapper 的纯用户输入（常规文本、CLI）原样返回（含早退），行为不变。
 */
export function stripUserContextWrappers(text: string): string {
  const wrappers = findAllUserContextWrappers(text);
  if (wrappers.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const w of wrappers) {
    out += text.slice(cursor, w.startOffset);
    cursor = w.endOffset;
  }
  out += text.slice(cursor);
  return out.trim();
}

type UserEventBlock = ContentBlock | Record<string, unknown>;

export function textContentFromBlocks(blocks: UserEventBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const text = block.text;
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts.join('\n');
}

export function hasEquivalentTextContent(blocks: UserEventBlock[], visibleText: string): boolean {
  const normalizedVisibleText = visibleText.trim();
  return textContentFromBlocks(blocks).trim() === normalizedVisibleText;
}

/**
 * 组装 USER 事件落库用的 `blocks_json`。
 *
 * 契约：有可见正文时**必须**返回含 text 的块数组——Django relay 不再为缺块合成。
 * 仅附件、无正文时返回附件块；两者皆空返回 undefined（调用方可不带 blocks_json）。
 *
 * 覆盖：主轮 `emitMainUserEventPhase`、后台 push-notification、Skill 直链与
 * tool `newMessages` 注入。environment_context 另有自带 text 块。
 * 不经过本函数、又无 `blocks_json` 的 emit（若有）落库后前端只能靠 content 字段。
 */
export function buildUserEventBlocks(
  visibleText: string,
  userMessageBlocks?: UserEventBlock[],
): UserEventBlock[] | undefined {
  const blocks = userMessageBlocks ?? [];
  const normalizedVisibleText = visibleText.trim();
  if (!normalizedVisibleText) return blocks.length > 0 ? blocks : undefined;
  if (hasEquivalentTextContent(blocks, visibleText)) {
    return blocks.length > 0 ? blocks : [{ type: 'text', text: visibleText }];
  }
  return [{ type: 'text', text: visibleText }, ...blocks];
}
