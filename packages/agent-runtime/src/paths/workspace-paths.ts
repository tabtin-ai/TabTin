/**
 * Workspace / Organization / User path layout helpers（ 硬切后 SSoT）。
 *
 * 与 `@tabtin/terminal-core/src/spacePaths.ts` 新 helper 段字节对齐；改路径
 * 规则时请同步 terminal-core 同源文件。
 *
 * ## 目标布局（宿主注入 `dataRoot` 后派生）
 *
 * ```
 * {dataRoot}/users/{userId}/
 *   ├── skills/{slug}/                     ← 个人 Skill
 *   ├── common/
 *   └── organizations/{orgId}/
 *       ├── skills/{slug}/                 ← 组织 Skill
 *       ├── plugins/                       ← Personal Plugin（挂组织，跨 workspace 共享）
 *       │   ├── registry.json
 *       │   └── installed/{pluginId}/
 *       ├── shared/
 *       └── workspaces/{workspaceId}/      ← 仅元数据（不是 Agent cwd）
 *           ├── downloads/
 *           ├── conversations/
 *           │   ├── sessions/{sessionId}/*.jsonl
 *           │   └── tool-logs/{sessionId}/*.md
 *           └── sites/{siteSlug}/
 * ```
 *
 * ## 段合法性
 *
 * `userId` / `orgId` / `workspaceId` **（硬切）起均为必填**
 * （组织与 workspace 元数据写路径）：缺段直接抛错，不再静默落到 `_unscoped/`。
 * 宿主必须在装配层解析出真实 ID 后再调用本模块。
 */

import path from 'node:path';

/** （硬切）：存储段必填，空值直接抛错（禁止 `_unscoped`）。 */
function requireSegment(value: string | undefined, label: string): string {
  if (!value || value.length === 0) {
    throw new Error(
      `workspace-paths: ${label} is required ( hard-cut — no _unscoped fallback)`,
    );
  }
  return value;
}

function requireUserId(userId: string): string {
  return requireSegment(userId, 'userId');
}

// ─── User root ───────────────────────────────────────────────────

/** `{dataRoot}/users/{userId}/` */
export function resolveUserRoot(
  dataRoot: string,
  userId: string,
): string {
  return path.join(dataRoot, 'users', requireUserId(userId));
}

/** 用户个人 Skill 目录：`.../users/{userId}/skills/` */
export function resolveUserSkillsDir(
  dataRoot: string,
  userId: string,
): string {
  return path.join(resolveUserRoot(dataRoot, userId), 'skills');
}

/** 用户个人单包 Skill 目录：`.../users/{userId}/skills/{slug}/` */
export function resolveUserSkillDir(
  dataRoot: string,
  userId: string,
  skillSlug: string,
): string {
  return path.join(resolveUserSkillsDir(dataRoot, userId), skillSlug);
}

/** 用户跨组织共享目录：`.../users/{userId}/common/` */
export function resolveUserCommonDir(
  dataRoot: string,
  userId: string,
): string {
  return path.join(resolveUserRoot(dataRoot, userId), 'common');
}

// ─── Organization ────────────────────────────────────────────────

/** `.../users/{userId}/organizations/{orgId}/` */
export function resolveOrganizationRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(
    resolveUserRoot(dataRoot, userId),
    'organizations',
    requireSegment(orgId, 'orgId'),
  );
}

/** 组织 Skill 目录：`.../organizations/{orgId}/skills/` */
export function resolveOrganizationSkillsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'skills');
}

/** 组织 Skill 单包目录：`.../organizations/{orgId}/skills/{slug}/` */
export function resolveOrganizationSkillDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  skillSlug: string,
): string {
  return path.join(
    resolveOrganizationSkillsDir(dataRoot, userId, orgId),
    skillSlug,
  );
}

/** 组织 Personal Plugin 根：`.../organizations/{orgId}/plugins/` */
export function resolveOrganizationPluginsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'plugins');
}

/** 组织 Personal Plugin registry：`.../plugins/registry.json` */
export function resolveOrganizationPluginRegistryFile(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(
    resolveOrganizationPluginsDir(dataRoot, userId, orgId),
    'registry.json',
  );
}

/** 组织 Personal Plugin 单包安装目录：`.../plugins/installed/{pluginId}/` */
export function resolveOrganizationPluginDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  pluginId: string,
): string {
  return path.join(
    resolveOrganizationPluginsDir(dataRoot, userId, orgId),
    'installed',
    pluginId,
  );
}

/** 组织共享物件目录：`.../organizations/{orgId}/shared/` */
export function resolveOrganizationSharedDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'shared');
}

// ─── Workspace 元数据 ────────────────────────────────────────────

/**
 * `.../organizations/{orgId}/workspaces/{workspaceId}/`。
 *
 * **仅承载 Agent 元数据**（downloads / conversations / sites），
 * **不是 Agent 的 shell cwd**——cwd 来自 `Workspace.working_dir` 的独立路径。
 */
export function resolveWorkspaceMetadataRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveOrganizationRoot(dataRoot, userId, orgId),
    'workspaces',
    requireSegment(workspaceId, 'workspaceId'),
  );
}

/** `.../workspaces/{workspaceId}/downloads/` */
export function resolveWorkspaceDownloadsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'downloads',
  );
}

/** `.../workspaces/{workspaceId}/conversations/` */
export function resolveWorkspaceConversationsRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'conversations',
  );
}

/**
 * Session archive 目录：`.../conversations/sessions/`；具体 JSONL 落
 * `{archive}/{sessionId}/{messages|snapshots|events}.jsonl`。
 */
export function resolveWorkspaceSessionArchiveDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceConversationsRoot(dataRoot, userId, orgId, workspaceId),
    'sessions',
  );
}

/**
 * ToolLogWriter 输出目录：`.../conversations/tool-logs/`；具体文件落
 * `{toolLogs}/{sessionId}/{tool_call_id}.md`。
 */
export function resolveWorkspaceToolLogsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceConversationsRoot(dataRoot, userId, orgId, workspaceId),
    'tool-logs',
  );
}

/** 单个 TabSite 项目目录：`.../workspaces/{workspaceId}/sites/{siteSlug}/` */
export function resolveWorkspaceSiteDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
  siteSlug: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'sites',
    siteSlug,
  );
}
