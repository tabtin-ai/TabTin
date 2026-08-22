const ATTACHMENT_FIELD_TYPES = new Set(['attachment']);
const UPLOADING_STATUSES = new Set(['pending', 'uploading']);

function isUploadingAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const attachment = value as Record<string, unknown>;
  if (attachment.__uploading === true) return true;

  return (
    typeof attachment.upload_status === 'string' &&
    UPLOADING_STATUSES.has(attachment.upload_status)
  );
}

/**
 * 历史值可能包含曾被误落库的本地上传占位项。它们只用于展示进度，
 * 不代表用户在修改前已经拥有一个附件。
 */
export function sanitizeHistoryAttachmentValue(
  fieldType: string | null | undefined,
  value: unknown,
): unknown {
  if (!ATTACHMENT_FIELD_TYPES.has(String(fieldType ?? '').toLowerCase())) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((item) => !isUploadingAttachment(item));
  }

  return isUploadingAttachment(value) ? null : value;
}
