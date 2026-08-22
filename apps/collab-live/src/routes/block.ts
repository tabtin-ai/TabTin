/**
 * Block 级操作端点
 *
 * - POST /block/list
 * - POST /block/read
 * - POST /block/update
 */

import * as Y from "yjs";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { markdownToPmJson, pmJsonToMarkdown, getDocServerSchema } from "@tabtin/doc-editor";
import { withDirectConnection } from "../lib/with-direct-connection.js";
import { safeEditorType } from "../lib/collab-utils.js";
import { getErrorMessage } from "../lib/error-utils.js";
import type { RouteContext } from "./types.js";

const MAX_BINARY_BYTES = 5 * 1024 * 1024; // 5 MB

function findBlockIndex(fragment: Y.XmlFragment, blockId: string): number {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement) {
      const id = child.getAttribute("blockId") || `block_${i}`;
      if (id === blockId) return i;
    }
  }
  return -1;
}

function extractXmlElementText(element: Y.XmlElement): string {
  const parts: string[] = [];

  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      parts.push(child.toString());
    } else if (child instanceof Y.XmlElement) {
      parts.push(extractXmlElementText(child));
    }
  }

  return parts.join("").trim();
}

export function setupBlockRoutes(ctx: RouteContext): void {
  const { app, requireLiveSecret } = ctx;

  app.post("/block/list", requireLiveSecret, async (req, res) => {
    try {
      const { binary_b64, fragment_name } = req.body;

      if (!binary_b64) {
        res.status(400).json({ status: "error", message: "缺少 binary_b64 参数" });
        return;
      }

      const binary = new Uint8Array(Buffer.from(binary_b64, "base64"));
      if (binary.byteLength > MAX_BINARY_BYTES) {
        res.status(413).json({
          status: "error",
          message: `binary_b64 解码后 ${binary.byteLength} 字节超过上限 ${MAX_BINARY_BYTES}`,
        });
        return;
      }
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, binary);

      const fragment = ydoc.getXmlFragment(fragment_name || "default");
      const blocks: Array<{ id: string; type: string; text: string; level?: number }> = [];

      for (let i = 0; i < fragment.length; i++) {
        const child = fragment.get(i);
        if (child instanceof Y.XmlElement) {
          const type = child.nodeName;
          const id = child.getAttribute("blockId") || `block_${i}`;
          const text = extractXmlElementText(child);

          if (type === "heading") {
            const level = parseInt(child.getAttribute("level") || "1", 10);
            blocks.push({ id, type, text, level });
          } else {
            blocks.push({ id, type, text });
          }
        }
      }

      ydoc.destroy();
      res.json({ status: "ok", data: { blocks } });
    } catch (error: unknown) {
      console.error("[Block] list error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/block/read", requireLiveSecret, async (req, res) => {
    try {
      const { binary_b64, block_id, fragment_name } = req.body;

      if (!binary_b64 || !block_id) {
        res.status(400).json({ status: "error", message: "缺少 binary_b64 或 block_id" });
        return;
      }

      const binary = new Uint8Array(Buffer.from(binary_b64, "base64"));
      if (binary.byteLength > MAX_BINARY_BYTES) {
        res.status(413).json({
          status: "error",
          message: `binary_b64 解码后 ${binary.byteLength} 字节超过上限 ${MAX_BINARY_BYTES}`,
        });
        return;
      }
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, binary);

      const fragment = ydoc.getXmlFragment(fragment_name || "default");
      let markdown = "";

      for (let i = 0; i < fragment.length; i++) {
        const child = fragment.get(i);
        if (child instanceof Y.XmlElement) {
          const id = child.getAttribute("blockId") || `block_${i}`;
          if (id === block_id) {
            const tempDoc = new Y.Doc();
            try {
              const tempFragment = tempDoc.getXmlFragment("temp");
              tempFragment.insert(0, [child.clone()]);
              try {
                const pmNode = yXmlFragmentToProseMirrorRootNode(tempFragment, getDocServerSchema());
                markdown = pmJsonToMarkdown(pmNode.toJSON());
              } catch {
                markdown = extractXmlElementText(child);
              }
            } finally {
              tempDoc.destroy();
            }
            break;
          }
        }
      }

      ydoc.destroy();
      res.json({ status: "ok", data: { markdown } });
    } catch (error: unknown) {
      console.error("[Block] read error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/block/update", requireLiveSecret, async (req, res) => {
    try {
      const { document_id, block_id, action, content, editor_id, editor_type } = req.body;

      if (!document_id || !block_id || !action) {
        res.status(400).json({
          status: "error",
          message: "缺少 document_id, block_id 或 action",
        });
        return;
      }

      if (action !== "replace" && action !== "insert_after" && action !== "delete") {
        res.status(400).json({ status: "error", message: "action 必须为 replace / insert_after / delete" });
        return;
      }
      if ((action === "replace" || action === "insert_after") && typeof content !== "string") {
        res.status(400).json({ status: "error", message: "replace / insert_after 需要 content（Markdown）" });
        return;
      }

      await withDirectConnection(
        ctx.getInstance("docs"), `docs:${document_id}`,
        { editorType: safeEditorType(editor_type), editorId: editor_id || "" },
        (doc) => {
          doc.transact((ydoc) => {
            const fragment = ydoc.getXmlFragment("default");
            const targetIdx = findBlockIndex(fragment, block_id);

            if (targetIdx === -1) {
              throw new Error(`Block ${block_id} 未找到`);
            }

            if (action === "delete") {
              fragment.delete(targetIdx, 1);
            } else {
              const pmJson = markdownToPmJson(content);
              const tempDoc = new Y.Doc();
              try {
                const tempFragment = tempDoc.getXmlFragment("temp");
                prosemirrorJSONToYXmlFragment(getDocServerSchema(), pmJson, tempFragment);

                const nodes: Y.XmlElement[] = [];
                for (let i = 0; i < tempFragment.length; i++) {
                  const child = tempFragment.get(i);
                  if (child instanceof Y.XmlElement) nodes.push(child.clone());
                }

                if (action === "replace") {
                  fragment.delete(targetIdx, 1);
                  fragment.insert(targetIdx, nodes);
                } else {
                  fragment.insert(targetIdx + 1, nodes);
                }
              } finally {
                tempDoc.destroy();
              }
            }
          });
        },
      );

      console.log(`[Block] update: doc=${document_id}, block=${block_id}, action=${action}`);
      res.json({ status: "ok", data: { document_id, block_id, action } });
    } catch (error: unknown) {
      console.error("[Block] update error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });
}
