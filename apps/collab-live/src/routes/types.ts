import type { Hocuspocus } from "@hocuspocus/server";
import type expressWs from "express-ws";
import type express from "express";

export type ModuleName = "docs" | "table" | "slide" | "video" | "canvas";

export interface RouteContext {
  app: ReturnType<typeof expressWs>["app"];
  requireLiveSecret: express.RequestHandler;
  getInstance(module: ModuleName): Hocuspocus;
  allInstances(): Array<{ instance: Hocuspocus; module: string }>;
  resolveHocuspocusInstance(documentId: string): { instance: Hocuspocus; documentName: string };
  detectConcurrentEditors(
    documentName: string,
    excludeEditorId: string,
  ): Array<{ editor_type: string; editor_id: string }>;
}
