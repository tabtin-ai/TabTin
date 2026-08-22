import type { CollabModuleName } from "./controlEvents.js";

export type CollabShardKind = "root" | "content" | "window" | "metadata";

export interface CollabShardRef {
  id: string;
  guid: string;
  kind: CollabShardKind;
  module: CollabModuleName;
  documentName: string;
  range?: {
    start?: string | number;
    end?: string | number;
  };
}

export interface CollabRootManifest {
  resourceId: string;
  module: CollabModuleName;
  schemaVersion: number;
  shards: CollabShardRef[];
}

export function getShardRefsByKind(
  manifest: CollabRootManifest,
  kind: CollabShardKind,
): CollabShardRef[] {
  return manifest.shards.filter((shard) => shard.kind === kind);
}

export function assertRootManifestIsLightweight(manifest: CollabRootManifest): boolean {
  return manifest.shards.every((shard) => shard.guid.trim() !== "" && shard.documentName.trim() !== "");
}
