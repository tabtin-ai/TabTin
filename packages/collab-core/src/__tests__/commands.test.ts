import { describe, expect, it } from "vitest";
import { validateCollabApplyOpsRequest } from "../commands.js";

describe("validateCollabApplyOpsRequest", () => {
  it("accepts valid command requests", () => {
    expect(
      validateCollabApplyOpsRequest({
        module: "table",
        documentName: "table:1",
        opId: "op-1",
        ops: [{ type: "record.update", payload: {} }],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects incomplete command requests", () => {
    expect(validateCollabApplyOpsRequest({})).toEqual({
      ok: false,
      message: "module must be one of docs/table/canvas/slide/video",
    });
    expect(validateCollabApplyOpsRequest({ module: "unknown" as never })).toEqual({
      ok: false,
      message: "module must be one of docs/table/canvas/slide/video",
    });
    expect(validateCollabApplyOpsRequest({ module: "docs" })).toEqual({
      ok: false,
      message: "documentName is required",
    });
    expect(validateCollabApplyOpsRequest({ module: "docs", documentName: "doc:1" })).toEqual({
      ok: false,
      message: "opId is required",
    });
    expect(validateCollabApplyOpsRequest({ module: "docs", documentName: "doc:1", opId: "op-1", ops: [] })).toEqual({
      ok: false,
      message: "ops must be a non-empty array",
    });
  });
});
