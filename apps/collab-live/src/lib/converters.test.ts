import { describe, expect, it } from "vitest";
import {
  binaryToAllFormats,
  MarkdownInputValidationError,
  markdownToUpdateBinary,
  pmJsonToUpdateBinary,
  sanitizePmJsonForSchema,
} from "./converters.js";

describe("markdownToUpdateBinary", () => {
  it("rejects an empty tabdata tableId before creating a Y.js update", async () => {
    await expect(
      markdownToUpdateBinary(':::tabdata{tableId="" title="oops"}\n:::'),
    ).rejects.toEqual(expect.objectContaining({
      name: "MarkdownInputValidationError",
      message: expect.stringMatching(/tableId/),
    }));
    await expect(
      markdownToUpdateBinary(':::tabdata{tableId="" title="oops"}\n:::'),
    ).rejects.toBeInstanceOf(MarkdownInputValidationError);
  });

  it("rejects ambiguous duplicate tableId attributes", async () => {
    await expect(
      markdownToUpdateBinary(
        ':::tabdata{tableId="tbl-a" tableId="tbl-b"}\n:::',
      ),
    ).rejects.toBeInstanceOf(MarkdownInputValidationError);
  });
});

describe("pmJsonToUpdateBinary", () => {
  it("preserves underline marks without Markdown conversion", async () => {
    const pmJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "underlined",
              marks: [{ type: "underline" }],
            },
          ],
        },
      ],
    };

    const update = pmJsonToUpdateBinary(pmJson);
    const formats = await binaryToAllFormats(update);

    expect(formats.json).toMatchObject(pmJson);
  });

  it("keeps known rich marks when an unknown mark is present", async () => {
    const pmJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "red",
              marks: [
                { type: "textStyle", attrs: { color: "#FF0000" } },
                { type: "notARealMark" },
              ],
            },
            {
              type: "text",
              text: "hi",
              marks: [{ type: "highlight", attrs: { color: "#fef9c3" } }],
            },
          ],
        },
      ],
    };

    const update = pmJsonToUpdateBinary(pmJson);
    const formats = await binaryToAllFormats(update);
    const texts = (formats.json.content as Array<{ content?: Array<Record<string, unknown>> }>)[0]
      ?.content;

    expect(texts).toEqual([
      {
        type: "text",
        text: "red",
        marks: [{ type: "textStyle", attrs: { color: "#FF0000" } }],
      },
      {
        type: "text",
        text: "hi",
        marks: [{ type: "highlight", attrs: { color: "#fef9c3" } }],
      },
    ]);
  });
});

describe("sanitizePmJsonForSchema", () => {
  it("drops unknown marks but keeps known ones", () => {
    const sanitized = sanitizePmJsonForSchema({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [
                { type: "bold" },
                { type: "ghostMark" },
                { type: "textStyle", attrs: { color: "#00FF00", noSuchAttr: 1 } },
              ],
            },
          ],
        },
      ],
    }) as {
      content: Array<{ content: Array<{ marks?: Array<Record<string, unknown>> }> }>;
    };

    expect(sanitized.content[0].content[0].marks).toEqual([
      { type: "bold" },
      { type: "textStyle", attrs: { color: "#00FF00" } },
    ]);
  });
});
