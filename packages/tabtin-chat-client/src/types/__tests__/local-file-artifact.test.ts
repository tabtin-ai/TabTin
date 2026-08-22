import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  LocalFileArtifactPayload,
  LocalFileArtifactRichContentBlock,
} from '../message';

const payload = {
  artifact_kind: 'local_file',
  file_type: 'xlsx',
  relative_path: 'artifacts/weather.xlsx',
  filename: 'weather.xlsx',
  url: 'tabtin://resource/file/artifacts%2Fweather.xlsx?hint=tabfiles',
  mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
  mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
  mime_type: 'application/pdf',
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
  mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  file_size: 24680,
  self_check: {
    status: 'passed',
    summary: 'Checked presentation container',
  },
} satisfies LocalFileArtifactPayload;

const block = {
  type: 'tabtin_rich_content',
  kind: 'file',
  summary: 'weather.xlsx',
  payload,
} satisfies LocalFileArtifactRichContentBlock;

describe('ChatMessage local file artifact shape', () => {
  it('can represent an assistant tool_artifact xlsx block without widening away fields', () => {
    const message = {
      id: '00000000-0000-4000-8000-000000000001',
      role: 'assistant',
      content: '[富内容]',
      created_at: '2026-06-22T00:00:00Z',
      message_kind: 'tool_artifact',
      agent_run_id: 'run-1',
      content_blocks_json: [block],
    } satisfies ChatMessage;

    const artifact = message.content_blocks_json[0] as LocalFileArtifactRichContentBlock;
    expect(artifact.payload.relative_path).toBe('artifacts/weather.xlsx');
    expect(artifact.payload.url).toContain('tabtin://resource/file/');
    expect(artifact.payload.self_check.status).toBe('passed');
  });

  it('can represent docx and pdf tool_artifact blocks', () => {
    const docxBlock = {
      type: 'tabtin_rich_content',
      kind: 'file',
      summary: 'report.docx',
      payload: docxPayload,
    } satisfies LocalFileArtifactRichContentBlock;
    const pdfBlock = {
      type: 'tabtin_rich_content',
      kind: 'file',
      summary: 'summary.pdf',
      payload: pdfPayload,
    } satisfies LocalFileArtifactRichContentBlock;

    expect(docxBlock.payload.file_type).toBe('docx')
    expect(docxBlock.payload.mime_type).toContain('wordprocessingml')
    expect(pdfBlock.payload.file_type).toBe('pdf')
    expect(pdfBlock.payload.mime_type).toBe('application/pdf')

    const pptxBlock = {
      type: 'tabtin_rich_content',
      kind: 'file',
      summary: 'deck.pptx',
      payload: pptxPayload,
    } satisfies LocalFileArtifactRichContentBlock;
    expect(pptxBlock.payload.file_type).toBe('pptx')
    expect(pptxBlock.payload.mime_type).toContain('presentationml')
  });
});
