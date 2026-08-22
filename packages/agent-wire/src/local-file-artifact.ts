import { z } from 'zod';

/**
 * Local file artifact payload carried by
 * `tabtin_rich_content(kind='file')`.
 *
 * The file is resolved from the Space-bound Agent working_dir at open time.
 * The payload must not contain absolute local paths.
 *
 * 协议层不持有文件类型枚举：`file_type` / `mime_type` 只校验为非空字符串。
 * 具体支持哪些类型由生成端（agent-runtime 的 ArtifactFormatRegistry，一种
 * 类型一个文件）与展示端（前端预览能力）各自定义并独立扩展——新增类型不需
 * 要改动本协议文件。
 */
export const LocalFileArtifactSelfCheckSchema = z.object({
  status: z.enum(['passed', 'warning']),
  summary: z.string().min(1),
});

export const LocalFileArtifactPayloadSchema = z.object({
  artifact_kind: z.literal('local_file'),
  file_type: z.string().min(1),
  relative_path: z.string().min(1),
  filename: z.string().min(1),
  url: z.string().startsWith('tabtin://resource/file/'),
  mime_type: z.string().min(1),
  file_size: z.number().int().nonnegative(),
  self_check: LocalFileArtifactSelfCheckSchema,
});

export type LocalFileArtifactSelfCheck = z.infer<typeof LocalFileArtifactSelfCheckSchema>;
export type LocalFileArtifactPayload = z.infer<typeof LocalFileArtifactPayloadSchema>;
