/**
 * transcript 权威路径会丢掉仅存在于 renderer 的外来档案正文 / external-archive 边界。
 * 从 renderer history 取回并接到重放结果队首。
 */

import type { RuntimeHistoryMessage } from './types.js';

export const EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX = 'ext-';
export const EXTERNAL_ARCHIVE_MESSAGE_KIND = 'external_archive_context';
const EXTERNAL_ARCHIVE_PREFIX = '<context type="external-archive"';

/** 本机导入档案写入的 transcript 行，不得 relay / Django sync。 */
export function isExternalArchiveLocalOnlyMessage(input: {
  messageId?: string | null;
  messageKind?: string | null;
}): boolean {
  const messageId = input.messageId ?? '';
  if (messageId.startsWith(EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX)) return true;
  return input.messageKind === EXTERNAL_ARCHIVE_MESSAGE_KIND;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const text = (block as { type?: string; text?: unknown }).text;
    if ((block as { type?: string }).type === 'text' && typeof text === 'string') {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

function contentHasExternalArchiveBoundary(content: unknown): boolean {
  return contentText(content).trimStart().startsWith(EXTERNAL_ARCHIVE_PREFIX);
}

export type RendererHistoryLike = {
  id?: string;
  role?: string;
  content?: unknown;
  message_kind?: string | null;
  metadata?: Record<string, unknown> | null;
  sourceMessageId?: string;
};

/**
 * 只认 hydrate 写入的 `ext-*` id，不认普通会话伪造的 metadata.external_archive。
 * （本机 IPC 信任 renderer；防伪造靠 id 契约，不是服务端鉴权。）
 */
function isArchiveBody(message: RendererHistoryLike): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (contentHasExternalArchiveBoundary(message.content)) return false;
  const id = message.id || message.sourceMessageId || '';
  if (typeof id === 'string' && id.startsWith('ext-')) {
    if (id.startsWith('ext-prefix') || id.startsWith('ext-llm-boundary')) return false;
    return true;
  }
  return false;
}

function isTrustedBoundary(message: RendererHistoryLike): boolean {
  if (!contentHasExternalArchiveBoundary(message.content)) return false;
  const id = message.id || message.sourceMessageId || '';
  return typeof id === 'string' && id.startsWith('ext-llm-boundary');
}

function toRuntimeMessage(message: RendererHistoryLike): RuntimeHistoryMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content = message.content;
  if (content == null) return null;
  if (typeof content === 'string' && content.length === 0) return null;
  return {
    role: message.role,
    content: content as RuntimeHistoryMessage['content'],
    ...(typeof message.id === 'string' ? { sourceMessageId: message.id } : {}),
  };
}

/**
 * 若 projected（通常来自本机 transcript 重放）缺少 external-archive 边界，
 * 把 renderer 侧的外来正文 + 边界接到队首。
 */
export function mergeExternalArchiveBoundaryIntoHistory(
  projected: RuntimeHistoryMessage[] | undefined,
  rendererHistory: ReadonlyArray<RendererHistoryLike> | null | undefined,
): RuntimeHistoryMessage[] {
  const base = projected ?? [];
  if (base.some((m) => contentHasExternalArchiveBoundary(m.content))) {
    return base;
  }

  const prefix: RuntimeHistoryMessage[] = [];
  let boundary: RuntimeHistoryMessage | null = null;
  let boundaryCandidate: RuntimeHistoryMessage | null = null;
  for (const message of rendererHistory ?? []) {
    if (contentHasExternalArchiveBoundary(message.content)) {
      const runtime = toRuntimeMessage(message);
      if (!runtime) continue;
      if (isTrustedBoundary(message)) {
        boundary = runtime;
      } else {
        // 无 ext-llm-boundary id 时，仅在已有可信外来正文时才采纳（防纯正文伪造）
        boundaryCandidate = runtime;
      }
      continue;
    }
    if (isArchiveBody(message)) {
      const runtime = toRuntimeMessage(message);
      if (runtime) prefix.push(runtime);
    }
  }
  if (!boundary && prefix.length > 0 && boundaryCandidate) {
    boundary = boundaryCandidate;
  }
  // 无可信外来正文时：仅允许带 ext-llm-boundary id 的边界单独补上；
  // 纯正文伪造（无可信 id）不得注入。
  if (prefix.length === 0) {
    return boundary ? [boundary, ...base] : base;
  }

  // transcript 开头若已是同一段外来正文，跳过避免双份
  let baseStart = 0;
  for (let i = 0; i < prefix.length && baseStart < base.length; i += 1) {
    if (contentText(base[baseStart]?.content) === contentText(prefix[i]?.content)) {
      baseStart += 1;
    } else {
      break;
    }
  }

  const out: RuntimeHistoryMessage[] = [...prefix];
  if (boundary) out.push(boundary);
  out.push(...base.slice(baseStart));
  return out;
}
