import type { Request, Response } from "express";
import {
  APPLY_OPS_RESOURCE_TYPES,
  type ApplyOpsHandlerResult,
  type CollabApplyOpsBody,
  isResourceType,
} from "../apply-ops/types.js";
import { executePrimitiveOps } from "../apply-ops/executor.js";
import { DocumentMutex } from "../lib/document-mutex.js";
import { withDirectConnection } from "../lib/with-direct-connection.js";
import { queueTableRecordLifecycleRevalidation } from "../extensions/table-database.js";
import type { RouteContext } from "./types.js";

export { MAX_BINARY_BYTES, MULTI_INSTANCE_WARNING } from "../apply-ops/types.js";

const applyOpsMutex = new DocumentMutex();
const MAX_RECORD_LIFECYCLE_REVALIDATIONS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateApplyOpsBody(body: CollabApplyOpsBody): { ok: true } | { ok: false; message: string } {
  if (!isResourceType(body.resource_type)) {
    return { ok: false, message: `resource_type must be one of ${Array.from(APPLY_OPS_RESOURCE_TYPES).join("/")}` };
  }
  if (typeof body.document_name !== "string" || body.document_name.trim() === "") {
    return { ok: false, message: "document_name is required" };
  }
  if (!body.document_name.startsWith(`${body.resource_type}:`)) {
    return { ok: false, message: "document_name must match resource_type prefix" };
  }
  if (typeof body.op_id !== "string" || body.op_id.trim() === "") {
    return { ok: false, message: "op_id is required" };
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    return { ok: false, message: "ops must be a non-empty array" };
  }
  if (
    body.require_store_success !== undefined
    && typeof body.require_store_success !== "boolean"
  ) {
    return { ok: false, message: "require_store_success must be a boolean" };
  }
  if (body.record_lifecycle_revalidation_ids !== undefined) {
    const recordIds = body.record_lifecycle_revalidation_ids;
    if (body.resource_type !== "table") {
      return { ok: false, message: "record_lifecycle_revalidation_ids is table-only" };
    }
    if (body.system_policy !== "trusted_internal") {
      return {
        ok: false,
        message: "record_lifecycle_revalidation_ids requires system_policy=trusted_internal",
      };
    }
    if (body.require_store_success !== true) {
      return {
        ok: false,
        message: "record_lifecycle_revalidation_ids requires require_store_success=true",
      };
    }
    if (
      !Array.isArray(recordIds)
      || recordIds.length === 0
      || recordIds.length > MAX_RECORD_LIFECYCLE_REVALIDATIONS
      || recordIds.some(recordId => typeof recordId !== "string" || !UUID_PATTERN.test(recordId))
    ) {
      return { ok: false, message: "record_lifecycle_revalidation_ids must contain valid UUIDs" };
    }
  }
  return { ok: true };
}

export function broadcastTableOrigin(
  instance: { documents: Map<string, { broadcastStateless(message: string): void }> },
  documentName: string,
  body: CollabApplyOpsBody,
): void {
  if (body.resource_type !== "table") return;
  if (typeof body.origin_id !== "string" || body.origin_id.length === 0) return;

  const hocusDoc = instance.documents.get(documentName);
  if (!hocusDoc) return;

  try {
    hocusDoc.broadcastStateless(JSON.stringify({
      type: "table.cells.pushed",
      payload: { origin_id: body.origin_id },
    }));
  } catch {
    // Best effort: origin broadcast suppresses local echo, but Y.Doc write remains authoritative.
  }
}

export function setupApplyOpsRoutes(ctx: RouteContext): void {
  const { app, requireLiveSecret } = ctx;

  app.post("/collab/apply-ops", requireLiveSecret, async (req: Request, res: Response) => {
    const validation = validateApplyOpsBody(req.body ?? {});
    if (!validation.ok) {
      res.status(400).json({ status: "error", code: "invalid_apply_ops", message: validation.message });
      return;
    }

    const body = req.body as Required<CollabApplyOpsBody>;
    try {
      const { instance, documentName } = ctx.resolveHocuspocusInstance(body.document_name);
      let result: ApplyOpsHandlerResult = {};
      const requireStoreSuccess = body.require_store_success === true;
      const requestedLifecycleIds = Array.from(new Set(
        body.record_lifecycle_revalidation_ids ?? [],
      ));
      let lifecycleCandidates: string[] = [];
      let directYDoc: import("yjs").Doc | null = null;

      await applyOpsMutex.runExclusive(documentName, () =>
        withDirectConnection(
          instance,
          documentName,
          {
            source: "apply-ops",
            editorType: body.editor_type,
            editorId: body.editor_id,
            editorName: body.editor_name,
            agentRunId: body.agent_run_id,
            systemPolicy: body.system_policy,
          },
          async (doc) => {
            broadcastTableOrigin(instance, documentName, body);
            const transaction = doc.transact((ydoc) => {
              directYDoc = ydoc;
              if (requestedLifecycleIds.length > 0) {
                const recordsMap = ydoc.getMap("records");
                lifecycleCandidates = requestedLifecycleIds.filter(recordId => (
                  recordsMap.has(recordId)
                ));
              }
              result = executePrimitiveOps({
                ydoc,
                documentName,
                resourceType: body.resource_type,
                routeContext: ctx,
                ops: body.ops,
              });
              if (lifecycleCandidates.length > 0) {
                queueTableRecordLifecycleRevalidation(
                  documentName,
                  lifecycleCandidates,
                );
              }
            });
            if (requireStoreSuccess) {
              await transaction;
            } else {
              void Promise.resolve(transaction).catch((error: unknown) => {
                console.error(
                  `[apply-ops] asynchronous transact failed for ${documentName}:`,
                  error,
                );
              });
            }
          },
          { propagateDisconnectError: requireStoreSuccess },
        ),
      );

      const remainingLifecycleCandidates = directYDoc
        ? lifecycleCandidates.filter(recordId => directYDoc!.getMap("records").has(recordId))
        : lifecycleCandidates;

      res.json({
        status: "ok",
        data: {
          resource_type: body.resource_type,
          document_name: documentName,
          op_id: body.op_id,
          ...result,
          total: body.ops.length,
          ...(requireStoreSuccess ? { store_completed: true } : {}),
          ...(requestedLifecycleIds.length > 0 ? {
            record_lifecycle_candidates: lifecycleCandidates.length,
            record_lifecycle_remaining: remainingLifecycleCandidates.length,
          } : {}),
        },
      });
    } catch (error) {
      res.status(400).json({
        status: "error",
        code: "apply_ops_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
