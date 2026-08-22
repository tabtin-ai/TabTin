/**
 * /oss/upload — 上传本地文件到 OSS，返回访问 URL。
 *
 * 委托 @tabtin/action-tools/utils/oss-upload；不依赖宿主 GUI，可在
 * Daemon / Electron 两端通用。Daemon 走 @tabtin/oss-client 直传，
 * Electron 走宿主注入的 uploadToOSS 函数（详见 oss-upload.ts 头注释）。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, okResponse, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest } from '../host-bindings.js';
import {
  guardLocalFile,
  guessMimeType,
  mapUploadErrorCode,
} from './local-file-guard.js';

/**
 * 调用方可声明的 FileUsage.context_type 白名单。
 *
 * - `present`：通用一次性上传（`tabtin oss upload` 的既有语义），文件不纳入某个业务
 *   实体的生命周期清理——保持默认，避免改变通用命令行为。
 * - `document`：TabDoc 正文引用的文件（与 Electron 直传图片一致）。登记为 document
 *   后，文件随文档归档 / 永久删除被 DocumentService._deactivate_document_file_usages
 *   一并释放（同一 context_id 下的所有 document usages），ref_count 归零后可回收。
 *   CLI 的 TabDoc HTML 块上传即用此值修复 （旧口径固定 present → 永不回收）。
 */
export const OSS_UPLOAD_CONTEXT_TYPES = ['present', 'document'] as const;
export type OSSUploadContextType = (typeof OSS_UPLOAD_CONTEXT_TYPES)[number];

const DEFAULT_UPLOAD_CONTEXT_TYPE: OSSUploadContextType = 'present';

/**
 * 校验调用方传入的 context_type：缺省 / 空串回退默认 'present'；命中白名单则采用；
 * 非法值返回 ok:false 供路由层打 400（VALIDATION_ERROR）。抽成纯函数便于单测。
 */
export function resolveUploadContextType(
  raw: unknown,
):
  | { ok: true; contextType: OSSUploadContextType }
  | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, contextType: DEFAULT_UPLOAD_CONTEXT_TYPE };
  }
  if (
    typeof raw !== 'string' ||
    !(OSS_UPLOAD_CONTEXT_TYPES as readonly string[]).includes(raw)
  ) {
    return {
      ok: false,
      message: `context_type must be one of: ${OSS_UPLOAD_CONTEXT_TYPES.join(', ')}`,
    };
  }
  return { ok: true, contextType: raw as OSSUploadContextType };
}

/**
 * action-tools `uploadFileToOSS` 的返回结构（本地镜像，避免 sub-path types 解析限制）。
 * 权威定义见 packages/action-tools/src/utils/oss-upload.ts 的 UploadOutcome。
 */
interface UploadOutcome {
  url: string | null;
  fileId?: string;
  fileKey?: string;
  cdnUrl?: string;
  error?: string;
  errorCode?: string;
}

export interface LocalFileUploadSuccess {
  ok: true;
  url: string;
  fileId?: string;
  fileKey?: string;
  cdnUrl?: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export interface LocalFileUploadFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export interface PerformLocalFileUploadOptions {
  folder?: string;
  module?: string;
  mimeType?: string;
  /** 白名单见 {@link OSS_UPLOAD_CONTEXT_TYPES}；缺省回退 'present'。 */
  contextType?: unknown;
  contextId?: string;
  organizationId?: string;
  /**
   * ：CLI TabDoc HTML 显式传 `is_public=false` 禁止公开直链。
   * 缺省不传，保持 action-tools / oss-client 默认公开策略。
   */
  isPublic?: boolean;
}

/**
 * 本地文件 → OSS 上传的共用实现，供 `/oss/upload` 与其它一步编排路由
 * （如 `/table/attachment-upload`）复用，避免各自维护一份 guard + 动态 import
 * + 错误码映射逻辑而漂移。
 *
 * 只做「上传」这一步——不写业务侧引用关系（如 attachment reuse），调用方
 * 拿到 `fileId` 后自行编排下一步。
 */
export async function performLocalFileUpload(
  filePath: string,
  opts: PerformLocalFileUploadOptions = {},
): Promise<LocalFileUploadSuccess | LocalFileUploadFailure> {
  const guarded = guardLocalFile(typeof filePath === 'string' ? filePath : '');
  if (!guarded.ok) {
    return { ok: false, status: guarded.status, code: guarded.code, message: guarded.message };
  }

  const contextTypeResult = resolveUploadContextType(opts.contextType);
  if (!contextTypeResult.ok) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: contextTypeResult.message };
  }

  const mimeType = opts.mimeType ?? guessMimeType(guarded.resolved);
  const folder = opts.folder ?? 'agent/uploads';
  const moduleName = opts.module ?? 'agent';
  const contextId = opts.contextId?.trim() || `cli-upload-${Date.now()}`;

  try {
    const mod: any = await import('@tabtin/action-tools/utils/oss-upload' as any);
    const uploadFileToOSS = mod.uploadFileToOSS as (
      path: string,
      o: any,
    ) => Promise<UploadOutcome>;
    const outcome = await uploadFileToOSS(guarded.resolved, {
      folder,
      module: moduleName,
      contextType: contextTypeResult.contextType,
      contextId,
      mimeType,
      organizationId: opts.organizationId,
      ...(opts.isPublic === undefined ? {} : { isPublic: opts.isPublic }),
    });

    if (!outcome.url) {
      const { status, code } = mapUploadErrorCode(outcome.errorCode);
      return { ok: false, status, code, message: outcome.error ?? 'OSS upload failed. Check auth and network.' };
    }

    return {
      ok: true,
      url: outcome.url,
      fileId: outcome.fileId,
      fileKey: outcome.fileKey,
      cdnUrl: outcome.cdnUrl,
      filename: guarded.fileName,
      mimeType,
      fileSize: guarded.size,
    };
  } catch (err: any) {
    return { ok: false, status: 500, code: 'UPLOAD_ERROR', message: `Upload failed: ${err?.message ?? String(err)}` };
  }
}

export async function handleOSSRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  if (url === '/oss/upload' && method === 'POST') {
    const filePath = body?.file_path ?? body?.path;
    // organizationId 来自 CLI Go 端 pipeline.go:~1490 注入的 body.organization_id
    // （snake_case 与本路由其他字段一致：file_path / context_id 等）；
    // 透传后 oss-upload.ts 会优先用 per-request 值而非 daemon 全局 organizationId，
    // 修复"daemon 跑在 organization A、CLI 操作 organization B"导致 FileRecord 错写、
    // 后续 doc import file 报 file_not_in_organization 403 的 bug。
    // contextType 由调用方声明（白名单 present/document，见 resolveUploadContextType）。
    // 默认 'present' 保持 `tabtin oss upload` 通用命令行为不变；TabDoc HTML 块上传
    // 传 'document' 以纳入文档归档/删除的 FileUsage 清理路径。
    // CLI TabDoc HTML  显式传 is_public=false；缺省保持 action-tools 默认。
    const explicitIsPublic =
      typeof body?.is_public === 'boolean'
        ? body.is_public
        : typeof body?.isPublic === 'boolean'
          ? body.isPublic
          : undefined;
    const outcome = await performLocalFileUpload(typeof filePath === 'string' ? filePath : '', {
      folder: body?.folder as string | undefined,
      module: body?.module as string | undefined,
      mimeType: body?.mime_type as string | undefined,
      contextType: body?.context_type,
      // Django confirm-upload 强制 context_id 非空（CROSS-1 文件归属追踪，
      // apps/tabtin_django/apps/services/oss/api.py）。`tabtin oss upload` 是通用
      // 一次性上传，无内建业务上下文——调用方可显式传 context_id，否则由
      // performLocalFileUpload 按 oss-upload.ts 头注释的"一次性产物自造 stable id"
      // 约定合成一个，避免上传被服务端直接拒。
      contextId: body?.context_id as string | undefined,
      organizationId: (typeof body?.organization_id === 'string' && body.organization_id) || undefined,
      ...(explicitIsPublic === undefined ? {} : { isPublic: explicitIsPublic }),
    });

    if (!outcome.ok) {
      sendJSON(res, outcome.status, errorResponse(outcome.code, outcome.message));
      return;
    }

    // 返回 file_id（OSS FileRecord 主键）供 `doc import file --file-record-id` 等回引文件的
    // 下游消费；url 仍保留给 present_to_user 展示链路。字段名与 Django to_response_dict 对齐。
    sendJSON(res, 200, okResponse({
      url: outcome.url,
      file_id: outcome.fileId,
      file_key: outcome.fileKey,
      cdn_url: outcome.cdnUrl,
      // ：补 filename 供 shell 自动发卡 / Agent 直接引用，避免只靠命令行猜名
      filename: outcome.filename,
      mime_type: outcome.mimeType,
      file_size: outcome.fileSize,
    }));
    return;
  }

  // ──  / ：团队存储批量删除（organization_id 必须走 query）──
  if (url === '/oss/storage/files/batch-delete' && method === 'POST') {
    const organizationId = (typeof body?.organization_id === 'string' && body.organization_id.trim())
      ? body.organization_id.trim()
      : (typeof process.env.TABTIN_ORGANIZATION_ID === 'string' && process.env.TABTIN_ORGANIZATION_ID.trim()
        ? process.env.TABTIN_ORGANIZATION_ID.trim()
        : '');
    if (!organizationId) {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', '缺少 organization_id。请设置 TABTIN_ORGANIZATION_ID 或传入 organization_id'),
      );
      return;
    }
    const rawIds = body?.file_ids;
    const fileIds = Array.isArray(rawIds)
      ? rawIds.filter((id: unknown) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())
      : [];
    if (fileIds.length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_ids'));
      return;
    }
    const result = await djangoRequest(
      'POST',
      `/services/oss/storage/files/batch-delete?organization_id=${encodeURIComponent(organizationId)}`,
      { file_ids: fileIds },
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  // ──  / ：团队存储批量删除（organization_id 必须走 query）──
  if (url === '/oss/storage/files/batch-delete' && method === 'POST') {
    const organizationId = (typeof body?.organization_id === 'string' && body.organization_id.trim())
      ? body.organization_id.trim()
      : (typeof process.env.TABTIN_ORGANIZATION_ID === 'string' && process.env.TABTIN_ORGANIZATION_ID.trim()
        ? process.env.TABTIN_ORGANIZATION_ID.trim()
        : '');
    if (!organizationId) {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', '缺少 organization_id。请设置 TABTIN_ORGANIZATION_ID 或传入 organization_id'),
      );
      return;
    }
    const rawIds = body?.file_ids;
    const fileIds = Array.isArray(rawIds)
      ? rawIds.filter((id: unknown) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())
      : [];
    if (fileIds.length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_ids'));
      return;
    }
    const result = await djangoRequest(
      'POST',
      `/services/oss/storage/files/batch-delete?organization_id=${encodeURIComponent(organizationId)}`,
      { file_ids: fileIds },
    );
    sendJSON(res, result.status, result.data);
    return;
  }

  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown OSS route: ${url}`));
}
