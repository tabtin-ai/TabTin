import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  ensureManifestSubdocuments,
  loadSubdocuments,
  destroyInactiveSubdocuments,
} from "../subdocuments.js";
import {
  getShardRefsByKind,
  type CollabRootManifest,
} from "../sharding.js";

const MANIFEST: CollabRootManifest = {
  resourceId: "table-1",
  module: "table",
  schemaVersion: 1,
  shards: [
    { id: "root", guid: "root-guid", kind: "root", module: "table", documentName: "table:1:root" },
    { id: "content-1", guid: "content-guid-1", kind: "content", module: "table", documentName: "table:1:records:1" },
    { id: "window-1", guid: "window-guid-1", kind: "window", module: "table", documentName: "table:1:view:main:window:1" },
  ],
};

describe("collab subdocument lifecycle", () => {
  it("creates subdocument references from the root manifest", () => {
    const rootDoc = new Y.Doc();
    const subdocs = ensureManifestSubdocuments(rootDoc, MANIFEST);

    expect(subdocs).toHaveLength(2);
    expect(subdocs.map((doc) => doc.guid)).toEqual(["content-guid-1", "window-guid-1"]);
    expect(rootDoc.getSubdocs().size).toBe(2);
  });

  it("loads selected refs and destroys inactive subdocs", () => {
    const rootDoc = new Y.Doc();
    ensureManifestSubdocuments(rootDoc, MANIFEST);

    const contentRefs = getShardRefsByKind(MANIFEST, "content");
    const loaded = loadSubdocuments(rootDoc, contentRefs);
    expect(loaded.map((doc) => doc.guid)).toEqual(["content-guid-1"]);

    expect(destroyInactiveSubdocuments(rootDoc, new Set(["content-1"]))).toBe(1);
  });
});
