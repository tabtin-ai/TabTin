import { describe, expect, it } from 'vitest';
import {
  LocalFileArtifactPayloadSchema,
  type LocalFileArtifactPayload,
} from '../src/local-file-artifact.js';

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
import {
  LocalFileArtifactRichContentBlockSchema,
  type LocalFileArtifactRichContentBlock,
} from '../src/stream-content-block.js';

const xlsxPayload = {
  artifact_kind: 'local_file',
  file_type: 'xlsx',
  relative_path: 'artifacts/weather.xlsx',
  filename: 'weather.xlsx',
  url: 'tabtin://resource/file/artifacts%2Fweather.xlsx?hint=tabfiles',
  mime_type: MIME.xlsx,
  file_size: 12345,
  self_check: {
    status: 'passed',
    summary: 'Checked sheets, headers, and formulas',
  },
} satisfies LocalFileArtifactPayload;

const docxPayload = {
  artifact_kind: 'local_file',
  file_type: 'docx',
  relative_path: 'artifacts/report.docx',
  filename: 'report.docx',
  url: 'tabtin://resource/file/artifacts%2Freport.docx?hint=tabfiles',
  mime_type: MIME.docx,
  file_size: 54321,
  self_check: {
    status: 'passed',
    summary: 'Checked document structure',
  },
} satisfies LocalFileArtifactPayload;

const pdfPayload = {
  artifact_kind: 'local_file',
  file_type: 'pdf',
  relative_path: 'artifacts/summary.pdf',
  filename: 'summary.pdf',
  url: 'tabtin://resource/file/artifacts%2Fsummary.pdf?hint=tabfiles',
  mime_type: MIME.pdf,
  file_size: 98765,
  self_check: {
    status: 'passed',
    summary: 'Checked PDF header',
  },
} satisfies LocalFileArtifactPayload;

const pptxPayload = {
  artifact_kind: 'local_file',
  file_type: 'pptx',
  relative_path: 'artifacts/deck.pptx',
  filename: 'deck.pptx',
  url: 'tabtin://resource/file/artifacts%2Fdeck.pptx?hint=tabfiles',
  mime_type: MIME.pptx,
  file_size: 24680,
  self_check: {
    status: 'passed',
    summary: 'Checked presentation container',
  },
} satisfies LocalFileArtifactPayload;

const xlsxBlock = {
  type: 'tabtin_rich_content',
  kind: 'file',
  summary: 'weather.xlsx',
  payload: xlsxPayload,
} satisfies LocalFileArtifactRichContentBlock;

describe('local file artifact protocol', () => {
  it('accepts the xlsx local-file payload contract', () => {
    expect(LocalFileArtifactPayloadSchema.parse(xlsxPayload)).toEqual(xlsxPayload);
  });

  it('accepts docx, pdf and pptx local-file payload contracts', () => {
    expect(LocalFileArtifactPayloadSchema.parse(docxPayload)).toEqual(docxPayload);
    expect(LocalFileArtifactPayloadSchema.parse(pdfPayload)).toEqual(pdfPayload);
    expect(LocalFileArtifactPayloadSchema.parse(pptxPayload)).toEqual(pptxPayload);
  });

  it('accepts a tool_artifact tabtin_rich_content file block', () => {
    expect(LocalFileArtifactRichContentBlockSchema.parse(xlsxBlock)).toEqual(xlsxBlock);
  });

  it('accepts injected (non-builtin) file types as plain strings', () => {
    // 协议层放宽为 string：类型有效性由 agent-runtime registry 决定，schema 不再枚举校验。
    const injected = {
      ...xlsxPayload,
      file_type: 'txt',
      mime_type: 'text/plain',
    };
    expect(LocalFileArtifactPayloadSchema.parse(injected)).toEqual(injected);
  });

  it('rejects empty file_type / mime_type', () => {
    expect(() =>
      LocalFileArtifactPayloadSchema.parse({ ...xlsxPayload, file_type: '' }),
    ).toThrow();
    expect(() =>
      LocalFileArtifactPayloadSchema.parse({ ...xlsxPayload, mime_type: '' }),
    ).toThrow();
  });

});
