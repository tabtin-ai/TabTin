import { describe, expect, it } from 'vitest';
import {
  OssFileArtifactPayloadSchema,
  type OssFileArtifactPayload,
} from '../src/oss-file-artifact.js';
import {
  OssFileArtifactRichContentBlockSchema,
  type OssFileArtifactRichContentBlock,
} from '../src/stream-content-block.js';

const FILE_ID = '550e8400-e29b-41d4-a716-446655440000';

const pngPayload = {
  artifact_kind: 'oss_file',
  file_id: FILE_ID,
  file_type: 'png',
  filename: 'chart.png',
  url: `tabtin://resource/file/${FILE_ID}?hint=tabfiles&title=chart.png`,
  mime_type: 'image/png',
  file_size: 2048,
  access_url: 'https://cdn.example.com/agent/uploads/chart.png',
  auto_open: true,
  auto_open_token: 'abc123-xyz',
  self_check: {
    status: 'passed',
    summary: 'OSS upload succeeded; FileRecord created.',
  },
} satisfies OssFileArtifactPayload;

const block = {
  type: 'tabtin_rich_content',
  kind: 'file',
  summary: 'chart.png',
  payload: pngPayload,
} satisfies OssFileArtifactRichContentBlock;

describe('OssFileArtifactPayloadSchema', () => {
  it('accepts a valid oss_file payload', () => {
    expect(OssFileArtifactPayloadSchema.parse(pngPayload)).toEqual(pngPayload);
  });

  it('rejects local_file artifact_kind', () => {
    expect(() =>
      OssFileArtifactPayloadSchema.parse({
        ...pngPayload,
        artifact_kind: 'local_file',
      }),
    ).toThrow();
  });

  it('rejects non-uuid file_id', () => {
    expect(() =>
      OssFileArtifactPayloadSchema.parse({
        ...pngPayload,
        file_id: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('rejects non-tabtin url', () => {
    expect(() =>
      OssFileArtifactPayloadSchema.parse({
        ...pngPayload,
        url: 'https://cdn.example.com/chart.png',
      }),
    ).toThrow();
  });
});

describe('OssFileArtifactRichContentBlockSchema', () => {
  it('accepts a valid rich content block', () => {
    expect(OssFileArtifactRichContentBlockSchema.parse(block)).toEqual(block);
  });
});
