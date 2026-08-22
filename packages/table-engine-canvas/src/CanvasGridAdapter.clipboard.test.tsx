import React, { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  TableGridClipboardPayload,
  TableGridRendererProps,
} from '@tabtin/table-engine';

let latestGridProps: Record<string, any> | null = null;

vi.mock('@tabtin/smartsheet-ui', () => ({
  resolveSelectChipColors: () => ({ backgroundColor: '#eee', color: '#111' }),
}));

vi.mock('@tabtin/table-engine', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@tabtin/table-engine')>();
  return {
    ...original,
    resolveRecordId: (row: { id?: string; __recordId?: string }) =>
      row.__recordId ?? row.id ?? null,
  };
});

vi.mock('./overlays/RecordMenu', () => ({ RecordMenu: () => null }));
vi.mock('./overlays/FieldMenu', () => ({ FieldMenu: () => null }));
vi.mock('./overlays/StatisticMenu', () => ({ StatisticMenu: () => null }));
vi.mock('./overlays/DescriptionTooltip', () => ({
  DescriptionTooltip: () => null,
}));

vi.mock('./grid/Grid', () => ({
  Grid: forwardRef(function Grid(props: Record<string, any>, ref) {
    latestGridProps = props;
    useImperativeHandle(ref, () => ({
      getActiveCell: () => [0, 4],
      getContainer: () => null,
      getScrollState: () => ({ scrollLeft: 0, scrollTop: 0 }),
      forceUpdate: () => undefined,
    }));
    return <div />;
  }),
}));

import { CanvasGridAdapter } from './CanvasGridAdapter';

describe('CanvasGridAdapter clipboard anchor', () => {
  it('分组视图粘贴应向宿主报告目标记录的展示行索引', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const payloads: TableGridClipboardPayload[] = [];
    const rows = [
      {
        id: '__group__owner',
        __rowType: 'group_header' as const,
        __groupLevel: 0,
        __groupPath: 'owner-a',
        __groupLabel: 'Owner A',
        __groupValues: { Owner: 'owner-a' },
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `record-${index + 1}`,
        Link: null,
      })),
    ];
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[{ field: 'Link', fieldId: 'f_link', type: 'url' }]}
          rows={rows}
          onClipboardPaste={(payload) => payloads.push(payload)}
        />,
      );
    });

    await act(async () => {
      latestGridProps?.onPaste?.(
        {},
        {
          preventDefault: vi.fn(),
          clipboardData: {
            files: [],
            getData: (type: string) =>
              type === 'text/plain' ? 'https://example.com' : '',
          },
        },
      );
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0].cells[0]).toMatchObject({
      rowId: 'record-5',
      rowIndex: 5,
      colIndex: 0,
      field: 'Link',
    });

    await act(async () => root.unmount());
  });

  it('附件粘贴上传进度不应写入记录历史', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const currentAttachments: unknown[] = [];
    const uploadedAttachment = {
      reference_id: 'reference-1',
      file_id: 'file-1',
      name: 'image.png',
      mime_type: 'image/png',
    };
    const onCellValueChanged = vi.fn();
    const onAttachmentUpload = vi.fn(
      async ({
        onProgress,
      }: Parameters<
        NonNullable<TableGridRendererProps['onAttachmentUpload']>
      >[0]) => {
        onProgress?.([
          {
            uploadItemId: 'upload-1',
            fileName: 'image.png',
            status: 'uploading',
            progress: 0.5,
          },
        ]);
        return [uploadedAttachment];
      },
    );
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `record-${index + 1}`,
      Attachment: currentAttachments,
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Attachment',
              fieldId: 'field-attachment',
              type: 'attachment',
            },
          ]}
          rows={rows}
          onAttachmentUpload={onAttachmentUpload}
          onCellValueChanged={onCellValueChanged}
        />,
      );
    });

    await act(async () => {
      latestGridProps?.onPaste?.(
        {},
        {
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clipboardData: {
            files: [new File(['image'], 'image.png', { type: 'image/png' })],
            getData: () => '',
          },
        },
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(onCellValueChanged).toHaveBeenCalledTimes(1);
    expect(onCellValueChanged).toHaveBeenCalledWith(
      rows[4],
      'Attachment',
      [uploadedAttachment],
      currentAttachments,
    );

    await act(async () => root.unmount());
  });

  it('附件编辑完成时不应把仅展示的上传叠层作为历史旧值', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const uploadedAttachment = {
      reference_id: 'reference-1',
      file_id: 'file-1',
      name: 'image.png',
      mime_type: 'image/png',
    };
    const onCellValueChanged = vi.fn();
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `record-${index + 1}`,
      Attachment:
        index === 4
          ? [
              {
                __local_upload_overlay: true,
                reference_id: 'reference-1',
                file_id: 'file-1',
                name: 'image.png',
                mime_type: 'image/png',
              },
            ]
          : [],
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Attachment',
              fieldId: 'field-attachment',
              type: 'attachment',
            },
          ]}
          rows={rows}
          onCellValueChanged={onCellValueChanged}
        />,
      );
    });

    await act(async () => {
      latestGridProps?.onCellEdited?.([0, 4], {
        data: [uploadedAttachment],
      });
    });

    expect(onCellValueChanged).toHaveBeenCalledWith(
      rows[4],
      'Attachment',
      [uploadedAttachment],
      null,
    );

    await act(async () => root.unmount());
  });
});
