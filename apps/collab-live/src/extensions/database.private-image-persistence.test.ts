import { describe, expect, it } from "vitest";

import { binaryToAllFormats } from "../lib/converters.js";
import { buildPmJsonMigrationBinary } from "./database.js";

function findImage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node.type === "image") return node;
  if (!Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const image = findImage(child);
    if (image) return image;
  }
  return null;
}

describe("TabDoc private image persistence", () => {
  it("scrubs a stale signed URL before migrating private image JSON", async () => {
    const fileId = "11111111-2222-4333-8444-555555555555";
    const staleSignedUrl = "https://oss.example.com/private.png?sig=expired";
    const binary = buildPmJsonMigrationBinary(
      {
        type: "doc",
        content: [{
          type: "image",
          attrs: { fileId, src: staleSignedUrl, alt: "private" },
        }],
      },
      "private-image-doc",
    );

    expect(Buffer.from(binary).toString("utf8")).not.toContain("sig=");
    expect(Buffer.from(binary).toString("utf8")).not.toContain("https://");

    const formats = await binaryToAllFormats(binary);
    const attrs = findImage(formats.json)?.attrs as Record<string, unknown>;
    expect(attrs.fileId).toBe(fileId);
    expect(attrs.src).toBe("");
  });

  it("preserves a public external image that has no file identity", async () => {
    const publicUrl = "https://images.example.com/public.png";
    const binary = buildPmJsonMigrationBinary(
      {
        type: "doc",
        content: [{
          type: "image",
          attrs: { src: publicUrl, alt: "public" },
        }],
      },
      "public-image-doc",
    );

    const formats = await binaryToAllFormats(binary);
    const image = findImage(formats.json) as Record<string, unknown>;
    expect((image.attrs as Record<string, unknown>).src).toBe(publicUrl);
  });
});
