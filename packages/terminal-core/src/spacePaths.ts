import path from 'node:path';

const UNSCOPED_SEGMENT = '_unscoped';
const SAFE_STORAGE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;

function resolveSegment(value: string | undefined): string {
  return value && value.length > 0 ? value : UNSCOPED_SEGMENT;
}

/** （硬切）：新布局存储段必填，空值直接抛错（禁止 `_unscoped`）。 */
function requireLayoutSegment(value: string | undefined, label: string): string {
  if (!value || value.length === 0) {
    throw new Error(
      `spacePaths: ${label} is required ( hard-cut — no _unscoped fallback)`,
    );
  }
  return value;
}

function requireUserId(userId: string): string {
  return requireLayoutSegment(userId, 'userId');
}

export function isSafeStorageSegment(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (path.isAbsolute(trimmed)) return false;
  return SAFE_STORAGE_SEGMENT_RE.test(trimmed) && !trimmed.includes('..');
}

export function assertSafeStorageSegment(value: string | undefined, label: string): string {
  if (!isSafeStorageSegment(value)) {
    throw new Error(`Invalid ${label}: must be a single safe storage segment`);
  }
  return value;
}

/**
 * 诊断：session 缺 spaceId（ 硬切后**不会**再静默落 `_unscoped`，
 * 写路径会在 host / path helper 处直接失败）。调用方在识别「应当有 spaceId
 * 但缺失」时打点，便于发现：
 *   - 启动早期 `space:set-active` 未完成
 *   - setActive Promise 失败被 silently catch
 *   - 切 Space race / IPC 未透传 spaceId
 *
 * 本函数只打 warn，不改路径；真正的阻断在 createRuntime /
 * resolveWorkspace* / QueryRequest 校验。
 */
export function warnIfSessionUnscoped(
  context: {
    /**
     * Runtime 实例 UUID（来自 `AgentRuntime.getRuntimeId()` / `ToolContext.runtimeId`）。
     * §17.6 D4：本字段从 `sessionId` 改名 `runtimeId` —— 这里只做诊断日志
     * 显示（短 ID 标识），用 runtime UUID 维度比业务 thread 更精确（每次
     * createRuntime 失同步都能独立观察），不取 `threadId`。
     */
    runtimeId: string;
    spaceId: string | undefined;
    organizationId: string | undefined;
    origin: 'electron-host' | 'daemon-host' | 'cli';
  },
  logger: { warn: (msg: string) => void } = console,
): void {
  if (context.spaceId && context.spaceId.length > 0) return;
  logger.warn(
    `[spacePaths] runtime "${context.runtimeId.slice(0, 8)}…" missing spaceId ` +
      `(origin=${context.origin}, organizationId=${context.organizationId ? 'present' : 'missing'}; ` +
      ` hard-cut — write paths will reject, no _unscoped fallback). ` +
      `If origin=electron-host this indicates a space:set-active race or a missing ` +
      `QueryRequest.spaceId — the renderer must populate spaceId in the IPC payload, ` +
      `not rely on getCLISpaceId() global singleton. See ElectronAgentHost.QueryRequest.spaceId.`,
  );
}

/**
 * Space path layout SSoT (2026-05-04 重构后).
 *
 * 这些 helper 是计算每个 Space 的 **workspace 目录** 和 **platform-data 目录**
 * 的唯一入口。调用方**必须**通过这里派生路径，不得直接拼字符串。
 *
 * 物理布局（`{platformBase}` 来自 `getPlatformBaseRoot()`）：
 *
 * ```
 * {platformBase}/organizations/{organizationId}/spaces/{sp}/        ← workspace（用户文件）
 *
 * {platformBase}/platform-data/organizations/{organizationId}/spaces/{sp}/
 *     ├── skills/{slug}/
 *     ├── plugins/
 *     │   ├── registry.json
 *     │   └── installed/{pluginId}/
 *     ├── sites/{siteSlug}/
 *     ├── downloads/
 *     └── conversations/
 *         ├── sessions/{sessionId}/*.jsonl
 *         └── tool-logs/{sessionId}/*.md
 * ```
 *
 * **语义分区**：
 *   - `workspace` 只放用户内容；Agent 的 ShellCap cwd 默认指向此处。
 *   - `platform-data` 下所有子目录都是平台托管——Agent 知道路径、可以读取
 *     （查历史对话、读 skill 元数据），但**不应主动写/删/列给用户看**。
 *
 * 所有函数接受 `spacesRoot` 或 `platformDataRoot` 作参数，不直接调
 * `getSpacesRoot()` / `getPlatformDataRoot()`——这样装配层可以快照一次
 * 后把 root 传下来，避免 env 覆盖在同一 runtime 生命周期内飘移。
 */

// ─── Workspace 路径（纯用户文件）────────────────────────────────────

/**
 * Per-organization workspace 根：`{spacesRoot}/{organizationId}/spaces/`。
 *
 * 不常用，主要给 organization 级别操作（如跨 Space 扫描）。绝大多数场景直接
 * 用 `resolveSpaceWorkspaceRoot`。
 */
export function resolveOrganizationSpacesRoot(
  spacesRoot: string,
  organizationId: string | undefined,
): string {
  return path.join(spacesRoot, resolveSegment(organizationId), 'spaces');
}

/**
 * Per-Space workspace 根：`{spacesRoot}/{organizationId}/spaces/{spaceId}/`。
 *
 * **这是 Agent 的 workspaceRoot 默认值**（当用户没选项目目录作 override 时）。
 * 里面只有用户放的文件——平台子目录（skills / sites / downloads /
 * conversations）都在 platform-data 下，不会污染这里。
 */
export function resolveSpaceWorkspaceRoot(
  spacesRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveOrganizationSpacesRoot(spacesRoot, organizationId),
    resolveSegment(spaceId),
  );
}

// ─── Platform-data 路径（平台托管数据）─────────────────────────────

/**
 * Per-Space platform-data 根：
 * `{platformDataRoot}/{organizationId}/spaces/{spaceId}/`。
 *
 * 下面分 skills / sites / downloads / conversations 四类子目录。
 */
export function resolveSpacePlatformDataRoot(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    platformDataRoot,
    resolveSegment(organizationId),
    'spaces',
    resolveSegment(spaceId),
  );
}

/** Per-Space skills 根：`{.../platform-data/.../spaces/{sp}/}/skills/`。 */
export function resolveSpaceSkillsDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpacePlatformDataRoot(platformDataRoot, organizationId, spaceId),
    'skills',
  );
}

/**
 * Per-Space 单个 skill 目录：
 * `{.../skills/}/{skillSlug}/`。
 *
 * `skillSlug` 是磁盘目录名。调用方负责规范化 slug——本 helper 不校验或转换。
 */
export function resolveSpaceSkillDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
  skillSlug: string,
): string {
  return path.join(
    resolveSpaceSkillsDir(platformDataRoot, organizationId, spaceId),
    skillSlug,
  );
}

/** Per-Space Personal Plugin 根：`{.../spaces/{sp}/}/plugins/`。 */
export function resolveSpacePluginsDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpacePlatformDataRoot(platformDataRoot, organizationId, spaceId),
    'plugins',
  );
}

/** Per-Space Personal Plugin registry 文件：`{.../plugins/}/registry.json`。 */
export function resolveSpacePluginRegistryFile(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpacePluginsDir(platformDataRoot, organizationId, spaceId),
    'registry.json',
  );
}

/**
 * Per-Space 单个 Personal Plugin 安装目录：
 * `{.../plugins/installed/}/{pluginId}/`。
 *
 * `pluginId` 是磁盘目录名。调用方负责校验其为单段安全标识。
 */
export function resolveSpacePluginDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
  pluginId: string,
): string {
  return path.join(
    resolveSpacePluginsDir(platformDataRoot, organizationId, spaceId),
    'installed',
    pluginId,
  );
}

/** Per-Space downloads 目录：`{.../spaces/{sp}/}/downloads/`。 */
export function resolveSpaceDownloadsDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpacePlatformDataRoot(platformDataRoot, organizationId, spaceId),
    'downloads',
  );
}

/** Per-Space site 项目目录：`{.../spaces/{sp}/}/sites/{siteSlug}/`。 */
export function resolveSpaceSiteDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
  siteSlug: string,
): string {
  return path.join(
    resolveSpacePlatformDataRoot(platformDataRoot, organizationId, spaceId),
    'sites',
    siteSlug,
  );
}

// ─── Conversations 路径（历史 + 工具日志）──────────────────────────

/**
 * Per-Space conversations 根：`{.../spaces/{sp}/}/conversations/`。
 *
 * 下有 `sessions/` 存 JSONL 三件套，`tool-logs/` 存工具调用全文 md。
 */
export function resolveSpaceConversationsRoot(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpacePlatformDataRoot(platformDataRoot, organizationId, spaceId),
    'conversations',
  );
}

/**
 * Session archive 目录：`{conversations}/sessions/`。
 *
 * 具体文件在 `{archive}/{sessionId}/{messages|snapshots|events}.jsonl`，
 * 对应 SessionStorage / SnapshotStorage / EventStorage 的写入布局。
 */
export function resolveSpaceSessionArchiveDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpaceConversationsRoot(platformDataRoot, organizationId, spaceId),
    'sessions',
  );
}

/**
 * ToolLogWriter 输出目录：`{conversations}/tool-logs/`。
 *
 * 具体文件在 `{toolLogs}/{sessionId}/{tool_call_id}.md`。
 */
export function resolveSpaceToolLogsDir(
  platformDataRoot: string,
  organizationId: string | undefined,
  spaceId: string | undefined,
): string {
  return path.join(
    resolveSpaceConversationsRoot(platformDataRoot, organizationId, spaceId),
    'tool-logs',
  );
}

// ───  / （硬切）新 SSoT（dataRoot / users / organizations / workspaces）─
//
// 本段与 `packages/agent-runtime/src/paths/workspace-paths.ts` **字节对齐**——改
// 布局时两侧同步。
//
// 老 `resolveSpace*` 段（上方）标记 @deprecated，供未迁移调用方过渡编译；
// 新代码走本段的 `resolveWorkspace*` / `resolveOrganization*` / `resolveUser*`。
//
// ：userId / orgId / workspaceId 均为新布局必填段，缺失直接抛错
// （禁止 `_unscoped`）。旧 `resolveSpace*` 仍可用 resolveSegment 兜底，仅供迁移读。

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

/** 用户个人 Skill 单包目录：`.../users/{userId}/skills/{slug}/` */
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

/** `.../users/{userId}/organizations/{orgId}/` */
export function resolveOrganizationRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(
    resolveUserRoot(dataRoot, userId),
    'organizations',
    requireLayoutSegment(orgId, 'orgId'),
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

/**
 * `.../organizations/{orgId}/workspaces/{workspaceId}/`。**只装元数据**
 * （downloads / conversations / sites），Agent 的 shell cwd 由
 * `Workspace.working_dir` 单独解析，不在此树里。
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
    requireLayoutSegment(workspaceId, 'workspaceId'),
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

/** Session archive 目录：`.../conversations/sessions/` */
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

/** ToolLogWriter 输出目录：`.../conversations/tool-logs/` */
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
