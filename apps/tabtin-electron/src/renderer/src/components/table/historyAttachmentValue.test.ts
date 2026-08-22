import { describe, expect, it } from 'vitest';
import { sanitizeHistoryAttachmentValue } from './historyAttachmentValue';

describe('sanitizeHistoryAttachmentValue', () => {
  const uploadingAttachment = {
    __uploading: true,
    upload_status: 'uploading',
    name: 'image.png',
  };

  it('将首次新增附件的上传占位值还原为空值', () => {
    expect(
      sanitizeHistoryAttachmentValue('attachment', [uploadingAttachment]),
    ).toEqual([]);
  });

  it('保留原有正式附件，只移除新增附件的上传占位值', () => {
    const existingAttachment = {
      file_id: 'file-existing',
      name: 'existing.png',
    };

    expect(
      sanitizeHistoryAttachmentValue('attachment', [
        existingAttachment,
        uploadingAttachment,
      ]),
    ).toEqual([existingAttachment]);
  });

  it('不移除已经上传完成的本地展示叠层', () => {
    const completedAttachment = {
      file_id: 'file-completed',
      name: 'completed.png',
      __local_upload_overlay: true,
    };

    expect(
      sanitizeHistoryAttachmentValue('attachment', [completedAttachment]),
    ).toEqual([completedAttachment]);
  });

  it('不改变非附件字段中的同名业务对象', () => {
    expect(sanitizeHistoryAttachmentValue('text', uploadingAttachment)).toBe(
      uploadingAttachment,
    );
  });
});
