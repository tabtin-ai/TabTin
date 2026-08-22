import { describe, expect, it } from "vitest";
import {
  assertRootManifestIsLightweight,
  getShardRefsByKind,
  type CollabRootManifest,
} from "../sharding.js";

const MANIFEST: CollabRootManifest = {
  resourceId: "table-1",
  module: "table",
  schemaVersion: 1,
  shards: [
    { id: "root", guid: "guid-root", kind: "root", module: "table", documentName: "table:1:root" },
    { id: "records-1", guid: "guid-records-1", kind: "content", module: "table", documentName: "table:1:records:1" },
    { id: "window-1", guid: "guid-window-1", kind: "window", module: "table", documentName: "table:1:view:main:window:1" },
  ],
};

describe("collab sharding manifest", () => {
  it("selects shard references by kind", () => {
    expect(getShardRefsByKind(MANIFEST, "content").map((shard) => shard.id)).toEqual(["records-1"]);
    expect(getShardRefsByKind(MANIFEST, "window").map((shard) => shard.id)).toEqual(["window-1"]);
  });

  it("requires shard references to identify subdocuments", () => {
    expect(assertRootManifestIsLightweight(MANIFEST)).toBe(true);
    expect(
      assertRootManifestIsLightweight({
        ...MANIFEST,
        shards: [{ ...MANIFEST.shards[0], guid: "" }],
      }),
    ).toBe(false);
  });
});
