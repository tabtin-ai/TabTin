/**
 * /drive/* — Organization 云盘裸文件（TabFiles）路由。
 *
 *  / ：attach / archive / download-url / list / upload 一律走
 * `/context/organizations/{organization_id}/files/...`；
 * upload / upload-folder 在 cli-server 侧组合 OSS 直传 + Django 挂载，
 * 文件内容不中转到 Django（复用 presign/confirm）。
 *
 * 文件夹（Collection）与文件同为 Organization 宿主：upload-folder 创建
 * `/context/organizations/{id}/collections`，挂载带 collection_id 走 org upload。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, okResponse, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest } from '../host-bindings.js';
import {
  guardLocalFile,
  guessMimeType,
  mapUploadErrorCode,
  planLocalCloudFolderUpload,
} from './local-file-guard.js';

interface UploadOutcome {
  url: string | null;
  fileId?: string;
  fileKey?: string;
  cdnUrl?: string;
  error?: string;
  errorCode?: string;
}

type UploadFileToOSS = (path: string, opts: any) => Promise<UploadOutcome>;

/** 单测注入点：覆盖动态 import 的 uploadFileToOSS。 */
let uploadFileToOSSForTest: UploadFileToOSS | null = null;

export function setDriveUploadFileToOSSForTest(fn: UploadFileToOSS | null): void {
  uploadFileToOSSForTest = fn;
}

function requireString(body: any, key: string, res: ServerResponse, sendJSON: SendJSON): string | null {
  const value = body?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `缺少 ${key} 参数`));
    return null;
  }
  return value.trim();
}

function unwrapDjangoData(data: any): any {
  if (data && typeof data === 'object' && 'data' in data) {
    return data.data ?? data;
  }
  return data;
}

function organizationIdFrom(body: any): string | undefined {
  if (typeof body?.organization_id === 'string' && body.organization_id.trim()) {
    return body.organization_id.trim();
  }
  if (typeof body?.organizationId === 'string' && body.organizationId.trim()) {
    return body.organizationId.trim();
  }
  const envOrg = process.env.TABTIN_ORGANIZATION_ID;
  if (typeof envOrg === 'string' && envOrg.trim()) {
    return envOrg.trim();
  }
  return undefined;
}

function requireOrganizationId(
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): string | null {
  const id = organizationIdFrom(body);
  if (!id) {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        '缺少 organization_id。请设置 TABTIN_ORGANIZATION_ID，或在请求中传入 organization_id',
      ),
    );
    return null;
  }
  return id;
}

async function loadUploadFileToOSS(): Promise<UploadFileToOSS> {
  if (uploadFileToOSSForTest) return uploadFileToOSSForTest;
  const mod: any = await import('@tabtin/action-tools/utils/oss-upload' as any);
  return mod.uploadFileToOSS as UploadFileToOSS;
}

async function uploadLocalFileToTabFilesOSS(
  resolvedPath: string,
  organizationId: string,
  mimeType: string,
): Promise<UploadOutcome> {
  const uploadFileToOSS = await loadUploadFileToOSS();
  // ：与 Electron useResourceFileImport 对齐 — context_type=organization
  return uploadFileToOSS(resolvedPath, {
    folder: 'tabfiles/uploads',
    module: 'tabfiles',
    contextType: 'organization',
    contextId: organizationId,
    mimeType,
    organizationId,
  });
}

async function attachFileRecordToOrganization(
  organizationId: string,
  fileRecordId: string,
  opts?: { collectionId?: string; title?: string },
): Promise<{ status: number; data: any }> {
  const payload: Record<string, unknown> = { file_record_id: fileRecordId };
  if (opts?.collectionId) payload.collection_id = opts.collectionId;
  if (opts?.title) payload.title = opts.title;
  return djangoRequest('POST', `/context/organizations/${organizationId}/files/upload`, payload);
}

export async function handleDriveRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/drive/, '');

  if (route === '/attach' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;

    const collectionId = (typeof body?.collection_id === 'string' && body.collection_id.trim())
      ? body.collection_id.trim()
      : undefined;
    const title = (typeof body?.title === 'string' && body.title.trim())
      ? body.title.trim()
      : undefined;

    const result = await attachFileRecordToOrganization(organizationId, fileRecordId, {
      collectionId,
      title,
    });
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/archive-from-chat' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;

    const collectionId = (typeof body?.collection_id === 'string' && body.collection_id.trim())
      ? body.collection_id.trim()
      : undefined;

    const payload: Record<string, unknown> = { file_record_id: fileRecordId };
    if (collectionId) payload.collection_id = collectionId;

    const result = await djangoRequest(
      'POST',
      `/context/organizations/${organizationId}/files/from-chat`,
      payload,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/download-url' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const itemId = requireString(body, 'item_id', res, sendJSON);
    if (!itemId) return;

    const result = await djangoRequest(
      'GET',
      `/context/organizations/${organizationId}/files/${itemId}/download-url`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  // ── List TabFiles in Organization（ /  /  collection 过滤）──
  if (route === '/list' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;

    const params = new URLSearchParams();
    params.set('item_type', 'tabfiles');
    if (body?.page != null) params.set('page', String(body.page));
    if (body?.page_size != null) params.set('page_size', String(body.page_size));
    if (typeof body?.collection_id === 'string' && body.collection_id.trim()) {
      params.set('collection_id', body.collection_id.trim());
    }

    const result = await djangoRequest(
      'GET',
      `/context/organizations/${organizationId}/context-items?${params.toString()}`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  // ── Collection CRUD──
  if (route === '/collection/list' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const result = await djangoRequest(
      'GET',
      `/context/organizations/${organizationId}/collections`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collection/create' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const name = requireString(body, 'name', res, sendJSON);
    if (!name) return;
    const payload: Record<string, unknown> = { name };
    if (typeof body?.parent_id === 'string' && body.parent_id.trim()) {
      payload.parent_id = body.parent_id.trim();
    }
    if (typeof body?.icon === 'string' && body.icon.trim()) {
      payload.icon = body.icon.trim();
    }
    const result = await djangoRequest(
      'POST',
      `/context/organizations/${organizationId}/collections`,
      payload,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collection/update' && method === 'POST') {
    const collectionId = requireString(body, 'collection_id', res, sendJSON);
    if (!collectionId) return;
    const payload: Record<string, unknown> = {};
    if (typeof body?.name === 'string' && body.name.trim()) payload.name = body.name.trim();
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'parent_id')) {
      payload.parent_id = body.parent_id ?? null;
    }
    if (typeof body?.icon === 'string' && body.icon.trim()) payload.icon = body.icon.trim();
    if (Object.keys(payload).length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '至少提供 name / parent_id / icon 之一'));
      return;
    }
    const result = await djangoRequest(
      'PATCH',
      `/context/collections/${collectionId}`,
      payload,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collection/delete' && method === 'POST') {
    const collectionId = requireString(body, 'collection_id', res, sendJSON);
    if (!collectionId) return;
    const result = await djangoRequest('DELETE', `/context/collections/${collectionId}`);
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collection/move-items' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const rawIds = body?.item_ids;
    const itemIds = Array.isArray(rawIds)
      ? rawIds.filter((id: unknown) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())
      : [];
    if (itemIds.length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 item_ids'));
      return;
    }
    let collectionId: string | null = null;
    if (typeof body?.collection_id === 'string' && body.collection_id.trim()) {
      const raw = body.collection_id.trim();
      collectionId = (raw === 'root' || raw === 'null') ? null : raw;
    }
    const result = await djangoRequest(
      'POST',
      `/context/organizations/${organizationId}/collections/move-items`,
      { item_ids: itemIds, collection_id: collectionId },
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  // ── shared-with-me / trash-list / collaborator──
  if (route === '/shared-with-me' && method === 'POST') {
    const params = new URLSearchParams();
    const organizationId = organizationIdFrom(body);
    if (organizationId) params.set('organization_id', organizationId);
    const qs = params.toString();
    const result = await djangoRequest(
      'GET',
      `/context/files/shared-with-me${qs ? `?${qs}` : ''}`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/trash-list' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const params = new URLSearchParams();
    params.set('item_type', 'tabfiles');
    if (body?.page != null) params.set('page', String(body.page));
    if (body?.page_size != null) params.set('page_size', String(body.page_size));
    const result = await djangoRequest(
      'GET',
      `/context/organizations/${organizationId}/trash?${params.toString()}`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collaborator/list' && method === 'POST') {
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const result = await djangoRequest(
      'GET',
      `/context/files/${fileRecordId}/collaborators`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collaborator/invite' && method === 'POST') {
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const rawIds = body?.user_ids;
    const userIds = Array.isArray(rawIds)
      ? rawIds.filter((id: unknown) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())
      : [];
    if (userIds.length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 user_ids'));
      return;
    }
    const result = await djangoRequest(
      'POST',
      `/context/files/${fileRecordId}/collaborators`,
      { user_ids: userIds, permission: 'viewer' },
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collaborator/update' && method === 'POST') {
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const userId = requireString(body, 'user_id', res, sendJSON);
    if (!userId) return;
    const result = await djangoRequest(
      'PATCH',
      `/context/files/${fileRecordId}/collaborators/${userId}`,
      { permission: 'viewer' },
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/collaborator/revoke' && method === 'POST') {
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const userId = requireString(body, 'user_id', res, sendJSON);
    if (!userId) return;
    const result = await djangoRequest(
      'DELETE',
      `/context/files/${fileRecordId}/collaborators/${userId}`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  // ── TabFiles 回收站生命周期──
  if (route === '/trash' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const result = await djangoRequest(
      'POST',
      `/context/organizations/${organizationId}/files/${fileRecordId}/trash`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/restore' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const result = await djangoRequest(
      'POST',
      `/context/organizations/${organizationId}/files/${fileRecordId}/restore`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  if (route === '/permanent-delete' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;
    const fileRecordId = requireString(body, 'file_record_id', res, sendJSON);
    if (!fileRecordId) return;
    const result = await djangoRequest(
      'DELETE',
      `/context/organizations/${organizationId}/files/${fileRecordId}/permanent`,
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  // ── 一步上传并挂载到组织云盘──
  if (route === '/upload' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;

    const filePath = body?.file_path ?? body?.path;
    const guarded = guardLocalFile(typeof filePath === 'string' ? filePath : '');
    if (!guarded.ok) {
      sendJSON(res, guarded.status, errorResponse(guarded.code, guarded.message));
      return;
    }

    const mimeType = (typeof body?.mime_type === 'string' && body.mime_type.trim())
      ? body.mime_type.trim()
      : guessMimeType(guarded.resolved);
    const title = (typeof body?.title === 'string' && body.title.trim())
      ? body.title.trim()
      : guarded.fileName;
    const collectionId = (typeof body?.collection_id === 'string' && body.collection_id.trim())
      ? body.collection_id.trim()
      : undefined;

    try {
      const outcome = await uploadLocalFileToTabFilesOSS(
        guarded.resolved,
        organizationId,
        mimeType,
      );
      if (!outcome.url || !outcome.fileId) {
        const { status, code } = mapUploadErrorCode(outcome.errorCode);
        sendJSON(res, status, errorResponse(
          code,
          outcome.error ?? 'OSS upload failed. Check auth and network.',
        ));
        return;
      }

      const attachResult = await attachFileRecordToOrganization(organizationId, outcome.fileId, {
        collectionId,
        title,
      });
      if (attachResult.status >= 400) {
        sendJSON(res, attachResult.status, attachResult.data);
        return;
      }

      const item = unwrapDjangoData(attachResult.data) ?? {};
      sendJSON(res, 200, okResponse({
        id: item.id,
        title: item.title ?? title,
        item_type: item.item_type ?? 'tabfiles',
        resource_id: item.resource_id ?? outcome.fileId,
        status: item.status ?? 'active',
        file_id: outcome.fileId,
        file_key: outcome.fileKey,
        url: outcome.url,
        cdn_url: outcome.cdnUrl,
        filename: guarded.fileName,
        mime_type: mimeType,
        file_size: guarded.size,
        collection_id: collectionId ?? item.collection_id ?? null,
        organization_id: organizationId,
      }));
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('UPLOAD_ERROR', `Drive upload failed: ${err?.message ?? String(err)}`));
    }
    return;
  }

  // ── 一级文件夹上传（ / ，对齐 Electron planCloudFolderUpload）──
  // Collection 与文件均挂 Organization；OSS 与挂载都走 organization 通道。
  if (route === '/upload-folder' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON);
    if (!organizationId) return;

    const directory = body?.directory ?? body?.dir_path ?? body?.path;
    const plan = planLocalCloudFolderUpload(typeof directory === 'string' ? directory : '');
    if (!('accepted' in plan)) {
      sendJSON(res, plan.status, errorResponse(plan.code, plan.message));
      return;
    }

    if (plan.accepted.length === 0) {
      sendJSON(res, 400, errorResponse(
        'NO_UPLOADABLE_FILES',
        '目录下没有可上传的一级白名单文件（已跳过子目录/空文件/超限/不支持类型）',
        {
          detail: {
            folder_name: plan.folderName,
            skipped: plan.skipped,
            skipped_nested_count: plan.skippedNestedCount,
            skipped_type_count: plan.skippedTypeCount,
            skipped_duplicate_count: plan.skippedDuplicateCount,
            skipped_empty_count: plan.skippedEmptyCount,
            skipped_too_large_count: plan.skippedTooLargeCount,
          },
        },
      ));
      return;
    }

    const parentCollectionId = (typeof body?.parent_collection_id === 'string' && body.parent_collection_id.trim())
      ? body.parent_collection_id.trim()
      : undefined;

    let collectionId: string | null = null;
    try {
      const createResult = await djangoRequest(
        'POST',
        `/context/organizations/${organizationId}/collections`,
        {
          name: plan.folderName,
          icon: '📁',
          ...(parentCollectionId ? { parent_id: parentCollectionId } : {}),
        },
      );
      if (createResult.status >= 400) {
        sendJSON(res, createResult.status, createResult.data);
        return;
      }
      const created = unwrapDjangoData(createResult.data);
      collectionId = typeof created?.id === 'string' ? created.id : null;
      if (!collectionId) {
        sendJSON(res, 500, errorResponse('COLLECTION_CREATE_FAILED', '创建云盘文件夹失败：响应缺少 id'));
        return;
      }

      const results: Array<Record<string, unknown>> = [];
      let successCount = 0;
      let failedCount = 0;

      for (const file of plan.accepted) {
        try {
          const mimeType = guessMimeType(file.resolved);
          const outcome = await uploadLocalFileToTabFilesOSS(
            file.resolved,
            organizationId,
            mimeType,
          );
          if (!outcome.url || !outcome.fileId) {
            failedCount += 1;
            results.push({
              file_name: file.fileName,
              ok: false,
              error: outcome.error ?? 'OSS upload failed',
              error_code: outcome.errorCode ?? 'UPLOAD_FAILED',
            });
            continue;
          }

          const attachResult = await attachFileRecordToOrganization(organizationId, outcome.fileId, {
            collectionId,
            title: file.fileName,
          });
          if (attachResult.status >= 400) {
            failedCount += 1;
            const errBody = attachResult.data?.error ?? attachResult.data;
            results.push({
              file_name: file.fileName,
              ok: false,
              file_id: outcome.fileId,
              error: errBody?.message ?? 'Attach failed',
              error_code: errBody?.code ?? 'ATTACH_FAILED',
            });
            continue;
          }

          const item = unwrapDjangoData(attachResult.data) ?? {};
          successCount += 1;
          results.push({
            file_name: file.fileName,
            ok: true,
            id: item.id,
            resource_id: item.resource_id ?? outcome.fileId,
            file_id: outcome.fileId,
            url: outcome.url,
            mime_type: mimeType,
            file_size: file.size,
          });
        } catch (err: any) {
          failedCount += 1;
          results.push({
            file_name: file.fileName,
            ok: false,
            error: err?.message ?? String(err),
            error_code: 'UPLOAD_ERROR',
          });
        }
      }

      if (successCount === 0 && collectionId) {
        // 对齐 Electron：零成功时清理空 collection
        await djangoRequest('DELETE', `/context/collections/${collectionId}`).catch(() => undefined);
        sendJSON(res, 500, errorResponse(
          'FOLDER_UPLOAD_ZERO_SUCCESS',
          '文件夹上传全部失败，已清理空文件夹',
          {
            detail: {
              folder_name: plan.folderName,
              collection_id_cleared: collectionId,
              results,
              skipped: plan.skipped,
              summary: {
                success: 0,
                failed: failedCount,
                skipped: plan.skipped.length,
              },
            },
          },
        ));
        return;
      }

      // 部分失败时仍返回 200，但 summary 明确 success/failed/skipped，避免整体 ok 掩盖失败
      sendJSON(res, 200, okResponse({
        collection_id: collectionId,
        folder_name: plan.folderName,
        summary: {
          success: successCount,
          failed: failedCount,
          skipped: plan.skipped.length,
        },
        results,
        skipped: plan.skipped,
        skipped_nested_count: plan.skippedNestedCount,
        skipped_type_count: plan.skippedTypeCount,
        skipped_duplicate_count: plan.skippedDuplicateCount,
        skipped_empty_count: plan.skippedEmptyCount,
        skipped_too_large_count: plan.skippedTooLargeCount,
        partial_failure: failedCount > 0,
      }));
    } catch (err: any) {
      if (collectionId) {
        await djangoRequest('DELETE', `/context/collections/${collectionId}`).catch(() => undefined);
      }
      sendJSON(res, 500, errorResponse(
        'FOLDER_UPLOAD_ERROR',
        `Drive folder upload failed: ${err?.message ?? String(err)}`,
      ));
    }
    return;
  }

  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown drive route: ${url}`));
}
