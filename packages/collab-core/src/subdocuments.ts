import * as Y from "yjs";
import type { CollabRootManifest, CollabShardRef } from "./sharding.js";

export const COLLAB_SUBDOCS_MAP = "subdocs";

export function getSubdocumentsMap(rootDoc: Y.Doc): Y.Map<Y.Doc> {
  return rootDoc.getMap<Y.Doc>(COLLAB_SUBDOCS_MAP);
}

export function ensureManifestSubdocuments(rootDoc: Y.Doc, manifest: CollabRootManifest): Y.Doc[] {
  const subdocs = getSubdocumentsMap(rootDoc);
  const ensured: Y.Doc[] = [];

  rootDoc.transact(() => {
    for (const shard of manifest.shards) {
      if (shard.kind === "root") continue;
      const existing = subdocs.get(shard.id);
      if (existing) {
        ensured.push(existing);
        continue;
      }
      const subdoc = new Y.Doc({ guid: shard.guid });
      subdocs.set(shard.id, subdoc);
      ensured.push(subdoc);
    }
  }, "collab-subdoc-manifest");

  return ensured;
}

export function loadSubdocuments(rootDoc: Y.Doc, refs: CollabShardRef[]): Y.Doc[] {
  const subdocs = getSubdocumentsMap(rootDoc);
  const loaded: Y.Doc[] = [];

  for (const ref of refs) {
    const subdoc = subdocs.get(ref.id);
    if (!subdoc) continue;
    subdoc.load();
    loaded.push(subdoc);
  }

  return loaded;
}

export function destroyInactiveSubdocuments(rootDoc: Y.Doc, activeIds: ReadonlySet<string>): number {
  const subdocs = getSubdocumentsMap(rootDoc);
  let destroyed = 0;

  subdocs.forEach((subdoc, id) => {
    if (activeIds.has(id)) return;
    subdoc.destroy();
    destroyed++;
  });

  return destroyed;
}
