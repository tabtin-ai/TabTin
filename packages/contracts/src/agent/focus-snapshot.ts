import { z } from 'zod';

/**
 * FocusSnapshot —— 跨端「当前焦点工作面」共享合同。
 *
 * 内层字段统一 camelCase。自动上下文只携带结构元数据（App 类型、打开的 tab、
 * 时区等），**不含文档/表格正文**，并由大小与深度上限 fail-closed。
 *
 * openTabs 项在 camel 外壳外，保留与 Electron `AppContextTab` 对齐的 snake
 * 子字段（`app_key` / `group_id` / …），便于现有 renderer → host 路径兼容。
 *
 * 长度上限与 Django `focus_snapshot` 对齐：普通字符串 512，path/url 类 2048。
 */

export const FOCUS_SNAPSHOT_LIMITS = {
  /** openTabs 数组上限 */
  MAX_OPEN_TABS: 20,
  /** 普通字符串字段上限（type / title / id 等）；与 Django MAX_STRING_LEN 对齐 */
  MAX_STRING_LENGTH: 512,
  /** path / url 类字段上限；与 Django MAX_URL_OR_PATH_LEN 对齐 */
  MAX_URL_OR_PATH_LENGTH: 2048,
  /** appMeta 嵌套深度上限（根对象深度 = 1） */
  MAX_APP_META_DEPTH: 3,
  /** appMeta 任一对象的最大键数 */
  MAX_APP_META_KEYS: 32,
  /** appMeta 任一数组的最大长度 */
  MAX_APP_META_ARRAY_LENGTH: 20,
} as const;

const BoundedString = z.string().max(FOCUS_SNAPSHOT_LIMITS.MAX_STRING_LENGTH);
const BoundedPathOrUrl = z.string().max(FOCUS_SNAPSHOT_LIMITS.MAX_URL_OR_PATH_LENGTH);

/** appMeta / tab 中按 path/url 上限校验的键（大小写不敏感）。 */
const LONG_STRING_KEYS = new Set([
  'path',
  'url',
  'current_url',
  'current_browser_url',
  'current_code_project_path',
  'current_folder_path',
  'sandbox_path',
  'current_file_path',
  'current_code_file',
]);

/**
 * 正文类字段名——出现在 appMeta 中时一律拒绝（自动上下文不含正文）。
 * 大小写不敏感匹配。
 */
const FORBIDDEN_BODY_KEYS = new Set([
  'content',
  'body',
  'text',
  'markdown',
  'html',
  'plaintext',
  'document',
  'doc_content',
  'doccontent',
  'fulltext',
  'full_text',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maxStringLengthForKey(key: string): number {
  return LONG_STRING_KEYS.has(key.toLowerCase())
    ? FOCUS_SNAPSHOT_LIMITS.MAX_URL_OR_PATH_LENGTH
    : FOCUS_SNAPSHOT_LIMITS.MAX_STRING_LENGTH;
}

function assertSafeAppMetaValue(
  value: unknown,
  depth: number,
  path: string,
  keyHint = '',
): void {
  if (depth > FOCUS_SNAPSHOT_LIMITS.MAX_APP_META_DEPTH) {
    throw new Error(`appMeta nesting exceeds max depth at ${path}`);
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const maxLen = maxStringLengthForKey(keyHint);
    if (value.length > maxLen) {
      throw new Error(`appMeta string exceeds max length at ${path}`);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > FOCUS_SNAPSHOT_LIMITS.MAX_APP_META_ARRAY_LENGTH) {
      throw new Error(`appMeta array exceeds max length at ${path}`);
    }
    value.forEach((item, index) => {
      assertSafeAppMetaValue(item, depth + 1, `${path}[${index}]`);
    });
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > FOCUS_SNAPSHOT_LIMITS.MAX_APP_META_KEYS) {
      throw new Error(`appMeta object exceeds max keys at ${path}`);
    }
    for (const key of keys) {
      if (FORBIDDEN_BODY_KEYS.has(key.toLowerCase())) {
        throw new Error(`appMeta forbids body field "${key}" at ${path}`);
      }
      assertSafeAppMetaValue(value[key], depth + 1, `${path}.${key}`, key);
    }
    return;
  }
  throw new Error(`appMeta unsupported value type at ${path}`);
}

/**
 * 有界 appMeta：只允许 JSON 标量 / 浅对象 / 浅数组，拒绝正文键与过深嵌套。
 */
export const FocusAppMetaSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    try {
      assertSafeAppMetaValue(value, 1, 'appMeta');
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'invalid appMeta',
      });
    }
  });

export type FocusAppMeta = z.infer<typeof FocusAppMetaSchema>;

/**
 * FocusTab —— 打开的工作面 tab。
 *
 * 核心身份字段：type / id / title / active。
 * 其余 snake 子字段与 `packages/agent-host` AppContextTab 对齐，作兼容保留。
 * `type` 必填——缺失时 Django normalizer 会补默认或丢弃该 tab。
 */
export const FocusTabSchema = z.object({
  type: BoundedString,
  id: BoundedString.optional(),
  title: BoundedString.optional(),
  active: z.boolean().optional(),
  group_id: BoundedString.optional(),
  app_key: BoundedString.optional(),
  display_name: BoundedString.optional(),
  is_home: z.boolean().optional(),
  app_home: BoundedString.optional(),
  path: BoundedPathOrUrl.optional(),
  kind: BoundedString.optional(),
  url: BoundedPathOrUrl.optional(),
  session_id: BoundedString.optional(),
});

export type FocusTab = z.infer<typeof FocusTabSchema>;

export const WorkspaceModeSchema = z.enum([
  'conversation',
  'desktop',
  'non-space',
]);

export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/**
 * FocusSnapshot —— 发送侧 / 归一侧共享的焦点快照。
 *
 * host-only 字段（如 currentModelId）不进本合同；由宿主层自行附加。
 * 执行身份键（collaborationSpaceId 等）亦不在视觉 Focus 合同内——
 * 由 Django 服务端权威注入后经 PromptAppContextSchema.passthrough 透传。
 */
export const FocusSnapshotSchema = z.object({
  appType: BoundedString.nullable().optional(),
  appMeta: FocusAppMetaSchema.nullable().optional(),
  openTabs: z
    .array(FocusTabSchema)
    .max(FOCUS_SNAPSHOT_LIMITS.MAX_OPEN_TABS)
    .nullable()
    .optional(),
  spaceId: BoundedString.nullable().optional(),
  userTimeZone: BoundedString.nullable().optional(),
  workspaceMode: WorkspaceModeSchema.nullable().optional(),
});

export type FocusSnapshot = z.infer<typeof FocusSnapshotSchema>;
