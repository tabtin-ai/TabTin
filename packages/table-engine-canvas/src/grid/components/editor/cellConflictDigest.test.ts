import { describe, expect, it } from 'vitest';
import { CellType } from '../../renderers/cell-renderer/interface';
import type { IImageCell } from '../../renderers/cell-renderer/interface';
import {
  attachmentCollectionIdentityDigest,
  cellContentDigestForConflict,
  isLocalAttachmentOverlayValue,
  isUploadingAttachmentValue,
  userCollectionIdentityDigest,
  valueDigestForConflict,
} from './cellConflictDigest';

describe('cellConflictDigest', () => {
  describe('isUploadingAttachmentValue', () => {
    it('detects row overlay uploading placeholders', () => {
      expect(
        isUploadingAttachmentValue({
          __uploading: true,
          upload_item_id: 'u1',
          upload_status: 'uploading',
        })
      ).toBe(true);
    });

    it('detects normalized IImageData uploading items', () => {
      expect(
        isUploadingAttachmentValue({
          id: 'u1',
          url: '',
          uploading: true,
          uploadStatus: 'uploading',
        })
      ).toBe(true);
    });

    it('does not treat completed attachments as uploading', () => {
      expect(
        isUploadingAttachmentValue({
          reference_id: 'ref-1',
          url: 'https://example.com/a.png',
          upload_status: 'completed',
        })
      ).toBe(false);
    });
  });

  describe('isLocalAttachmentOverlayValue', () => {
    it('detects raw completed upload task overlays', () => {
      expect(
        isLocalAttachmentOverlayValue({
          reference_id: 'ref-1',
          upload_status: 'completed',
          __local_upload_overlay: true,
        })
      ).toBe(true);
    });

    it('detects normalized image data from a local upload overlay', () => {
      expect(
        isLocalAttachmentOverlayValue({
          id: 'ref-1',
          url: 'https://example.com/a.png',
          localUploadOverlay: true,
        })
      ).toBe(true);
    });
  });

  describe('attachmentCollectionIdentityDigest', () => {
    it('ignores uploading placeholders so progress refresh does not change digest', () => {
      const baseline = attachmentCollectionIdentityDigest([]);
      const withUploadingOverlay = attachmentCollectionIdentityDigest([
        {
          __uploading: true,
          upload_item_id: 'temp-1',
          upload_status: 'uploading',
          upload_progress: 0.2,
        },
      ]);
      const withUpdatedProgress = attachmentCollectionIdentityDigest([
        {
          __uploading: true,
          upload_item_id: 'temp-1',
          upload_status: 'uploading',
          upload_progress: 0.8,
        },
      ]);

      expect(withUploadingOverlay).toBe(baseline);
      expect(withUpdatedProgress).toBe(baseline);
    });

    it('ignores a completed local upload overlay until the record value catches up', () => {
      expect(
        attachmentCollectionIdentityDigest([
          {
            id: 'ref-local-upload',
            url: 'https://example.com/local.png',
            localUploadOverlay: true,
          },
        ])
      ).toBe(attachmentCollectionIdentityDigest([]));
    });

    it('matches raw upload references with normalized IImageData identities', () => {
      const rawReferenceDigest = attachmentCollectionIdentityDigest([
        {
          reference_id: 'ref-abc',
          name: 'photo.png',
          url: 'https://cdn.example.com/photo.png',
        },
      ]);
      const normalizedDigest = attachmentCollectionIdentityDigest([
        {
          id: 'ref-abc',
          url: 'https://cdn.example.com/photo.png',
          name: 'photo.png',
          mimeType: 'image/png',
        },
      ]);

      expect(rawReferenceDigest).toBe(normalizedDigest);
    });

    it('detects real external attachment changes', () => {
      const before = attachmentCollectionIdentityDigest([
        { reference_id: 'ref-a', url: 'https://cdn.example.com/a.png' },
      ]);
      const after = attachmentCollectionIdentityDigest([
        { reference_id: 'ref-a', url: 'https://cdn.example.com/a.png' },
        { reference_id: 'ref-b', url: 'https://cdn.example.com/b.png' },
      ]);

      expect(before).not.toBe(after);
    });
  });

  describe('cellContentDigestForConflict', () => {
    const imageCell = (data: IImageCell['data']): IImageCell => ({
      type: CellType.Image,
      data,
      displayData: data.map((item) => item.url),
    });

    it('uses stable attachment identities for Image cells', () => {
      const baseline = cellContentDigestForConflict(imageCell([]));
      const duringUpload = cellContentDigestForConflict(
        imageCell([
          {
            id: 'temp-upload',
            url: '',
            uploading: true,
            uploadStatus: 'uploading',
            uploadProgress: 0.5,
          },
        ])
      );

      expect(duringUpload).toBe(baseline);
    });

    it('reflects completed local upload in digest', () => {
      const baseline = cellContentDigestForConflict(imageCell([]));
      const afterUpload = cellContentDigestForConflict(
        imageCell([
          {
            id: 'ref-abc',
            url: 'https://cdn.example.com/photo.png',
          },
        ])
      );

      expect(afterUpload).not.toBe(baseline);
    });
  });

  describe('userCollectionIdentityDigest', () => {
    it('matches user IDs with resolved objects and ignores profile refreshes', () => {
      const ids = userCollectionIdentityDigest(['user-2', 'user-1']);
      const resolvedUsers = userCollectionIdentityDigest([
        { id: 'user-1', name: 'Alice', avatar: 'before.png' },
        { user_id: 'user-2', name: 'Bob' },
      ]);
      const refreshedUsers = userCollectionIdentityDigest([
        { id: 'user-1', name: 'Alice Cooper', avatar: 'after.png' },
        { userId: 'user-2', name: 'Bob' },
      ]);

      expect(resolvedUsers).toBe(ids);
      expect(refreshedUsers).toBe(ids);
    });

    it('detects a real membership change', () => {
      expect(userCollectionIdentityDigest(['user-1'])).not.toBe(
        userCollectionIdentityDigest(['user-1', 'user-2'])
      );
    });
  });

  describe('valueDigestForConflict', () => {
    it('uses attachment identity digest for Image cell values', () => {
      const rawValue = [
        {
          reference_id: 'ref-abc',
          url: 'https://cdn.example.com/photo.png',
        },
      ];
      const normalizedData = [
        {
          id: 'ref-abc',
          url: 'https://cdn.example.com/photo.png',
        },
      ];

      expect(valueDigestForConflict(rawValue, CellType.Image)).toBe(
        valueDigestForConflict(normalizedData, CellType.Image)
      );
    });

    it('still JSON-stringifies non-attachment values', () => {
      expect(valueDigestForConflict('hello')).toBe(JSON.stringify('hello'));
    });
  });
});
