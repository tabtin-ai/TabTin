/**
 * 统一协作认证
 *
 * 所有模块（docs、table、slide、video、canvas）共用同一个
 * onAuthenticate 回调工厂，替代各模块独立的认证文件。
 *
 * document name 格式: "{resourceType}:{resourceId}"
 *   - docs:{documentId}
 *   - table:{tableId}
 *   - slide:{projectId}
 *   - video:{projectId}
 *   - canvas:{canvasId}
 */

import type { ConnectionConfiguration } from "@hocuspocus/server";
import { verifyCollabAccess } from "../services/django-api.js";

const RESOURCE_PREFIXES: Record<string, string> = {
  docs: "docs:",
  slide: "slide:",
  table: "table:",
  video: "video:",
  canvas: "canvas:",
};

/**
 * 创建 Hocuspocus onAuthenticate 回调。
 *
 * @param resourceType 资源类型（"docs" | "table" | "slide" | "video" | "canvas"）
 */
export function createCollabAuthHandler(resourceType: string) {
  const prefix = RESOURCE_PREFIXES[resourceType];
  if (!prefix) {
    throw new Error(`Unknown resource type for auth: ${resourceType}`);
  }

  return async function onAuthenticateCollab({
    documentName,
    token,
    connection,
    requestParameters,
  }: {
    documentName: string;
    token: string;
    connection: ConnectionConfiguration;
    requestParameters?: URLSearchParams;
    context: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (!token) {
      throw new Error("Missing authentication token");
    }

    if (!documentName.startsWith(prefix)) {
      throw new Error(`Invalid ${resourceType} document name: ${documentName}`);
    }
    const resourceId = documentName.slice(prefix.length);

    const isShareToken = token.startsWith("sct_");
    const parentDocumentId = resourceType === "table"
      ? requestParameters?.get("parent_document_id")?.trim() || undefined
      : undefined;

    const { authorized, user_id, user_name, permission, reason } = await verifyCollabAccess(
      resourceType,
      resourceId,
      token,
      parentDocumentId,
    );

    if (!authorized) {
      throw new Error(
        `Unauthorized: ${reason || `need editor permission for ${resourceType} collaboration`}`
      );
    }

    connection.readOnly = permission === "view";

    console.log(
      `[CollabAuth] ${resourceType} ${resourceId} authenticated for user ${user_id}`
    );

    return {
      userId: user_id,
      readOnly: permission === "view",
      editorType: isShareToken ? "share" : "user",
      editorId: user_id,
      editorName: user_name || "",
      documentName,
      authToken: token,
      resourceType,
      resourceId,
      parentDocumentId,
      lastRevalidation: Date.now(),
      permissionRevoked: false,
    };
  };
}

export const onAuthenticateDocs = createCollabAuthHandler("docs");
export const onAuthenticateSlide = createCollabAuthHandler("slide");
export const onAuthenticateTable = createCollabAuthHandler("table");
export const onAuthenticateVideo = createCollabAuthHandler("video");
export const onAuthenticateCanvas = createCollabAuthHandler("canvas");
