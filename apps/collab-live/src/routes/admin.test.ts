import { describe, expect, it } from "vitest";

import { shouldApplyTableSchemaFieldsSnapshot } from "./admin.js";

describe("shouldApplyTableSchemaFieldsSnapshot", () => {
  it("does not treat changed fields from schema events as a full Y.Doc schema", () => {
    expect(
      shouldApplyTableSchemaFieldsSnapshot({
        action: "delete_field",
        field_ids: ["field-copy"],
        fields: [{ id: "field-copy", name: "标题 副本" }],
      }),
    ).toBe(false);
  });

  it("allows explicitly marked full schema snapshots", () => {
    expect(
      shouldApplyTableSchemaFieldsSnapshot({
        action: "schema_snapshot",
        fields_scope: "full",
        fields: [
          { id: "field-title", name: "标题" },
          { id: "field-copy", name: "标题 副本" },
        ],
      }),
    ).toBe(true);
  });

  it("allows full schema scope from metadata", () => {
    expect(
      shouldApplyTableSchemaFieldsSnapshot({
        action: "schema_snapshot",
        metadata: { fields_scope: "full" },
        fields: [{ id: "field-title", name: "标题" }],
      }),
    ).toBe(true);
  });
});
