/**
 * 格式转换 + Y.js 工具端点
 *
 * - POST /convert/binary-to-formats
 * - POST /convert/pm-json-to-update
 * - POST /convert/markdown-to-update
 * - POST /convert/binary-to-markdown
 * - POST /yjs/compute-diff
 * - POST /yjs/apply-diff
 */

import * as Y from "yjs";
import {
  binaryToAllFormats,
  binaryToMarkdown,
  MarkdownInputValidationError,
  markdownToUpdateBinary,
  pmJsonToUpdateBinary,
} from "../lib/converters.js";
import { getErrorMessage } from "../lib/error-utils.js";
import type { RouteContext } from "./types.js";

const MAX_BINARY_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PM_JSON_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_DIFFS_COUNT = 100;

function checkBinarySize(
  res: import("express").Response,
  binary: Uint8Array,
  fieldName: string,
): boolean {
  if (binary.byteLength > MAX_BINARY_BYTES) {
    res.status(413).json({
      status: "error",
      message: `${fieldName} 解码后 ${binary.byteLength} 字节超过上限 ${MAX_BINARY_BYTES}`,
    });
    return false;
  }
  return true;
}

function checkPmJsonSize(
  res: import("express").Response,
  pmJson: unknown,
): boolean {
  const size = Buffer.byteLength(JSON.stringify(pmJson), "utf8");
  if (size > MAX_PM_JSON_BYTES) {
    res.status(413).json({
      status: "error",
      message: `pm_json 序列化后 ${size} 字节超过上限 ${MAX_PM_JSON_BYTES}`,
    });
    return false;
  }
  return true;
}

export function setupConvertRoutes(ctx: RouteContext): void {
  const { app, requireLiveSecret } = ctx;

  app.post("/convert/binary-to-formats", requireLiveSecret, async (req, res) => {
    try {
      const { binary_b64, fragment_name } = req.body;

      if (!binary_b64) {
        res.status(400).json({ status: "error", message: "缺少 binary_b64 参数" });
        return;
      }

      const binary = new Uint8Array(Buffer.from(binary_b64, "base64"));
      if (!checkBinarySize(res, binary, "binary_b64")) return;

      const result = await binaryToAllFormats(binary, fragment_name || "default");

      res.json({ status: "ok", data: result });
    } catch (error: unknown) {
      console.error("[Convert] binary-to-formats error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/convert/pm-json-to-update", requireLiveSecret, async (req, res) => {
    try {
      const { pm_json, fragment_name } = req.body;

      if (!pm_json || typeof pm_json !== "object" || Array.isArray(pm_json)) {
        res.status(400).json({ status: "error", message: "缺少 pm_json 参数" });
        return;
      }
      if (!checkPmJsonSize(res, pm_json)) return;

      const binary = pmJsonToUpdateBinary(pm_json, fragment_name || "default");
      const update_b64 = Buffer.from(binary).toString("base64");

      res.json({ status: "ok", data: { update_b64 } });
    } catch (error: unknown) {
      console.error("[Convert] pm-json-to-update error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/convert/markdown-to-update", requireLiveSecret, async (req, res) => {
    try {
      const { markdown, fragment_name } = req.body;

      if (typeof markdown !== "string") {
        res.status(400).json({ status: "error", message: "缺少 markdown 参数" });
        return;
      }

      const binary = await markdownToUpdateBinary(markdown, fragment_name || "default");
      const update_b64 = Buffer.from(binary).toString("base64");

      res.json({ status: "ok", data: { update_b64 } });
    } catch (error: unknown) {
      console.error("[Convert] markdown-to-update error:", error);
      const statusCode = error instanceof MarkdownInputValidationError ? 400 : 500;
      res.status(statusCode).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/convert/binary-to-markdown", requireLiveSecret, async (req, res) => {
    try {
      const { binary_b64, fragment_name } = req.body;

      if (!binary_b64) {
        res.status(400).json({ status: "error", message: "缺少 binary_b64 参数" });
        return;
      }

      const binary = new Uint8Array(Buffer.from(binary_b64, "base64"));
      if (!checkBinarySize(res, binary, "binary_b64")) return;

      const markdown = await binaryToMarkdown(binary, fragment_name || "default");

      res.json({ status: "ok", data: { markdown } });
    } catch (error: unknown) {
      console.error("[Convert] binary-to-markdown error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/yjs/compute-diff", requireLiveSecret, async (req, res) => {
    try {
      const { old_binary_b64, new_binary_b64 } = req.body;

      if (!old_binary_b64 || !new_binary_b64) {
        res.status(400).json({ status: "error", message: "缺少 old_binary_b64 或 new_binary_b64" });
        return;
      }

      const oldBinary = new Uint8Array(Buffer.from(old_binary_b64, "base64"));
      if (!checkBinarySize(res, oldBinary, "old_binary_b64")) return;

      const newBinary = new Uint8Array(Buffer.from(new_binary_b64, "base64"));
      if (!checkBinarySize(res, newBinary, "new_binary_b64")) return;

      const oldDoc = new Y.Doc();
      Y.applyUpdate(oldDoc, oldBinary);
      const stateVector = Y.encodeStateVector(oldDoc);

      const newDoc = new Y.Doc();
      Y.applyUpdate(newDoc, newBinary);
      const diff = Y.encodeStateAsUpdate(newDoc, stateVector);

      oldDoc.destroy();
      newDoc.destroy();

      const diff_b64 = Buffer.from(diff).toString("base64");

      res.json({
        status: "ok",
        data: {
          diff_b64,
          diff_size: diff.byteLength,
          old_size: oldBinary.byteLength,
          new_size: newBinary.byteLength,
        },
      });
    } catch (error: unknown) {
      console.error("[YjsUtil] compute-diff error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.post("/yjs/apply-diff", requireLiveSecret, async (req, res) => {
    try {
      const { base_binary_b64, diffs_b64 } = req.body;

      if (!base_binary_b64 || !Array.isArray(diffs_b64)) {
        res.status(400).json({ status: "error", message: "缺少 base_binary_b64 或 diffs_b64" });
        return;
      }

      if (diffs_b64.length > MAX_DIFFS_COUNT) {
        res.status(400).json({
          status: "error",
          message: `diffs_b64 数组长度 ${diffs_b64.length} 超过上限 ${MAX_DIFFS_COUNT}`,
        });
        return;
      }

      const baseBinary = new Uint8Array(Buffer.from(base_binary_b64, "base64"));
      if (!checkBinarySize(res, baseBinary, "base_binary_b64")) return;

      const doc = new Y.Doc();
      Y.applyUpdate(doc, baseBinary);

      for (const diffB64 of diffs_b64) {
        const diffBinary = new Uint8Array(Buffer.from(diffB64, "base64"));
        if (!checkBinarySize(res, diffBinary, "diffs_b64 元素")) {
          doc.destroy();
          return;
        }
        Y.applyUpdate(doc, diffBinary);
      }

      const merged = Y.encodeStateAsUpdate(doc);
      doc.destroy();

      const merged_b64 = Buffer.from(merged).toString("base64");

      res.json({
        status: "ok",
        data: {
          merged_b64,
          merged_size: merged.byteLength,
        },
      });
    } catch (error: unknown) {
      console.error("[YjsUtil] apply-diff error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });
}
