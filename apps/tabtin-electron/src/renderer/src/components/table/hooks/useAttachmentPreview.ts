import React from 'react';
import type { AttachmentUploadTask } from '@/stores/useAttachmentStore';

const PREVIEW_STATUSES = new Set(['pending', 'uploading', 'completed']);
const IMAGE_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i;
const COMPLETED_REVOKE_DELAY_MS = 3000;

function isImagePreviewCandidate(file: File): boolean {
  if (typeof file.type === 'string' && file.type.toLowerCase().startsWith('image/')) {
    return true;
  }
  return IMAGE_PATTERN.test(file.name);
}

export function useAttachmentPreview(
  attachmentTasks: Record<string, AttachmentUploadTask>,
) {
  const urlMapRef = React.useRef<Map<string, string>>(new Map());
  const pendingRevokeRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [previewUrls, setPreviewUrls] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    const urls = urlMapRef.current;
    const activeIds = new Set<string>();
    let changed = false;

    Object.values(attachmentTasks).forEach((task) => {
      task.items.forEach((item) => {
        if (!PREVIEW_STATUSES.has(item.status) || !isImagePreviewCandidate(item.file)) {
          return;
        }
        activeIds.add(item.uploadItemId);
        if (!urls.has(item.uploadItemId)) {
          urls.set(item.uploadItemId, URL.createObjectURL(item.file));
          changed = true;
        }

        if (item.status === 'completed' && item.reference?.url) {
          if (!pendingRevokeRef.current.has(item.uploadItemId)) {
            pendingRevokeRef.current.set(
              item.uploadItemId,
              setTimeout(() => {
                const blobUrl = urls.get(item.uploadItemId);
                if (blobUrl) {
                  URL.revokeObjectURL(blobUrl);
                  urls.delete(item.uploadItemId);
                  setPreviewUrls(Object.fromEntries(urls.entries()));
                }
                pendingRevokeRef.current.delete(item.uploadItemId);
              }, COMPLETED_REVOKE_DELAY_MS),
            );
          }
        }
      });
    });

    Array.from(urls.entries()).forEach(([id, url]) => {
      if (activeIds.has(id)) return;
      URL.revokeObjectURL(url);
      urls.delete(id);
      const timer = pendingRevokeRef.current.get(id);
      if (timer) { clearTimeout(timer); pendingRevokeRef.current.delete(id); }
      changed = true;
    });

    if (changed) {
      setPreviewUrls(Object.fromEntries(urls.entries()));
    }
  }, [attachmentTasks]);

  React.useEffect(
    () => () => {
      urlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
      urlMapRef.current.clear();
      pendingRevokeRef.current.forEach((timer) => clearTimeout(timer));
      pendingRevokeRef.current.clear();
    },
    [],
  );

  return previewUrls;
}
