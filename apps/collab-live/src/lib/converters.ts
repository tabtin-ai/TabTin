/**
 * Y.js Binary ↔ 格式转换工具
 *
 * 将 Y.js binary (Uint8Array) 转换为 HTML / JSON / Plaintext / Markdown。
 * Schema 由 @tabtin/doc-editor 的 getDocServerSchema() 统一提供，
 * 确保与编辑器支持的节点类型完全一致。
 */

import * as Y from "yjs";
import type { Schema } from "@tiptap/pm/model";
import { getDocServerSchema } from "@tabtin/doc-editor";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";

const TOP_LEVEL_INLINE_TYPES = new Set(["text", "image", "mathematics", "hardBreak"]);

/**
 * Drop marks / attrs the current server schema does not know.
 *
 * Import drafts may emit newer marks (e.g. superscript) before collab-live has
 * been restarted onto a matching @tabtin/doc-editor build. nodeFromJSON would
 * otherwise throw and force a lossy markdown fallback that strips color and
 * highlight for the entire document.
 */
export function sanitizePmJsonForSchema(
  value: unknown,
  schema: Schema = getDocServerSchema(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePmJsonForSchema(item, schema));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const node = value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...node };

  if (Array.isArray(node.marks)) {
    const marks = node.marks
      .filter((mark): mark is Record<string, unknown> => !!mark && typeof mark === "object")
      .filter((mark) => typeof mark.type === "string" && !!schema.marks[mark.type])
      .map((mark) => {
        const markType = schema.marks[String(mark.type)];
        const attrs = mark.attrs;
        if (!attrs || typeof attrs !== "object" || !markType) {
          const { attrs: _drop, ...rest } = mark;
          return rest;
        }
        const allowed = new Set(Object.keys(markType.spec.attrs || {}));
        const filteredAttrs: Record<string, unknown> = {};
        for (const [key, attrValue] of Object.entries(attrs as Record<string, unknown>)) {
          if (allowed.has(key)) filteredAttrs[key] = attrValue;
        }
        return Object.keys(filteredAttrs).length > 0
          ? { ...mark, attrs: filteredAttrs }
          : { type: mark.type };
      });
    if (marks.length > 0) next.marks = marks;
    else delete next.marks;
  }

  if (node.attrs && typeof node.attrs === "object" && typeof node.type === "string") {
    const nodeType = schema.nodes[node.type];
    if (nodeType) {
      const allowed = new Set(Object.keys(nodeType.spec.attrs || {}));
      const filteredAttrs: Record<string, unknown> = {};
      for (const [key, attrValue] of Object.entries(node.attrs as Record<string, unknown>)) {
        if (allowed.has(key)) filteredAttrs[key] = attrValue;
      }
      if (Object.keys(filteredAttrs).length > 0) next.attrs = filteredAttrs;
      else delete next.attrs;
    }
  }

  if (Array.isArray(node.content)) {
    next.content = node.content.map((child) => sanitizePmJsonForSchema(child, schema));
  }

  return next;
}

function normalizePmJsonForYjs(pmJson: Record<string, unknown>): Record<string, unknown> {
  const schemaSafe = sanitizePmJsonForSchema(pmJson) as Record<string, unknown>;
  if (schemaSafe.type !== "doc" || !Array.isArray(schemaSafe.content)) {
    return schemaSafe;
  }

  const normalizedContent: unknown[] = [];
  let pendingInline: Record<string, unknown>[] = [];

  const flushInlineParagraph = () => {
    if (pendingInline.length === 0) return;
    normalizedContent.push({ type: "paragraph", content: pendingInline });
    pendingInline = [];
  };

  for (const child of schemaSafe.content) {
    if (
      child
      && typeof child === "object"
      && TOP_LEVEL_INLINE_TYPES.has(String((child as Record<string, unknown>).type))
    ) {
      pendingInline.push(child as Record<string, unknown>);
      continue;
    }
    flushInlineParagraph();
    normalizedContent.push(child);
  }
  flushInlineParagraph();

  return {
    ...schemaSafe,
    content: normalizedContent,
  };
}

/**
 * Y.js binary → HTML / JSON / Plaintext / Markdown
 */
export async function binaryToAllFormats(
  binary: Uint8Array,
  fragmentName: string = "default"
): Promise<{
  html: string;
  json: Record<string, unknown>;
  plaintext: string;
  markdown: string;
}> {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, binary);

  const fragment = ydoc.getXmlFragment(fragmentName);

  try {
    const pmNode = yXmlFragmentToProseMirrorRootNode(fragment, getDocServerSchema());
    const rawJson = pmNode.toJSON() as Record<string, unknown>;
    const { repairLeakedHtmlBlockInPmJson } = await import("@tabtin/doc-editor");
    const { pmJson: json } = repairLeakedHtmlBlockInPmJson(rawJson);

    let html = "";
    try {
      const { pmJsonToHtml } = await import("@tabtin/doc-editor");
      html = pmJsonToHtml(json);
    } catch {
      html = "";
    }

    const plaintext = pmNode.textContent || "";

    let markdown = "";
    try {
      const { pmJsonToMarkdown } = await import("@tabtin/doc-editor");
      markdown = pmJsonToMarkdown(json);
    } catch {
      markdown = plaintext;
    }

    return { html, json, plaintext, markdown };
  } finally {
    ydoc.destroy();
  }
}

/**
 * Y.js binary → Markdown
 */
export async function binaryToMarkdown(
  binary: Uint8Array,
  fragmentName: string = "default"
): Promise<string> {
  const result = await binaryToAllFormats(binary, fragmentName);
  return result.markdown;
}

/**
 * Markdown → Y.js update binary
 */
export class MarkdownInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownInputValidationError";
  }
}

export async function markdownToUpdateBinary(
  markdown: string,
  fragmentName: string = "default"
): Promise<Uint8Array> {
  const { markdownToPmJson } = await import("@tabtin/doc-editor");

  let pmJson: Record<string, unknown>;
  try {
    pmJson = markdownToPmJson(markdown);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(":::tabdata")) {
      throw new MarkdownInputValidationError(message);
    }
    throw error;
  }
  return pmJsonToUpdateBinary(pmJson, fragmentName);
}

/**
 * ProseMirror JSON → Y.js update binary
 */
export function pmJsonToUpdateBinary(
  pmJson: Record<string, unknown>,
  fragmentName: string = "default"
): Uint8Array {
  const ydoc = new Y.Doc();

  try {
    const fragment = ydoc.getXmlFragment(fragmentName);
    prosemirrorJSONToYXmlFragment(getDocServerSchema(), normalizePmJsonForYjs(pmJson), fragment);
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    ydoc.destroy();
  }
}
