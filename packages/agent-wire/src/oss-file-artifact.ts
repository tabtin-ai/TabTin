import { z } from 'zod';

import { LocalFileArtifactSelfCheckSchema } from './local-file-artifact.js';

/**
 * OSS / 云端文件交付物 payload，挂在 `tabtin_rich_content(kind='file')`。
 *
 * 与 `local_file` 对等：都是「交付物」而非 `present_to_user` 展示卡。
 * 打开时用 FileRecord UUID（`file_id`）走 OSS 预览，不依赖 working_dir。
 *
 * @see packages/agent-wire/src/local-file-artifact.ts
 * @see GitHub
 */
export const OssFileArtifactPayloadSchema = z.object({
  artifact_kind: z.literal('oss_file'),
  file_id: z.string().uuid(),
  file_type: z.string().min(1),
  filename: z.string().min(1),
  /** Space 打开契约：`tabtin://resource/file/<file_id>?hint=tabfiles` */
  url: z.string().startsWith('tabtin://resource/file/'),
  mime_type: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
  /** HTTPS 访问地址，预览可跳过二次查 FileRecord */
  access_url: z.string().min(1).optional(),
  /** 关联产生该产物的工具调用，用于过程卡与正式交付物去重。 */
  source_tool_use_id: z.string().min(1).optional(),
  auto_open: z.boolean().optional(),
  auto_open_token: z.string().optional(),
  self_check: LocalFileArtifactSelfCheckSchema.optional(),
});

export type OssFileArtifactPayload = z.infer<typeof OssFileArtifactPayloadSchema>;
