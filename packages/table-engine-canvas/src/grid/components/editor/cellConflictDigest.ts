import { CellType } from '../../renderers/cell-renderer/interface';
import type { IInnerCell } from '../../renderers/cell-renderer/interface';

const ACTIVE_UPLOAD_STATUSES = new Set(['pending', 'uploading']);

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/** 上传中的附件占位项（行 overlay 或 IImageData）不参与冲突比较 */
export function isUploadingAttachmentValue(value: unknown): boolean {
  if (!isRecordValue(value)) {
    return false;
  }
  if (value.__uploading === true || value.uploading === true) {
    return true;
  }
  const status = value.upload_status ?? value.uploadStatus;
  return typeof status === 'string' && ACTIVE_UPLOAD_STATUSES.has(status);
}

/** 本地上传完成后、真实记录值同步前由展示行临时叠加的附件 */
export function isLocalAttachmentOverlayValue(value: unknown): boolean {
  if (!isRecordValue(value)) {
    return false;
  }
  return value.__local_upload_overlay === true || value.localUploadOverlay === true;
}

const pickAttachmentIdentity = (record: Record<string, unknown>): string | null => {
  const keys = [
    'reference_id',
    'referenceId',
    'id',
    'file_id',
    'fileId',
    'token',
    'url',
    'download_url',
    'downloadUrl',
    'access_url',
    'accessUrl',
  ];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
};

/** 附件集合的稳定身份摘要，忽略 uploading 占位与进度等 transient 字段 */
export function attachmentCollectionIdentityDigest(items: unknown): string {
  const array = Array.isArray(items) ? items : items == null ? [] : [items];
  const identities = array
    .flatMap((item, index) => {
      if (isUploadingAttachmentValue(item) || isLocalAttachmentOverlayValue(item)) {
        return [];
      }
      if (typeof item === 'string') {
        const trimmed = item.trim();
        return trimmed.length > 0 ? [trimmed] : [];
      }
      if (isRecordValue(item)) {
        const identity = pickAttachmentIdentity(item);
        return identity ? [identity] : [`item-${index}`];
      }
      return [`item-${index}`];
    })
    .sort();
  return JSON.stringify(identities);
}

const pickUserIdentity = (record: Record<string, unknown>): string | null => {
  for (const key of ['id', 'user_id', 'userId']) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
};

/** 成员集合的稳定身份摘要，兼容编辑器提交的 ID 与渲染层解析后的成员对象。 */
export function userCollectionIdentityDigest(items: unknown): string {
  const array = Array.isArray(items) ? items : items == null ? [] : [items];
  const identities = array.flatMap((item, index) => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }
    if (isRecordValue(item)) {
      const identity = pickUserIdentity(item);
      if (identity) return [identity];
      try {
        return [JSON.stringify(item)];
      } catch {
        return [`item-${index}`];
      }
    }
    return [`item-${index}`];
  });
  return JSON.stringify([...new Set(identities)].sort());
}

/** 用于「编辑中远端是否改了同一单元格」的稳定摘要，避免引用变化误报 */
export function cellContentDigestForConflict(cell: IInnerCell): string {
  if (cell.type === CellType.Image) {
    return attachmentCollectionIdentityDigest(cell.data);
  }
  if (cell.type === CellType.User) {
    return userCollectionIdentityDigest(cell.data);
  }

  const displayData = (cell as { displayData?: unknown }).displayData;
  try {
    return JSON.stringify({
      type: cell.type,
      data: cell.data,
      displayData,
    });
  } catch {
    return `${cell.type}:${String(cell.data)}:${String(displayData)}`;
  }
}

export function valueDigestForConflict(value: unknown, cellType?: CellType): string {
  if (cellType === CellType.Image) {
    return attachmentCollectionIdentityDigest(value);
  }
  if (cellType === CellType.User) {
    return userCollectionIdentityDigest(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
