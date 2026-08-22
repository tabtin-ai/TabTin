import React, {
  createRef,
  forwardRef,
  useImperativeHandle,
  type PropsWithChildren,
} from 'react';
import type {
  TableGridAttachmentUploadHandler,
  TableGridRow,
} from '@tabtin/table-engine';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CellType,
  type IInnerCell,
} from '../../renderers/cell-renderer/interface';
import type { IEditorRef } from './EditorContainer';
import {
  GridAttachmentEditor,
  type AttachmentPreviewDialogRef,
  type AttachmentPreviewFile,
  type AttachmentPreviewUi,
} from './GridAttachmentEditor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function createPreviewHarness(options: {
  resolveThumbnailUrl?: (file: AttachmentPreviewFile) => Promise<string>;
} = {}) {
  let latestFiles: AttachmentPreviewFile[] = [];
  const openedFileIds: string[] = [];

  const Dialog = forwardRef<
    AttachmentPreviewDialogRef,
    { files: AttachmentPreviewFile[] }
  >(function TestPreviewDialog({ files }, ref) {
    latestFiles = files;
    useImperativeHandle(ref, () => ({
      openPreview: (fileId: string) => openedFileIds.push(fileId),
    }));
    return null;
  });

  const Provider = ({ children }: PropsWithChildren) => <>{children}</>;
  const loadPreviewUi = vi.fn(
    async (): Promise<AttachmentPreviewUi> => ({
      Dialog,
      Provider,
      resolveThumbnailUrl: options.resolveThumbnailUrl,
    }),
  );

  return {
    loadPreviewUi,
    latestFiles: () => latestFiles,
    openedFileIds,
  };
}

function renderAttachmentEditor(options: {
  rawValue: unknown;
  cellData: unknown;
  loadPreviewUi: () => Promise<AttachmentPreviewUi>;
  onChange?: (value: unknown[]) => void;
  onAttachmentUpload?: TableGridAttachmentUploadHandler<TableGridRow>;
  onDownloadAttachment?: (item: {
    url: string;
    name: string;
    fileId?: string;
    accessContext?: { fieldId?: string; recordId?: string; referenceId?: string };
  }) => void;
  rowData?: TableGridRow;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  const ref = createRef<IEditorRef>();

  act(() => {
    root.render(
      <GridAttachmentEditor
        ref={ref}
        cell={
          {
            id: 'record-1:attachment',
            type: CellType.Image,
            data: options.cellData,
            readonly: false,
          } as IInnerCell
        }
        rect={{
          x: 0,
          y: 0,
          width: 420,
          height: 300,
          editorId: 'attachment-editor',
        }}
        theme={{} as any}
        isEditing
        setEditing={vi.fn()}
        rowData={options.rowData ?? { id: 'record-1' }}
        field="截图"
        fieldId="field-1"
        rawValue={options.rawValue}
        loadPreviewUi={options.loadPreviewUi}
        onChange={options.onChange}
        onAttachmentUpload={options.onAttachmentUpload}
        onDownloadAttachment={options.onDownloadAttachment}
      />,
    );
  });

  return { container, ref };
}

async function openAttachment(container: HTMLDivElement, name: string) {
  const button = container.querySelector(
    `button[aria-label="${name}"]`,
  ) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('GridAttachmentEditor private attachment identity', () => {
  it('opens and downloads a file-id-only private attachment', async () => {
    const fileId = 'd65f44a3-2f2d-42a4-9899-84e99a46d021';
    const preview = createPreviewHarness();
    const onDownloadAttachment = vi.fn();
    const { container } = renderAttachmentEditor({
      rawValue: [{
        file_id: fileId,
        name: 'private.pdf',
        mime_type: 'application/pdf',
        url: '',
      }],
      cellData: [],
      loadPreviewUi: preview.loadPreviewUi,
      onDownloadAttachment,
      rowData: { id: 'business-field-value', __recordId: 'record-1' },
    });

    await openAttachment(container, 'private.pdf');
    expect(preview.openedFileIds).toEqual([fileId]);

    const download = container.querySelector(
      'button[aria-label="download-private.pdf"]',
    ) as HTMLButtonElement;
    act(() => download.click());
    expect(onDownloadAttachment).toHaveBeenCalledWith({
      url: '',
      name: 'private.pdf',
      fileId,
      accessContext: {
        fieldId: 'field-1',
        recordId: 'record-1',
        referenceId: undefined,
      },
    });
    expect(preview.latestFiles()[0]?.accessContext).toEqual({
      fieldId: 'field-1',
      recordId: 'record-1',
      referenceId: undefined,
    });
  });

  it('resolves a private image URL before rendering its thumbnail', async () => {
    const fileId = '802cf8e7-08fc-4619-9145-a37b201fb877';
    const privateUrl =
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=feishu_import%2Forg%2Ftable%2Fprivate.jpeg';
    const resolvedUrl = 'blob:tabdata-private-thumbnail';
    const resolveThumbnailUrl = vi.fn(async () => resolvedUrl);
    const preview = createPreviewHarness({ resolveThumbnailUrl });
    const { container } = renderAttachmentEditor({
      rawValue: [
        {
          file_id: fileId,
          name: 'private.jpeg',
          mime_type: 'image/jpeg',
          url: privateUrl,
        },
      ],
      cellData: [],
      loadPreviewUi: preview.loadPreviewUi,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveThumbnailUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        assetFileId: fileId,
        src: privateUrl,
        name: 'private.jpeg',
        mimetype: 'image/jpeg',
      }),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(resolvedUrl);
  });

  it('falls back to the existing image URL when thumbnail signing fails', async () => {
    const fileId = 'c7d27fd6-1807-44e3-af4e-0179e8041b43';
    const existingUrl =
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=feishu_import%2Ftable%2Flink.png';
    const resolveThumbnailUrl = vi.fn(async () => {
      throw new Error('HTTP 405');
    });
    const preview = createPreviewHarness({ resolveThumbnailUrl });
    const { container } = renderAttachmentEditor({
      rawValue: [
        {
          file_id: fileId,
          name: 'link.png',
          mime_type: 'image/png',
          url: existingUrl,
        },
      ],
      cellData: [],
      loadPreviewUi: preview.loadPreviewUi,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveThumbnailUrl).toHaveBeenCalled();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(existingUrl);
  });

  it('recognizes an uploaded image by file name when storage reports a generic MIME type', async () => {
    const fileId = '0e7768ba-250a-45c1-b588-d3a711c8d439';
    const privateUrl =
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=tabdata%2Forg%2Ftable%2Fimage.jpg&method=GET';
    const resolvedUrl = 'blob:tabdata-uploaded-image';
    const resolveThumbnailUrl = vi.fn(async () => resolvedUrl);
    const preview = createPreviewHarness({ resolveThumbnailUrl });
    const { container } = renderAttachmentEditor({
      rawValue: [
        {
          file_id: fileId,
          name: 'image.jpg',
          mime_type: 'application/octet-stream',
          url: privateUrl,
        },
      ],
      cellData: [],
      loadPreviewUi: preview.loadPreviewUi,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveThumbnailUrl).toHaveBeenCalled();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(resolvedUrl);
  });

  it('does not replace raw file_id with the thumbnail-only cell DTO', async () => {
    const fileId = '802cf8e7-08fc-4619-9145-a37b201fb877';
    const url =
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=feishu_import%2Forg%2Ftable%2Fsubrecord.jpeg';
    const rawAttachment = {
      file_id: fileId,
      reference_id: null,
      name: 'subrecord.jpeg',
      mime_type: 'image/jpeg',
      url,
    };
    const displayAttachment = {
      id: fileId,
      name: 'subrecord.jpeg',
      mimeType: 'image/jpeg',
      url,
      uploading: false,
    };
    const preview = createPreviewHarness();
    const { container, ref } = renderAttachmentEditor({
      rawValue: [rawAttachment],
      cellData: [displayAttachment],
      loadPreviewUi: preview.loadPreviewUi,
    });

    act(() => ref.current?.setValue?.([displayAttachment]));
    await openAttachment(container, 'subrecord.jpeg');

    expect(preview.latestFiles()).toHaveLength(1);
    expect(preview.latestFiles()[0]).toMatchObject({
      fileId,
      assetFileId: fileId,
    });
  });

  it('recovers file_id from a persisted legacy Feishu attachment id', async () => {
    const fileId = '8d5782f4-90c3-4262-ab69-abf365389713';
    const legacyAttachment = {
      id: fileId,
      name: 'lookup.jpeg',
      mimeType: 'image/jpeg',
      url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=feishu_import%2Forg%2Ftable%2Flookup.jpeg',
      uploading: false,
    };
    const preview = createPreviewHarness();
    const { container } = renderAttachmentEditor({
      rawValue: [legacyAttachment],
      cellData: [legacyAttachment],
      loadPreviewUi: preview.loadPreviewUi,
    });

    await openAttachment(container, 'lookup.jpeg');

    expect(preview.latestFiles()[0]).toMatchObject({
      fileId,
      assetFileId: fileId,
    });
  });

  it('writes a recovered file_id when a legacy cell is edited again', async () => {
    const fileId = '8d5782f4-90c3-4262-ab69-abf365389713';
    const legacyAttachment = {
      id: fileId,
      name: 'lookup.jpeg',
      mimeType: 'image/jpeg',
      url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=feishu_import%2Forg%2Ftable%2Flookup.jpeg',
      uploading: false,
    };
    const uploadedAttachment = {
      file_id: 'cc504c66-b4e2-4aaf-a5fc-86fbf474f6d4',
      name: 'new.jpeg',
      mime_type: 'image/jpeg',
      url: '',
    };
    const onChange = vi.fn();
    const preview = createPreviewHarness();
    const { container } = renderAttachmentEditor({
      rawValue: [legacyAttachment],
      cellData: [legacyAttachment],
      loadPreviewUi: preview.loadPreviewUi,
      onChange,
      onAttachmentUpload: vi.fn(async () => [uploadedAttachment]),
    });
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['new'], 'new.jpeg', { type: 'image/jpeg' })],
    });

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: fileId, file_id: fileId }),
      uploadedAttachment,
    ]);
  });

  it('does not persist local upload overlay provenance when the cell is edited again', async () => {
    const completedLocalOverlay = {
      file_id: 'f8702ae2-7085-4fc8-b028-711b8da0d24c',
      name: 'completed.jpeg',
      mime_type: 'image/jpeg',
      url: '',
      __local_upload_overlay: true,
      localUploadOverlay: true,
    };
    const uploadedAttachment = {
      file_id: '5701982b-6e69-45b4-8f33-ce02a77d32f6',
      name: 'next.jpeg',
      mime_type: 'image/jpeg',
      url: '',
    };
    const onChange = vi.fn();
    const preview = createPreviewHarness();
    const { container } = renderAttachmentEditor({
      rawValue: [completedLocalOverlay],
      cellData: [completedLocalOverlay],
      loadPreviewUi: preview.loadPreviewUi,
      onChange,
      onAttachmentUpload: vi.fn(async () => [uploadedAttachment]),
    });
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['next'], 'next.jpeg', { type: 'image/jpeg' })],
    });

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith([
      {
        file_id: completedLocalOverlay.file_id,
        name: completedLocalOverlay.name,
        mime_type: completedLocalOverlay.mime_type,
        url: '',
      },
      uploadedAttachment,
    ]);
  });
});
